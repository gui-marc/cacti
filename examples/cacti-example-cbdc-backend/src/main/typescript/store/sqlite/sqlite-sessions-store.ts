import { Database as SqliteDb } from "better-sqlite3";
import { ISession } from "../../types";

interface Row {
  id: string;
  customer_id: string;
  expires_at: number;
}

export class SqliteSessionsStore {
  constructor(private readonly db: SqliteDb) {}

  create(session: ISession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, customer_id, expires_at) VALUES (?, ?, ?)`,
      )
      .run(session.id, session.customerId, session.expiresAt.getTime());
  }

  get(id: string): ISession | null {
    const row = this.db
      .prepare(`SELECT id, customer_id, expires_at FROM sessions WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customer_id,
      expiresAt: new Date(row.expires_at),
    };
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  deleteExpired(now = Date.now()): void {
    this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  }
}
