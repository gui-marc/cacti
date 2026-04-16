import { IComplianceProvider } from "../types";

export abstract class ComplianceProvidersStore {
  abstract getAll(): Promise<IComplianceProvider[]>;
  abstract getByIds(providerIds: string[]): Promise<IComplianceProvider[]>;
  abstract save(provider: IComplianceProvider): Promise<void>;
  abstract get(providerId: string): Promise<IComplianceProvider | null>;
  abstract update(
    providerId: string,
    update: IComplianceProvider,
  ): Promise<void>;
  abstract delete(providerId: string): Promise<void>;
}

export class InMemoryComplianceProvidersStore extends ComplianceProvidersStore {
  private providers: Map<string, IComplianceProvider>;

  constructor() {
    super();
    this.providers = new Map<string, IComplianceProvider>();
  }

  async save(provider: IComplianceProvider): Promise<void> {
    this.providers.set(provider.id, provider);
  }

  async get(providerId: string): Promise<IComplianceProvider | null> {
    return this.providers.get(providerId) || null;
  }

  async getAll(): Promise<IComplianceProvider[]> {
    return Array.from(this.providers.values());
  }

  async getByIds(providerIds: string[]): Promise<IComplianceProvider[]> {
    return providerIds
      .map((id) => this.providers.get(id))
      .filter((p) => p !== undefined) as IComplianceProvider[];
  }

  async update(providerId: string, update: IComplianceProvider): Promise<void> {
    if (!this.providers.has(providerId)) {
      throw new Error(`Compliance provider with id ${providerId} not found`);
    }
    this.providers.set(providerId, update);
  }

  async delete(providerId: string): Promise<void> {
    this.providers.delete(providerId);
  }

  async reset(): Promise<void> {
    this.providers.clear();
  }
}
