import { Database as SqliteDb } from "better-sqlite3";
import {
  ITransaction,
  TransactionStore,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";

interface Row {
  id: string;
  data: string;
}

export class SqliteTransactionStore extends TransactionStore {
  constructor(private readonly db: SqliteDb) {
    super();
  }

  private serialize(tx: ITransaction): string {
    return JSON.stringify({ ...tx, timeToExpire: tx.timeToExpire.toISOString() });
  }

  private deserialize(json: string): ITransaction {
    const parsed = JSON.parse(json);
    return { ...parsed, timeToExpire: new Date(parsed.timeToExpire) } as ITransaction;
  }

  async save(transaction: ITransaction): Promise<void> {
    this.db
      .prepare(`INSERT INTO transactions (id, data) VALUES (?, ?)`)
      .run(transaction.id, this.serialize(transaction));
  }

  async get(transactionId: string): Promise<ITransaction | null> {
    const row = this.db
      .prepare(`SELECT id, data FROM transactions WHERE id = ?`)
      .get(transactionId) as Row | undefined;
    return row ? this.deserialize(row.data) : null;
  }

  async update(transactionId: string, update: ITransaction): Promise<void> {
    const result = this.db
      .prepare(`UPDATE transactions SET data = ? WHERE id = ?`)
      .run(this.serialize(update), transactionId);
    if (result.changes === 0) {
      throw new Error(`Transaction with id ${transactionId} not found`);
    }
  }

  async delete(transactionId: string): Promise<void> {
    this.db.prepare(`DELETE FROM transactions WHERE id = ?`).run(transactionId);
  }
}
