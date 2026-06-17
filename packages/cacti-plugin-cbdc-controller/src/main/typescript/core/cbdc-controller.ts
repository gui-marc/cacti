import { randomUUID } from "crypto";
import {
  ComplianceResult,
  IGetComplianceCheckResponse,
  IInfrastructure,
  IInitiateTransactionCommand,
  InitiateTransactionResult,
  ITransaction,
  TransactionStatus,
} from "../types";
import { TransactionStore } from "../store/transaction-store";
import { ComplianceEndpointsStore } from "../store/compliance-endpoints-store";
import { FXProvisionStrategy } from "./fx-provision";
import axios from "axios";
import { Logger, LogLevelDesc } from "@hyperledger/cactus-common";
import { ISignedEnvelope, PartnerSigningError } from "./partner-signing";
import { PartnerSecurityService } from "./partner-security-service";

export interface ICBDCControllerOptions {
  transactionStore: TransactionStore;
  fxProvisionStrategy: FXProvisionStrategy;
  complianceEndpointsStore: ComplianceEndpointsStore;
  partnerSecurityService: PartnerSecurityService;
  infrastructure: IInfrastructure;
  logLevel?: LogLevelDesc;
  requireHttps?: boolean;
}

export default class CBDCController {
  private readonly log: Logger;

