import { IFXProvider } from "../types";

export abstract class FXProvidersStore {
  abstract getAllForChainPair(
    sourceChain: string,
    destinationChain: string,
  ): Promise<IFXProvider[]>;
  abstract save(provider: IFXProvider): Promise<void>;
  abstract get(providerId: string): Promise<IFXProvider | null>;
  abstract update(providerId: string, update: IFXProvider): Promise<void>;
  abstract delete(providerId: string): Promise<void>;
}

export class InMemoryFXProvidersStore extends FXProvidersStore {
  private providers: Map<string, IFXProvider>;

  constructor() {
    super();
    this.providers = new Map<string, IFXProvider>();
  }

  async save(provider: IFXProvider): Promise<void> {
    this.providers.set(provider.id, provider);
  }

  async get(providerId: string): Promise<IFXProvider | null> {
    return this.providers.get(providerId) || null;
  }

  async update(providerId: string, update: IFXProvider): Promise<void> {
    if (!this.providers.has(providerId)) {
      throw new Error(`FX provider with id ${providerId} not found`);
    }
    this.providers.set(providerId, update);
  }

  async delete(providerId: string): Promise<void> {
    this.providers.delete(providerId);
  }

  async getAllForChainPair(
    sourceChain: string,
    destinationChain: string,
  ): Promise<IFXProvider[]> {
    const result: IFXProvider[] = [];
    for (const provider of this.providers.values()) {
      if (
        provider.supportedChainPairs.some(
          (pair) =>
            pair.sourceChain === sourceChain &&
            pair.destinationChain === destinationChain,
        )
      ) {
        result.push(provider);
      }
    }
    return result;
  }
}
