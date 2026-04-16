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
import { FXProvidersStore } from "../store/fx-providers-store";
import { ComplianceProvidersStore } from "../store/compliance-providers-store";
import axios from "axios";

export default class CBDCController {
  private readonly store: TransactionStore;
  private readonly fxProvidersStore: FXProvidersStore;
  private readonly complianceProvidersStore: ComplianceProvidersStore;
  private readonly infrastructure: IInfrastructure;

  constructor(
    store: TransactionStore,
    fxProvidersStore: FXProvidersStore,
    complianceProvidersStore: ComplianceProvidersStore,
    infrastructure: IInfrastructure,
  ) {
    this.store = store;
    this.fxProvidersStore = fxProvidersStore;
    this.complianceProvidersStore = complianceProvidersStore;
    this.infrastructure = infrastructure;
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
      status: TransactionStatus.PENDING,
    } satisfies ITransaction;

    try {
      await this.store.save(transaction);
    } catch (error) {
      throw new Error(`Error while saving transaction in store:`, {
        cause: error,
      });
    }

    try {
      await this.requestTransactionFXRate(
        req.sourceChainCode,
        req.destinationChainCode,
        transactionID,
      );
    } catch (error) {
      throw new Error("Error while requesting FX rate for transaction", {
        cause: error,
      });
    }

    try {
      await this.requestComplianceChecks(transactionID);
    } catch (error) {
      throw new Error(
        "Error while requesting compliance checks for transaction",
        {
          cause: error,
        },
      );
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

    await this.store.update(transactionID, {
      ...transaction,
      status: TransactionStatus.COMPLETED,
    });
  }

  private async requestTransactionFXRate(
    sourceChainCode: string,
    destinationChainCode: string,
    transactionId: string,
  ): Promise<void> {
    const transaction = await this.store.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    const fxProviders = await this.fxProvidersStore.getAllForChainPair(
      sourceChainCode,
      destinationChainCode,
    );

    if (fxProviders.length === 0) {
      throw new Error(
        `No FX providers found for chain pair ${sourceChainCode}-${destinationChainCode}`,
      );
    }

    await Promise.all(
      fxProviders.map(async (provider) => {
        try {
          await axios.post(provider.endpoint, {
            transactionId,
            sourceChainCode,
            destinationChainCode,
          });
        } catch (error) {
          console.error(
            `Error requesting FX rate from provider ${provider.id} for transaction ${transactionId}, skipping:`,
            error,
          );
        }
      }),
    );

    await this.store.update(transactionId, {
      ...transaction,
      status: TransactionStatus.SETTING_FX_RATE,
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

    const [sourceAsset, receiverAsset] = await Promise.all([
      sourceEnvironment.getAsset(senderAddress, amount),
      destinationEnvironment.getAsset(receiverAddress, amount),
    ]);

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

    const sourceTransactionApi = sourceEnvironment.getTransactionApi();

    try {
      // The transfer always begins on the source chain, so we use the source chain's transaction API to execute it
      await sourceTransactionApi.transact({
        contextID: transactionId,
        receiverAsset,
        sourceAsset,
      });
    } catch (error) {
      console.error(
        `Error executing SATP transaction ${transactionId} on source chain ${sourceChain}:`,
        error,
      );
    }
  }

  private generateTransactionID(): string {
    return randomUUID();
  }
}