  private readonly store: TransactionStore;
  private readonly fxProvisionStrategy: FXProvisionStrategy;
  private readonly complianceEndpointsStore: ComplianceEndpointsStore;
  private readonly partnerSecurityService: PartnerSecurityService;
  private readonly infrastructure: IInfrastructure;
  private readonly requireHttps: boolean;
  // TODO: Crash recovery mechanism to handle server restarts and ensure pending transactions are not lost
  private readonly expiryTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: ICBDCControllerOptions) {
    this.store = options.transactionStore;
    this.fxProvisionStrategy = options.fxProvisionStrategy;
    this.complianceEndpointsStore = options.complianceEndpointsStore;
    this.partnerSecurityService = options.partnerSecurityService;
    this.infrastructure = options.infrastructure;
    this.requireHttps = options.requireHttps ?? true;
    this.log = new Logger({
      label: "CBDCController",
      level: options.logLevel ?? "INFO",
    });
  }

  public async initiateTransaction(
    req: IInitiateTransactionCommand,
  ): Promise<InitiateTransactionResult> {
    const transactionID = this.generateTransactionID();

    const transaction = {
      id: transactionID,
      initiatorId: req.initiatorId,
      sourceChainCode: req.sourceChainCode,
      destinationChainCode: req.destinationChainCode,
      senderAddress: req.senderAddress,
      receiverAddress: req.receiverAddress,
      amount: req.amount,
      timeToExpire: req.timeToExpire,
      complianceProviders: req.complianceProviders,
      status: TransactionStatus.SETTING_FX_RATE,
    } satisfies ITransaction;

    try {
      await this.store.save(transaction);
    } catch (error) {
      throw new Error(`Error while saving transaction in store:`, {
        cause: error,
      });
    }

    try {
      await this.requestTransactionFXRate(transaction);
    } catch (error) {
      await this.fxProvisionStrategy.releaseLiquidity(
        transactionID,
        req.sourceChainCode,
        req.destinationChainCode,
        req.amount,
      );

      await this.store.update(transactionID, {
        ...transaction,
        status: TransactionStatus.FAILED,
      });

      throw new Error(`Error while requesting FX quote for transaction:`, {
        cause: error,
      });
    }

    const complianceResult = await this.requestComplianceChecks(transactionID);

    const persisted = await this.store.get(transactionID);
    if (!persisted) {
      throw new Error(`Transaction with id ${transactionID} not found`);
    }

    if (complianceResult === ComplianceResult.REJECTED) {
      await this.fxProvisionStrategy.releaseLiquidity(
        transactionID,
        req.sourceChainCode,
        req.destinationChainCode,
        req.amount,
      );
      await this.store.update(transactionID, {
        ...persisted,
        status: TransactionStatus.FAILED,
      });
      throw new Error(
        `Transaction ${transactionID} rejected by compliance check`,
      );
    }

    if (complianceResult === ComplianceResult.MARKED_FOR_REVIEW) {
      await this.store.update(transactionID, {
        ...persisted,
        status: TransactionStatus.MARKED_FOR_REVIEW,
      });
      this.scheduleExpiry(transactionID, persisted.timeToExpire);
      return { kind: "marked_for_review", transactionId: transactionID };
    }

    await this.executeTransfer(persisted);

    return { kind: "completed", transactionId: transactionID };
  }

  public async acceptTransaction(
    transactionId: string,
    actorId: string,
  ): Promise<void> {
    const transaction = await this.store.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }
    if (transaction.initiatorId !== actorId) {
      throw new Error(
        `Partner ${actorId} is not the initiator of transaction ${transactionId} and cannot accept it`,
      );
    }
    if (transaction.status !== TransactionStatus.MARKED_FOR_REVIEW) {
      throw new Error(
        `Cannot accept transaction ${transactionId} in status ${transaction.status}`,
      );
    }
    if (Date.now() >= transaction.timeToExpire.getTime()) {
      await this.expireTransaction(transactionId);
      throw new Error(`Transaction ${transactionId} has expired`);
    }
    this.clearExpiry(transactionId);
    await this.executeTransfer(transaction);
  }

  private scheduleExpiry(transactionId: string, timeToExpire: Date): void {
    const delayMs = timeToExpire.getTime() - Date.now();
    if (delayMs <= 0) {
      void this.expireTransaction(transactionId);
      return;
    }
    const timer = setTimeout(() => {
      void this.expireTransaction(transactionId);
    }, delayMs);
    timer.unref();
    this.expiryTimers.set(transactionId, timer);
  }

  private clearExpiry(transactionId: string): void {
    const timer = this.expiryTimers.get(transactionId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(transactionId);
    }
  }

  private async expireTransaction(transactionId: string): Promise<void> {
    this.clearExpiry(transactionId);
    const transaction = await this.store.get(transactionId);
    if (!transaction) {
      return;
    }
    if (transaction.status !== TransactionStatus.MARKED_FOR_REVIEW) {
      return;
    }
    try {
      await this.fxProvisionStrategy.releaseLiquidity(
        transactionId,
        transaction.sourceChainCode,
        transaction.destinationChainCode,
        transaction.amount,
      );
    } catch (error) {
      this.log.error(
        `Error releasing liquidity for expired transaction ${transactionId}`,
        error,
      );
    }
    await this.store.update(transactionId, {
      ...transaction,
      status: TransactionStatus.EXPIRED,
    });
    this.log.info(`Transaction ${transactionId} expired`);
  }

  private async executeTransfer(transaction: ITransaction): Promise<void> {
    try {
      await this.performSATPTransfer(
        transaction.id,
        transaction.senderAddress,
        transaction.receiverAddress,
        transaction.sourceChainCode,
        transaction.destinationChainCode,
        transaction.amount,
      );
    } catch (error) {
      throw new Error("Error while performing SATP transfer for transaction", {
        cause: error,
      });
    }

    // The off-ledger transfer above has already moved the funds, so the FX
    // settlement is obligatory: it must be driven to success, never unwound.
    // confirmSettlement is idempotent (the on-chain settle no-ops once settled),
    // so retrying is safe. If it still fails after bounded retries, persist the
    // transaction as SETTLEMENT_PENDING for a reconciler to re-drive settle —
    // do NOT mark it COMPLETED, which would falsely claim the FX leg settled.
    const settled = await this.confirmSettlementWithRetry(transaction);

    await this.store.update(transaction.id, {
      ...transaction,
      status: settled
        ? TransactionStatus.COMPLETED
        : TransactionStatus.SETTLEMENT_PENDING,
    });
  }

  private async confirmSettlementWithRetry(
    transaction: ITransaction,
  ): Promise<boolean> {
    const maxAttempts = 5;
    let backoffMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.fxProvisionStrategy.confirmSettlement(
          transaction.id,
          transaction.sourceChainCode,
          transaction.destinationChainCode,
          transaction.amount,
        );
        return true;
      } catch (error) {
        this.log.error(
          `Error confirming settlement for transaction ${transaction.id} ` +
            `(attempt ${attempt}/${maxAttempts})`,
          error,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs *= 2;
        }
      }
    }

    this.log.error(
      `Settlement still failing for transaction ${transaction.id} after ` +
        `${maxAttempts} attempts; marking SETTLEMENT_PENDING for reconciliation`,
    );
    return false;
  }

  private async requestTransactionFXRate(
    transaction: ITransaction,
  ): Promise<void> {
    const quote = await this.fxProvisionStrategy.requestFXQuote(
      transaction.id,
      transaction.sourceChainCode,
      transaction.destinationChainCode,
      transaction.amount,
      {
        // TODO: these limits should be defined based on the transaction details and not hardcoded
        min: Number.MIN_SAFE_INTEGER,
        max: Number.MAX_SAFE_INTEGER,
      },
    );

    await this.store.update(transaction.id, {
      ...transaction,
      fxRate: quote.rate,
      status: TransactionStatus.COMPLIANCE_CHECKS,
    });
  }

  private async requestComplianceChecks(
    transactionId: string,
  ): Promise<ComplianceResult> {
    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    if (transaction.status !== TransactionStatus.COMPLIANCE_CHECKS) {
      throw new Error(
        `Cannot request compliance checks for transaction ${transactionId} in status ${transaction.status}`,
      );
    }

    const results = await Promise.all(
      transaction.complianceProviders.map((endpointId) =>
        this.callComplianceEndpoint(endpointId, transaction),
      ),
    );

    let worstResult = ComplianceResult.APPROVED;
    for (const result of results) {
      if (result === ComplianceResult.REJECTED) {
        worstResult = ComplianceResult.REJECTED;
      } else if (
        result === ComplianceResult.MARKED_FOR_REVIEW &&
        worstResult !== ComplianceResult.REJECTED
      ) {
        worstResult = ComplianceResult.MARKED_FOR_REVIEW;
      }
    }

    await this.store.update(transactionId, {
      ...transaction,
      complianceResult: worstResult,
    });

    return worstResult;
  }

  private async callComplianceEndpoint(
    endpointId: string,
    transaction: ITransaction,
  ): Promise<ComplianceResult | undefined> {
    const endpoint = await this.complianceEndpointsStore.get(endpointId);
    if (!endpoint) {
      this.log.warn(
        `Compliance endpoint with id ${endpointId} not found, skipping`,
      );
      return undefined;
    }

    if (this.requireHttps && !endpoint.url.startsWith("https://")) {
      this.log.error(
        `Refusing to call compliance endpoint ${endpoint.id}: url ${endpoint.url} is not https (requireHttps=true). Counting as REJECTED.`,
      );
      return ComplianceResult.REJECTED;
    }

    const payload = {
      transactionId: transaction.id,
      sourceChainCode: transaction.sourceChainCode,
      destinationChainCode: transaction.destinationChainCode,
      senderAddress: transaction.senderAddress,
      receiverAddress: transaction.receiverAddress,
      amount: transaction.amount,
    };

    let envelope: ISignedEnvelope;
    let nonce: string;
    try {
      const signed = await this.partnerSecurityService.signOutgoingRequest(
        endpoint.partnerId,
        payload,
      );
      envelope = signed.envelope;
      nonce = signed.nonce;
    } catch (error) {
      this.log.error(
        `Cannot sign compliance request for endpoint ${endpoint.id} (partner ${endpoint.partnerId}), skipping:`,
        error,
      );
      return undefined;
    }

    let responseEnvelope: ISignedEnvelope;
    try {
      const httpResponse = await axios.post<ISignedEnvelope>(
        endpoint.url,
        envelope,
      );
      if (httpResponse.status !== 200 || !httpResponse.data) {
        this.log.error(
          `Compliance endpoint ${endpoint.id} returned status ${httpResponse.status} for transaction ${transaction.id}, skipping`,
        );
        return undefined;
      }
      responseEnvelope = httpResponse.data;
    } catch (error) {
      this.log.error(
        `Error calling compliance endpoint ${endpoint.id} for transaction ${transaction.id}, skipping:`,
        error,
      );
      return undefined;
    }

    let verified: IGetComplianceCheckResponse;
    try {
      verified =
        await this.partnerSecurityService.verifyIncomingResponse<IGetComplianceCheckResponse>(
          endpoint.partnerId,
          nonce,
          responseEnvelope,
        );
    } catch (error) {
      const code =
        error instanceof PartnerSigningError ? error.code : "UNKNOWN";
      this.log.error(
        `SECURITY: response from compliance endpoint ${endpoint.id} for transaction ${transaction.id} failed verification (${code}). Counting as REJECTED.`,
        error,
      );
      return ComplianceResult.REJECTED;
    }

    if (verified.transactionId !== transaction.id) {
      this.log.error(
        `SECURITY: endpoint ${endpoint.id} returned response for transaction ${verified.transactionId} but expected ${transaction.id}. Counting as REJECTED.`,
      );
      return ComplianceResult.REJECTED;
    }

    return verified.result;
  }

  private async performSATPTransfer(
    transactionId: string,
    senderAddress: string,
    receiverAddress: string,
    sourceChain: string,
    destinationChain: string,
    amount: number,
  ) {
    this.log.debug("Performing SATP transfer for transaction", transactionId);

    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    const sourceEnvironment = this.infrastructure.environments[sourceChain];
    const destinationEnvironment =
      this.infrastructure.environments[destinationChain];

    if (!sourceEnvironment) {
      throw new Error(`Source chain environment ${sourceChain} not found`);
    }

    if (!destinationEnvironment) {
      throw new Error(
        `Destination chain environment ${destinationChain} not found`,
      );
    }

    this.log.debug("Getting assets from environments...");

    if (!transaction.fxRate) {
      throw new Error(`FX rate not set for transaction ${transactionId}`);
    }

    const [sourceAsset, receiverAsset] = await Promise.all([
      sourceEnvironment.getAsset(senderAddress, amount),
      destinationEnvironment.getAsset(
        receiverAddress,
        Math.floor(amount * transaction.fxRate!),
      ),
    ]);

    this.log.debug({ sourceAsset, receiverAsset });

    if (!sourceAsset) {
      throw new Error(
        `Could not get source asset for address ${senderAddress} and amount ${amount} on chain ${sourceChain}`,
      );
    }

    if (!receiverAsset) {
      throw new Error(
        `Could not get receiver asset for address ${receiverAddress} and amount ${amount} on chain ${destinationChain}`,
      );
    }

    try {
      await sourceEnvironment.transact({
        contextID: transactionId,
        receiverAsset,
        sourceAsset,
      });
    } catch (error) {
      this.log.error(
        `Error performing SATP transfer for transaction ${transactionId}`,
        error,
      );

      await this.store.update(transactionId, {
        ...((await this.store.get(transactionId)) as ITransaction),
        status: TransactionStatus.FAILED,
      });

      throw new Error(
        `Error performing SATP transfer for transaction ${transactionId}`,
        {
          cause: error,
        },
      );
    }
  }

  private generateTransactionID(): string {
    return randomUUID();
  }
}
