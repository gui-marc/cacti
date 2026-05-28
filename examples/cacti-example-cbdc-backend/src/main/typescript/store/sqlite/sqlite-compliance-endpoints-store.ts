import { Database as SqliteDb } from "better-sqlite3";
import {
  ComplianceEndpointsStore,
  IComplianceEndpoint,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";

interface Row {
  id: string;
  partner_id: string;
  url: string;
}

export class SqliteComplianceEndpointsStore extends ComplianceEndpointsStore {
  constructor(private readonly db: SqliteDb) {
    super();
  }

  async save(endpoint: IComplianceEndpoint): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO compliance_endpoints (id, partner_id, url) VALUES (?, ?, ?)`,
      )
      .run(endpoint.id, endpoint.partnerId, endpoint.url);
  }

  async get(endpointId: string): Promise<IComplianceEndpoint | null> {
    const row = this.db
      .prepare(
        `SELECT id, partner_id, url FROM compliance_endpoints WHERE id = ?`,
      )
      .get(endpointId) as Row | undefined;
    return row
      ? { id: row.id, partnerId: row.partner_id, url: row.url }
      : null;
  }

  async getAll(): Promise<IComplianceEndpoint[]> {
    const rows = this.db
      .prepare(`SELECT id, partner_id, url FROM compliance_endpoints`)
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      partnerId: r.partner_id,
      url: r.url,
    }));
  }

  async update(
    endpointId: string,
    update: IComplianceEndpoint,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE compliance_endpoints SET partner_id = ?, url = ? WHERE id = ?`,
      )
      .run(update.partnerId, update.url, endpointId);
    if (result.changes === 0) {
      throw new Error(`Compliance endpoint with id ${endpointId} not found`);
    }
  }

  async delete(endpointId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM compliance_endpoints WHERE id = ?`)
      .run(endpointId);
  }
}
