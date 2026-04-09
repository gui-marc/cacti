import { ITransaction } from "../types";

export abstract class TransactionStore {
  abstract save(transaction: ITransaction): Promise<void>;
  abstract get(transactionId: string): Promise<ITransaction | null>;
  abstract update(transactionId: string, update: ITransaction): Promise<void>;
  abstract delete(transactionId: string): Promise<void>;
}

export class InMemoryTransactionStore extends TransactionStore {
  private transactions: Map<string, ITransaction>;

  constructor() {
    super();
    this.transactions = new Map<string, ITransaction>();
  }

  async save(transaction: ITransaction): Promise<void> {
    this.transactions.set(transaction.id, transaction);
  }

  async get(transactionId: string): Promise<ITransaction | null> {
    return this.transactions.get(transactionId) || null;
  }

  async update(transactionId: string, update: ITransaction): Promise<void> {
    if (!this.transactions.has(transactionId)) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }
    this.transactions.set(transactionId, update);
  }

  async delete(transactionId: string): Promise<void> {
    this.transactions.delete(transactionId);
  }
}
