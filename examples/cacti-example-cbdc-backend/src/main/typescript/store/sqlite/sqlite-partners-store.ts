import { Database as SqliteDb } from "better-sqlite3";
import {
  IPartner,
  PartnersStore,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";

interface Row {
  id: string;
  api_key: string;
}

export class SqlitePartnersStore extends PartnersStore {
  constructor(private readonly db: SqliteDb) {
    super();
  }

  async save(partner: IPartner): Promise<void> {
    this.validate(partner);
    this.db
      .prepare(`INSERT INTO partners (id, api_key) VALUES (?, ?)`)
      .run(partner.id, partner.apiKey);
  }

  async get(partnerId: string): Promise<IPartner | null> {
    const row = this.db
      .prepare(`SELECT id, api_key FROM partners WHERE id = ?`)
      .get(partnerId) as Row | undefined;
    return row ? { id: row.id, apiKey: row.api_key } : null;
  }

  async getAll(): Promise<IPartner[]> {
    const rows = this.db
      .prepare(`SELECT id, api_key FROM partners`)
      .all() as Row[];
    return rows.map((r) => ({ id: r.id, apiKey: r.api_key }));
  }

  async update(partnerId: string, update: IPartner): Promise<void> {
    this.validate(update);
    const result = this.db
      .prepare(`UPDATE partners SET api_key = ? WHERE id = ?`)
      .run(update.apiKey, partnerId);
    if (result.changes === 0) {
      throw new Error(`Partner with id ${partnerId} not found`);
    }
  }

  async delete(partnerId: string): Promise<void> {
    this.db.prepare(`DELETE FROM partners WHERE id = ?`).run(partnerId);
  }
}
