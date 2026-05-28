import { Database as SqliteDb } from "better-sqlite3";
import { ChainCode, ICustomer } from "../../types";

interface Row {
  id: string;
  tax_id: string;
  password_hash: string;
  display_name: string;
  ledger_accounts: string;
}

export class SqliteCustomersStore {
  constructor(private readonly db: SqliteDb) {}

  private rowToCustomer(row: Row): ICustomer {
    return {
      id: row.id,
      taxId: row.tax_id,
      passwordHash: row.password_hash,
      displayName: row.display_name,
      ledgerAccounts: JSON.parse(row.ledger_accounts) as Record<
        ChainCode,
        string
      >,
    };
  }

  save(customer: ICustomer): void {
    this.db
      .prepare(
        `INSERT INTO customers (id, tax_id, password_hash, display_name, ledger_accounts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        customer.id,
        customer.taxId,
        customer.passwordHash,
        customer.displayName,
        JSON.stringify(customer.ledgerAccounts),
      );
  }

  get(id: string): ICustomer | null {
    const row = this.db
      .prepare(`SELECT * FROM customers WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? this.rowToCustomer(row) : null;
  }

  getByTaxId(taxId: string): ICustomer | null {
    const row = this.db
      .prepare(`SELECT * FROM customers WHERE tax_id = ?`)
      .get(taxId) as Row | undefined;
    return row ? this.rowToCustomer(row) : null;
  }
}
