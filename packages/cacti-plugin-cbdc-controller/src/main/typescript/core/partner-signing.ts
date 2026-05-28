import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const PARTNER_SIGNING_VERSION = "v1";
export const PARTNER_SECRET_MIN_BYTES = 32;
export const PARTNER_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const PARTNER_NONCE_TTL_MS = PARTNER_TIMESTAMP_WINDOW_MS + 60_000;

export interface ISignedEnvelope {
  partnerId: string;
  signed: string;
  sig: string;
}

export function generatePartnerSecret(): string {
  return randomBytes(PARTNER_SECRET_MIN_BYTES).toString("base64url");
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

function decodedByteLength(secret: string): number {
  let base64Length = 0;
  try {
    base64Length = Buffer.from(secret, "base64url").length;
  } catch {
    base64Length = 0;
  }
  const utf8Length = Buffer.byteLength(secret, "utf8");
  return Math.max(base64Length, utf8Length);
}

export function assertSecretStrength(secret: string): void {
  if (decodedByteLength(secret) < PARTNER_SECRET_MIN_BYTES) {
    throw new Error(
      `Partner secret must be at least ${PARTNER_SECRET_MIN_BYTES} bytes; use generatePartnerSecret() to mint one`,
    );
  }
}

function hmac(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = new Uint8Array(Buffer.from(a, "utf8"));
  const bb = new Uint8Array(Buffer.from(b, "utf8"));
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function requestCanonical(
  senderId: string,
  ts: number,
  nonce: string,
  payloadJson: string,
): string {
  return `${PARTNER_SIGNING_VERSION}.${senderId}.${ts}.${nonce}.${payloadJson}`;
}

function responseCanonical(
  senderId: string,
  requestNonce: string,
  payloadJson: string,
): string {
  return `${PARTNER_SIGNING_VERSION}.${senderId}.${requestNonce}.${payloadJson}`;
}

export class PartnerSigningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PartnerSigningError";
  }
}

export interface ISignedRequest {
  envelope: ISignedEnvelope;
  nonce: string;
}

export function signRequest<P>(
  senderId: string,
  secret: string,
  payload: P,
  nowMs: number = Date.now(),
): ISignedRequest {
  const nonce = generateNonce();
  const payloadJson = JSON.stringify(payload);
  const canonical = requestCanonical(senderId, nowMs, nonce, payloadJson);
  const signed = Buffer.from(canonical, "utf8").toString("base64");
  return {
    envelope: { partnerId: senderId, signed, sig: hmac(secret, canonical) },
    nonce,
  };
}

export interface IVerifiedRequest<P> {
  senderId: string;
  payload: P;
  nonce: string;
  ts: number;
}

export type IPartnerLookup = (
  partnerId: string,
) => { apiKey: string } | null | undefined;

export function parseEnvelope(raw: unknown): ISignedEnvelope {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as ISignedEnvelope).partnerId !== "string" ||
    typeof (raw as ISignedEnvelope).signed !== "string" ||
    typeof (raw as ISignedEnvelope).sig !== "string"
  ) {
    throw new PartnerSigningError(
      "MALFORMED",
      "Envelope is missing partnerId, signed, or sig",
    );
  }
  return raw as ISignedEnvelope;
}

