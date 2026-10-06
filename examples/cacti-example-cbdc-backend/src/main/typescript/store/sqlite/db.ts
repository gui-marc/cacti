import Database, { Database as SqliteDb } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDatabase(filePath: string): SqliteDb {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function applyCentralBankMigrations(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compliance_endpoints (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL,
      url TEXT NOT NULL
    );
  `);
}

export function applyPartnerMigrations(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      tax_id TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      ledger_accounts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_transactions (
      id TEXT PRIMARY KEY,
      controller_tx_id TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      source_chain TEXT NOT NULL,
      dest_chain TEXT NOT NULL,
      sender_address TEXT NOT NULL DEFAULT '',
      receiver_address TEXT NOT NULL,
      amount REAL NOT NULL,
      dest_amount REAL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_partner_tx_customer ON partner_transactions(customer_id);
  `);

  // Columns added after the table first shipped; older databases lack them.
  const columns = (
    db.pragma("table_info(partner_transactions)") as { name: string }[]
  ).map((c) => c.name);
  if (!columns.includes("sender_address")) {
    db.exec(
      `ALTER TABLE partner_transactions ADD COLUMN sender_address TEXT NOT NULL DEFAULT ''`,
    );
  }
  if (!columns.includes("dest_amount")) {
    db.exec(`ALTER TABLE partner_transactions ADD COLUMN dest_amount REAL`);
  }
}
