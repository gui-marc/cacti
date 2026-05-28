import {
  ComplianceResult,
  IGetComplianceCheckResponse,
  ISignedEnvelope,
  NonceCache,
  PARTNER_NONCE_TTL_MS,
  parseEnvelope,
  PartnerSigningError,
  signResponse,
  verifyRequest,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";

export interface CbCallerLookup {
  apiKey: string;
  id: string;
}

export class ComplianceService {
  private readonly nonceCache = new NonceCache(PARTNER_NONCE_TTL_MS);

  constructor(
    private readonly partnerId: string,
    private readonly callers: Map<string, CbCallerLookup>,
  ) {}

  handleSignedRequest(raw: unknown): ISignedEnvelope {
    const envelope = parseEnvelope(raw);
    let verified;
    try {
      verified = verifyRequest<{ transactionId: string }>(
        envelope,
        (id) => this.callers.get(id) ?? null,
        this.nonceCache,
      );
    } catch (e) {
      if (e instanceof PartnerSigningError) {
        throw new Error(`Invalid compliance request: ${e.code}`);
      }
      throw e;
    }

    const callerSecret = this.callers.get(verified.senderId)?.apiKey;
    if (!callerSecret) {
      throw new Error(`Unknown caller ${verified.senderId}`);
    }

    const response: IGetComplianceCheckResponse = {
      transactionId: verified.payload.transactionId,
      result: ComplianceResult.APPROVED,
    };
    return signResponse(this.partnerId, callerSecret, verified.nonce, response);
  }
}
