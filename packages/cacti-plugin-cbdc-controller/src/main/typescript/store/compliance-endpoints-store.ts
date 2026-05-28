import { IComplianceEndpoint } from "../types";

export abstract class ComplianceEndpointsStore {
  abstract getAll(): Promise<IComplianceEndpoint[]>;
  abstract save(endpoint: IComplianceEndpoint): Promise<void>;
  abstract get(endpointId: string): Promise<IComplianceEndpoint | null>;
  abstract update(
    endpointId: string,
    update: IComplianceEndpoint,
  ): Promise<void>;
  abstract delete(endpointId: string): Promise<void>;
}

export class InMemoryComplianceEndpointsStore extends ComplianceEndpointsStore {
  private endpoints = new Map<string, IComplianceEndpoint>();

  async save(endpoint: IComplianceEndpoint): Promise<void> {
    this.endpoints.set(endpoint.id, endpoint);
  }

  async get(endpointId: string): Promise<IComplianceEndpoint | null> {
    return this.endpoints.get(endpointId) ?? null;
  }

  async getAll(): Promise<IComplianceEndpoint[]> {
    return Array.from(this.endpoints.values());
  }

  async update(endpointId: string, update: IComplianceEndpoint): Promise<void> {
    if (!this.endpoints.has(endpointId)) {
      throw new Error(`Compliance endpoint with id ${endpointId} not found`);
    }
    this.endpoints.set(endpointId, update);
  }

  async delete(endpointId: string): Promise<void> {
    this.endpoints.delete(endpointId);
  }

  async reset(): Promise<void> {
    this.endpoints.clear();
  }
}
