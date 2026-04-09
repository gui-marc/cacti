import { randomUUID } from "crypto";
import {
  ComplianceResult,
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

  constructor(
    store: TransactionStore,
    fxProvidersStore: FXProvidersStore,
    complianceProvidersStore: ComplianceProvidersStore,
  ) {
    this.store = store;
    this.fxProvidersStore = fxProvidersStore;
    this.complianceProvidersStore = complianceProvidersStore;
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
      console.error(
        `Error while requesting FX rate for transaction ${transactionID}:`,
        error,
      );
    }
  }

  public async requestTransactionFXRate(
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

  public async setTransactionFXRate(
    transactionId: string,
    sourceChainCode: string,
    destinationChainCode: string,
    fxRate: number,
  ): Promise<void> {
    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    if (transaction.status !== TransactionStatus.SETTING_FX_RATE) {
      throw new Error(
        `Cannot set FX rate for transaction ${transactionId} in status ${transaction.status}`,
      );
    }

    if (
      transaction.sourceChainCode !== sourceChainCode ||
      transaction.destinationChainCode !== destinationChainCode
    ) {
      throw new Error(
        `FX rate chain pair ${sourceChainCode}-${destinationChainCode} does not match transaction chain pair ${transaction.sourceChainCode}-${transaction.destinationChainCode}`,
      );
    }

    // Todo: how to set FX rate if multiple providers respond with different rates?
    // For now we just take the first response and ignore the rest, but in the future
    // we might want to implement some kind of voting mechanism between providers or take the average rate

    if (!transaction.fxRate) {
      await this.store.update(transactionId, {
        ...transaction,
        fxRate,
        status: TransactionStatus.COMPLIANCE_CHECKS,
      });
    }
  }

  public async requestComplianceChecks(transactionId: string): Promise<void> {
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

    // todo: encrypt and authenticate this
    await Promise.all([
      complianceProviders.map(async (provider) => {
        try {
          await axios.post(provider.endpoint, {
            transactionId,
            sourceChainCode: transaction.sourceChainCode,
            destinationChainCode: transaction.destinationChainCode,
            senderAddress: transaction.senderAddress,
            receiverAddress: transaction.receiverAddress,
            amount: transaction.amount,
          });
        } catch (error) {
          console.error(
            `Error requesting compliance check from provider ${provider.id} for transaction ${transactionId}, skipping:`,
            error,
          );
        }
      }),
    ]);
  }

  public async processComplianceCheckResult(
    transactionId: string,
    result: ComplianceResult,
  ): Promise<void> {
    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    if (transaction.status !== TransactionStatus.COMPLIANCE_CHECKS) {
      throw new Error(
        `Cannot process compliance check result for transaction ${transactionId} in status ${transaction.status}`,
      );
    }

    // For now we just take the first compliance check result and ignore the rest, but in the future
    // we might want to implement some kind of voting mechanism between providers or take the
    // most severe result (e.g. if one provider rejects the transaction, we reject it even if other providers approve it)
    await this.store.update(transactionId, {
      ...transaction,
      complianceResult: result,
      status:
        result === ComplianceResult.APPROVED
          ? TransactionStatus.EXECUTING
          : TransactionStatus.FAILED,
    });

    await this.executeTransaction(transactionId);
  }

  public async executeTransaction(transactionId: string): Promise<void> {
    const transaction = await this.store.get(transactionId);

    if (!transaction) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }

    if (transaction.status !== TransactionStatus.EXECUTING) {
      throw new Error(
        `Cannot execute transaction ${transactionId} in status ${transaction.status}`,
      );
    }

    // todo: call SATP protocol
  }

  private generateTransactionID(): string {
    return randomUUID();
  }
}
