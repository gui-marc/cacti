import { PartnersStore } from "../store/partners-store";
import {
  ISignedEnvelope,
  IVerifiedRequest,
  NonceCache,
  PartnerSigningError,
  signRequest,
  signResponse,
  verifyRequest,
  verifyResponse,
} from "./partner-signing";

export interface IPartnerSecurityServiceOptions {
  controllerId: string;
  partnersStore: PartnersStore;
  nonceCache?: NonceCache;
}

export class PartnerSecurityService {
  private readonly controllerId: string;
  private readonly partnersStore: PartnersStore;
  private readonly nonceCache: NonceCache;

  constructor(options: IPartnerSecurityServiceOptions) {
    this.controllerId = options.controllerId;
    this.partnersStore = options.partnersStore;
    this.nonceCache = options.nonceCache ?? new NonceCache();
  }

  public getControllerId(): string {
    return this.controllerId;
  }

  public async signOutgoingRequest<P>(
    partnerId: string,
    payload: P,
  ): Promise<{ envelope: ISignedEnvelope; nonce: string }> {
    const partner = await this.partnersStore.get(partnerId);
    if (!partner) {
      throw new PartnerSigningError(
        "UNKNOWN_PARTNER",
        `Unknown partner ${partnerId}`,
      );
    }
    return signRequest(this.controllerId, partner.apiKey, payload);
  }

  public async verifyIncomingResponse<P>(
    partnerId: string,
    nonce: string,
    envelope: ISignedEnvelope,
  ): Promise<P> {
    const partner = await this.partnersStore.get(partnerId);
    if (!partner) {
      throw new PartnerSigningError(
        "UNKNOWN_PARTNER",
        `Unknown partner ${partnerId}`,
      );
    }
    return verifyResponse<P>(partnerId, partner.apiKey, nonce, envelope);
  }

  public async verifyIncomingRequest<P>(
    envelope: ISignedEnvelope,
  ): Promise<IVerifiedRequest<P>> {
    // The partner lookup must be synchronous for verifyRequest; resolve it
    // up-front against the store and pass a closure.
    const partner = await this.partnersStore.get(envelope.partnerId);
    return verifyRequest<P>(
      envelope,
      () => (partner ? { apiKey: partner.apiKey } : null),
      this.nonceCache,
    );
  }

  public async signOutgoingResponse<P>(
    partnerId: string,
    requestNonce: string,
    payload: P,
  ): Promise<ISignedEnvelope> {
    const partner = await this.partnersStore.get(partnerId);
    if (!partner) {
      throw new PartnerSigningError(
        "UNKNOWN_PARTNER",
        `Unknown partner ${partnerId}`,
      );
    }
    return signResponse(
      this.controllerId,
      partner.apiKey,
      requestNonce,
      payload,
    );
  }
}
