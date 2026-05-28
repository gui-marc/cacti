import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const COMPLIANCE_SIGNING_VERSION = "v1";
export const COMPLIANCE_SECRET_MIN_BYTES = 32;
export const COMPLIANCE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const COMPLIANCE_NONCE_TTL_MS = COMPLIANCE_TIMESTAMP_WINDOW_MS + 60_000;

export interface ISignedEnvelope {
  signed: string;
  sig: string;
}

export function generateComplianceProviderSecret(): string {
  return randomBytes(COMPLIANCE_SECRET_MIN_BYTES).toString("base64url");
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

function decodedByteLength(secret: string): number {
  // Accept the secret as either base64url or raw UTF-8; report the larger of
  // the two so a 32-byte raw string isn't rejected for failing base64 decode.
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
  if (decodedByteLength(secret) < COMPLIANCE_SECRET_MIN_BYTES) {
    throw new Error(
      `Compliance provider secret must be at least ${COMPLIANCE_SECRET_MIN_BYTES} bytes; use generateComplianceProviderSecret() to mint one`,
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

function requestCanonical(ts: number, nonce: string, payloadJson: string): string {
  return `${COMPLIANCE_SIGNING_VERSION}.${ts}.${nonce}.${payloadJson}`;
}

function responseCanonical(requestNonce: string, payloadJson: string): string {
  return `${COMPLIANCE_SIGNING_VERSION}.${requestNonce}.${payloadJson}`;
}

export interface ISignedRequest<P> {
  envelope: ISignedEnvelope;
  nonce: string;
}

export function signRequest<P>(
  secret: string,
  payload: P,
  nowMs: number = Date.now(),
): ISignedRequest<P> {
  const nonce = generateNonce();
  const payloadJson = JSON.stringify(payload);
  const canonical = requestCanonical(nowMs, nonce, payloadJson);
  const signed = Buffer.from(canonical, "utf8").toString("base64");
  return {
    envelope: { signed, sig: hmac(secret, canonical) },
    nonce,
  };
}

export interface IVerifiedRequest<P> {
  payload: P;
  nonce: string;
  ts: number;
}

export class ComplianceSigningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ComplianceSigningError";
  }
}

export function verifyRequest<P>(
  secret: string,
  envelope: ISignedEnvelope,
  nonceCache: NonceCache,
  nowMs: number = Date.now(),
): IVerifiedRequest<P> {
  if (!envelope || typeof envelope.signed !== "string" || typeof envelope.sig !== "string") {
    throw new ComplianceSigningError("MALFORMED", "Envelope is missing signed or sig");
  }

  const canonical = Buffer.from(envelope.signed, "base64").toString("utf8");
  const expected = hmac(secret, canonical);
  if (!constantTimeEqual(expected, envelope.sig)) {
    throw new ComplianceSigningError("BAD_SIGNATURE", "Signature does not verify");
  }

  const parts = canonical.split(".");
  if (parts.length < 4 || parts[0] !== COMPLIANCE_SIGNING_VERSION) {
    throw new ComplianceSigningError("BAD_FORMAT", "Canonical bytes are not in v1 format");
  }
  const ts = Number(parts[1]);
  const nonce = parts[2];
  const payloadJson = parts.slice(3).join(".");

  if (!Number.isFinite(ts)) {
    throw new ComplianceSigningError("BAD_FORMAT", "Timestamp is not a number");
  }
  if (Math.abs(nowMs - ts) > COMPLIANCE_TIMESTAMP_WINDOW_MS) {
    throw new ComplianceSigningError(
      "STALE_TIMESTAMP",
      `Timestamp ${ts} outside ${COMPLIANCE_TIMESTAMP_WINDOW_MS}ms window`,
    );
  }
  if (!nonceCache.tryRemember(nonce, nowMs + COMPLIANCE_NONCE_TTL_MS)) {
    throw new ComplianceSigningError("REPLAYED_NONCE", `Nonce ${nonce} already seen`);
  }

  let payload: P;
  try {
    payload = JSON.parse(payloadJson) as P;
  } catch (err) {
    throw new ComplianceSigningError("BAD_PAYLOAD", "Payload is not valid JSON");
  }

  return { payload, nonce, ts };
}

export function signResponse<P>(
  secret: string,
  requestNonce: string,
  payload: P,
): ISignedEnvelope {
  const payloadJson = JSON.stringify(payload);
  const canonical = responseCanonical(requestNonce, payloadJson);
  const signed = Buffer.from(canonical, "utf8").toString("base64");
  return { signed, sig: hmac(secret, canonical) };
}

export function verifyResponse<P>(
  secret: string,
  expectedNonce: string,
  envelope: ISignedEnvelope,
): P {
  if (!envelope || typeof envelope.signed !== "string" || typeof envelope.sig !== "string") {
    throw new ComplianceSigningError("MALFORMED", "Envelope is missing signed or sig");
  }
  const canonical = Buffer.from(envelope.signed, "base64").toString("utf8");
  const expectedSig = hmac(secret, canonical);
  if (!constantTimeEqual(expectedSig, envelope.sig)) {
    throw new ComplianceSigningError("BAD_SIGNATURE", "Response signature does not verify");
  }
  const parts = canonical.split(".");
  if (parts.length < 3 || parts[0] !== COMPLIANCE_SIGNING_VERSION) {
    throw new ComplianceSigningError("BAD_FORMAT", "Response canonical bytes are not in v1 format");
  }
  const boundNonce = parts[1];
  const payloadJson = parts.slice(2).join(".");
  if (!constantTimeEqual(boundNonce, expectedNonce)) {
    throw new ComplianceSigningError(
      "WRONG_NONCE_BINDING",
      `Response bound to nonce ${boundNonce} but expected ${expectedNonce}`,
    );
  }
  try {
    return JSON.parse(payloadJson) as P;
  } catch (err) {
    throw new ComplianceSigningError("BAD_PAYLOAD", "Response payload is not valid JSON");
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

  tryRemember(nonce: string, expiresAt: number, nowMs: number = Date.now()): boolean {
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
