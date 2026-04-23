import { randomUUID } from "crypto";
import {
  ComplianceResult,
  IGetComplianceCheckResponse,
  IInfrastructure,
  IInitiateTransactionRequest,
  ITransaction,
  TransactionStatus,
} from "../types";
import { TransactionStore } from "../store/transaction-store";
import { ComplianceProvidersStore } from "../store/compliance-providers-store";
import { FXProvisionStrategy } from "./fx-provision";
import axios from "axios";
import { Logger, LogLevelDesc } from "@hyperledger/cactus-common";

export default class CBDCController {
  private readonly log: Logger;

  private readonly store: TransactionStore;
  private readonly fxProvisionStrategy: FXProvisionStrategy;
  private readonly complianceProvidersStore: ComplianceProvidersStore;
  private readonly infrastructure: IInfrastructure;

  constructor(
    store: TransactionStore,
    fxProvisionStrategy: FXProvisionStrategy,
    complianceProvidersStore: ComplianceProvidersStore,
    infrastructure: IInfrastructure,
    logLevel: LogLevelDesc = "INFO",
  ) {
    this.store = store;
    this.fxProvisionStrategy = fxProvisionStrategy;
    this.complianceProvidersStore = complianceProvidersStore;
    this.infrastructure = infrastructure;
    this.log = new Logger({ label: "CBDCController", level: logLevel });
  }

  public async initiateTransaction(
    req: IInitiateTransactionRequest,
  ): Promise<void> {
    const transactionID = this.generateTransactionID();

    const transaction = {
      id: transactionID,
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

    try {
      await this.requestComplianceChecks(transactionID);
    } catch (error) {
      await this.fxProvisionStrategy.releaseLiquidity(
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

    try {
      await this.performSATPTransfer(
        transactionID,
        req.senderAddress,
        req.receiverAddress,
        req.sourceChainCode,
        req.destinationChainCode,
        req.amount,
      );
    } catch (error) {
      throw new Error("Error while performing SATP transfer for transaction", {
        cause: error,
      });
    }

    try {
      await this.fxProvisionStrategy.confirmSettlement(
        req.sourceChainCode,
        req.destinationChainCode,
        req.amount,
      );
    } catch (error) {
      this.log.error(
        `Error confirming settlement with FX provider for transaction ${transactionID}`,
        error,
      );
    }

    await this.store.update(transactionID, {
      ...transaction,
      status: TransactionStatus.COMPLETED,
    });
  }

  private async requestTransactionFXRate(
    transaction: ITransaction,
  ): Promise<void> {
    const quote = await this.fxProvisionStrategy.getFXQuoteAndLockLiquidity(
      transaction.sourceChainCode,
      transaction.destinationChainCode,
      transaction.amount,
      {
        // TODO: these limits should be defined based on the transaction details and not hardcoded
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
    );

    await this.store.update(transaction.id, {
      ...transaction,
      fxRate: quote.rate,
      status: TransactionStatus.COMPLIANCE_CHECKS,
    });
  }

  private async requestComplianceChecks(transactionId: string): Promise<void> {
    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    if (transaction.status !== TransactionStatus.COMPLIANCE_CHECKS) {
      throw new Error(
        `Cannot request compliance checks for transaction ${transactionId} in status ${transaction.status}`,
      );
    }

    const complianceProviders = await this.complianceProvidersStore.getAll();

    const results = await Promise.all(
      complianceProviders.map(async (provider) => {
        try {
          return await axios.post<IGetComplianceCheckResponse>(
            provider.endpoint,
            {
              transactionId,
              sourceChainCode: transaction.sourceChainCode,
              destinationChainCode: transaction.destinationChainCode,
              senderAddress: transaction.senderAddress,
              receiverAddress: transaction.receiverAddress,
              amount: transaction.amount,
            },
          );
        } catch (error) {
          console.error(
            `Error requesting compliance check from provider ${provider.id} for transaction ${transactionId}, skipping:`,
            error,
          );
        }
      }),
    );

    let worstResult = ComplianceResult.APPROVED;

    results.forEach((response) => {
      if (response && response.status === 200) {
        const { transactionId, result } = response.data;

        if (transactionId !== transaction.id) {
          console.warn(
            `Received compliance check response for transaction ${transactionId} but expected ${transaction.id}, skipping`,
          );
          return;
        }

        if (result === ComplianceResult.REJECTED) {
          worstResult = ComplianceResult.REJECTED;
        } else if (
          result === ComplianceResult.MARKED_FOR_REVIEW &&
          worstResult !== ComplianceResult.REJECTED
        ) {
          worstResult = ComplianceResult.MARKED_FOR_REVIEW;
        }
      }
    });
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
        amount * transaction.fxRate!,
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
      // The transfer always begins on the source chain, so we use the source chain's transaction API to execute it
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