export function verifyRequest<P>(
  envelope: ISignedEnvelope,
  lookup: IPartnerLookup,
  nonceCache: NonceCache,
  nowMs: number = Date.now(),
): IVerifiedRequest<P> {
  const partner = lookup(envelope.partnerId);
  if (!partner) {
    throw new PartnerSigningError(
      "UNKNOWN_PARTNER",
      `Unknown partner ${envelope.partnerId}`,
    );
  }

  const canonical = Buffer.from(envelope.signed, "base64").toString("utf8");
  const expected = hmac(partner.apiKey, canonical);
  if (!constantTimeEqual(expected, envelope.sig)) {
    throw new PartnerSigningError(
      "BAD_SIGNATURE",
      "Request signature does not verify",
    );
  }

  const parts = canonical.split(".");
  if (parts.length < 5 || parts[0] !== PARTNER_SIGNING_VERSION) {
    throw new PartnerSigningError(
      "BAD_FORMAT",
      "Canonical bytes are not in v1 request format",
    );
  }
  const canonicalSenderId = parts[1];
  const ts = Number(parts[2]);
  const nonce = parts[3];
  const payloadJson = parts.slice(4).join(".");

  if (!constantTimeEqual(canonicalSenderId, envelope.partnerId)) {
    throw new PartnerSigningError(
      "ID_MISMATCH",
      `Envelope partnerId ${envelope.partnerId} does not match canonical senderId ${canonicalSenderId}`,
    );
  }
  if (!Number.isFinite(ts)) {
    throw new PartnerSigningError("BAD_FORMAT", "Timestamp is not a number");
  }
  if (Math.abs(nowMs - ts) > PARTNER_TIMESTAMP_WINDOW_MS) {
    throw new PartnerSigningError(
      "STALE_TIMESTAMP",
      `Timestamp ${ts} outside ${PARTNER_TIMESTAMP_WINDOW_MS}ms window`,
    );
  }
  if (!nonceCache.tryRemember(nonce, nowMs + PARTNER_NONCE_TTL_MS)) {
    throw new PartnerSigningError(
      "REPLAYED_NONCE",
      `Nonce ${nonce} already seen`,
    );
  }

  let payload: P;
  try {
    payload = JSON.parse(payloadJson) as P;
  } catch {
    throw new PartnerSigningError("BAD_PAYLOAD", "Payload is not valid JSON");
  }

  return { senderId: envelope.partnerId, payload, nonce, ts };
}

export function signResponse<P>(
  senderId: string,
  secret: string,
  requestNonce: string,
  payload: P,
): ISignedEnvelope {
  const payloadJson = JSON.stringify(payload);
  const canonical = responseCanonical(senderId, requestNonce, payloadJson);
  const signed = Buffer.from(canonical, "utf8").toString("base64");
  return { partnerId: senderId, signed, sig: hmac(secret, canonical) };
}

export function verifyResponse<P>(
  expectedSenderId: string,
  secret: string,
  expectedNonce: string,
  envelope: ISignedEnvelope,
): P {
  if (!constantTimeEqual(envelope.partnerId, expectedSenderId)) {
    throw new PartnerSigningError(
      "WRONG_RESPONDER",
      `Response partnerId ${envelope.partnerId} does not match expected ${expectedSenderId}`,
    );
  }
  const canonical = Buffer.from(envelope.signed, "base64").toString("utf8");
  const expectedSig = hmac(secret, canonical);
  if (!constantTimeEqual(expectedSig, envelope.sig)) {
    throw new PartnerSigningError(
      "BAD_SIGNATURE",
      "Response signature does not verify",
    );
  }
  const parts = canonical.split(".");
  if (parts.length < 4 || parts[0] !== PARTNER_SIGNING_VERSION) {
    throw new PartnerSigningError(
      "BAD_FORMAT",
      "Response canonical bytes are not in v1 response format",
    );
  }
  const canonicalSenderId = parts[1];
  const boundNonce = parts[2];
  const payloadJson = parts.slice(3).join(".");
  if (!constantTimeEqual(canonicalSenderId, expectedSenderId)) {
    throw new PartnerSigningError(
      "ID_MISMATCH",
      `Canonical senderId ${canonicalSenderId} does not match expected ${expectedSenderId}`,
    );
  }
  if (!constantTimeEqual(boundNonce, expectedNonce)) {
    throw new PartnerSigningError(
      "WRONG_NONCE_BINDING",
      `Response bound to nonce ${boundNonce} but expected ${expectedNonce}`,
    );
  }
  try {
    return JSON.parse(payloadJson) as P;
  } catch {
    throw new PartnerSigningError(
      "BAD_PAYLOAD",
      "Response payload is not valid JSON",
    );
  }
}

interface INonceEntry {
  expiresAt: number;
}

export class NonceCache {
  private readonly entries = new Map<string, INonceEntry>();
  private lastSweepAt = 0;
  private readonly sweepIntervalMs: number;

  constructor(sweepIntervalMs: number = 60_000) {
    this.sweepIntervalMs = sweepIntervalMs;
  }

  tryRemember(
    nonce: string,
    expiresAt: number,
    nowMs: number = Date.now(),
  ): boolean {
    this.maybeSweep(nowMs);
    const existing = this.entries.get(nonce);
    if (existing && existing.expiresAt > nowMs) {
      return false;
    }
    this.entries.set(nonce, { expiresAt });
    return true;
  }

  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = nowMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(nonce);
      }
    }
  }
}
