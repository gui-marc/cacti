import { IPartner } from "../types";
import { assertSecretStrength } from "../core/partner-signing";

export abstract class PartnersStore {
  abstract getAll(): Promise<IPartner[]>;
  abstract save(partner: IPartner): Promise<void>;
  abstract get(partnerId: string): Promise<IPartner | null>;
  abstract update(partnerId: string, update: IPartner): Promise<void>;
  abstract delete(partnerId: string): Promise<void>;

  protected validate(partner: IPartner): void {
    assertSecretStrength(partner.apiKey);
  }
}

export class InMemoryPartnersStore extends PartnersStore {
  private partners = new Map<string, IPartner>();

  async save(partner: IPartner): Promise<void> {
    this.validate(partner);
    this.partners.set(partner.id, partner);
  }

  async get(partnerId: string): Promise<IPartner | null> {
    return this.partners.get(partnerId) ?? null;
  }

  async getAll(): Promise<IPartner[]> {
    return Array.from(this.partners.values());
  }

  async update(partnerId: string, update: IPartner): Promise<void> {
    if (!this.partners.has(partnerId)) {
      throw new Error(`Partner with id ${partnerId} not found`);
    }
    this.validate(update);
    this.partners.set(partnerId, update);
  }

  async delete(partnerId: string): Promise<void> {
    this.partners.delete(partnerId);
  }

  async reset(): Promise<void> {
    this.partners.clear();
  }
}
