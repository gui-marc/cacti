import { Database as SqliteDb } from "better-sqlite3";
import { ChainCode, IPartnerTransactionRecord } from "../../types";

interface Row {
  id: string;
  controller_tx_id: string;
  customer_id: string;
  source_chain: string;
  dest_chain: string;
  receiver_address: string;
  amount: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export class SqlitePartnerTransactionsStore {
  constructor(private readonly db: SqliteDb) {}

  private rowToRecord(row: Row): IPartnerTransactionRecord {
    return {
      id: row.id,
      controllerTransactionId: row.controller_tx_id,
      customerId: row.customer_id,
      sourceChainCode: row.source_chain as ChainCode,
      destinationChainCode: row.dest_chain as ChainCode,
      receiverAddress: row.receiver_address,
      amount: row.amount,
      status: row.status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  create(record: IPartnerTransactionRecord): void {
    this.db
      .prepare(
        `INSERT INTO partner_transactions
         (id, controller_tx_id, customer_id, source_chain, dest_chain, receiver_address, amount, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.controllerTransactionId,
        record.customerId,
        record.sourceChainCode,
        record.destinationChainCode,
        record.receiverAddress,
        record.amount,
        record.status,
        record.createdAt.getTime(),
        record.updatedAt.getTime(),
      );
  }

  updateStatus(id: string, status: string): void {
    this.db
      .prepare(
        `UPDATE partner_transactions SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, Date.now(), id);
  }

  listForCustomer(customerId: string): IPartnerTransactionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM partner_transactions WHERE customer_id = ? ORDER BY created_at DESC`,
      )
      .all(customerId) as Row[];
    return rows.map((r) => this.rowToRecord(r));
  }

  get(id: string): IPartnerTransactionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM partner_transactions WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? this.rowToRecord(row) : null;
  }
}
