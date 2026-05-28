import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { ChainCode, ICustomer, ISession } from "../../types";
import { SqliteCustomersStore } from "../../store/sqlite/sqlite-customers-store";
import { SqliteSessionsStore } from "../../store/sqlite/sqlite-sessions-store";

export class AuthService {
  constructor(
    private readonly customers: SqliteCustomersStore,
    private readonly sessions: SqliteSessionsStore,
    private readonly sessionTtlMs: number,
  ) {}

  async login(taxId: string, password: string): Promise<{ customer: ICustomer; session: ISession } | null> {
    const customer = this.customers.getByTaxId(taxId);
    if (!customer) return null;
    const ok = await bcrypt.compare(password, customer.passwordHash);
    if (!ok) return null;
    const session: ISession = {
      id: randomUUID(),
      customerId: customer.id,
      expiresAt: new Date(Date.now() + this.sessionTtlMs),
    };
    this.sessions.create(session);
    return { customer, session };
  }

  async register(
    taxId: string,
    password: string,
    displayName: string,
    ledgerAccounts: Record<ChainCode, string>,
  ): Promise<{ customer: ICustomer; session: ISession } | null> {
    if (this.customers.getByTaxId(taxId)) return null;
    const passwordHash = await bcrypt.hash(password, 10);
    const customer: ICustomer = {
      id: randomUUID(),
      taxId,
      passwordHash,
      displayName,
      ledgerAccounts,
    };
    this.customers.save(customer);
    const session: ISession = {
      id: randomUUID(),
      customerId: customer.id,
      expiresAt: new Date(Date.now() + this.sessionTtlMs),
    };
    this.sessions.create(session);
    return { customer, session };
  }

  resolve(sessionId: string): ICustomer | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt.getTime() < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return this.customers.get(session.customerId);
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
