import { Logger } from "@hyperledger/cactus-common";
import { Request, Response } from "express";
import {
  ISignedEnvelope,
  IVerifiedRequest,
  parseEnvelope,
  PartnerSigningError,
} from "../core/partner-signing";
import { PartnerSecurityService } from "../core/partner-security-service";

export interface IEnvelopeVerifierOptions {
  partnerSecurityService: PartnerSecurityService;
  requireClientAuth: boolean;
  log: Logger;
}

export interface IVerifiedCall<P> {
  payload: P;
  partnerId: string | null;
  requestNonce: string | null;
}

export async function verifyClientEnvelope<P>(
  req: Request,
  res: Response,
  options: IEnvelopeVerifierOptions,
): Promise<IVerifiedCall<P> | null> {
  if (!options.requireClientAuth) {
    return {
      payload: req.body as P,
      partnerId: null,
      requestNonce: null,
    };
  }

  let envelope: ISignedEnvelope;
  try {
    envelope = parseEnvelope(req.body);
  } catch (error) {
    const code = error instanceof PartnerSigningError ? error.code : "UNKNOWN";
    options.log.warn(
      `SECURITY: malformed envelope on ${req.method} ${req.path}: ${code}`,
    );
    res.status(401).json({ error: code });
    return null;
  }

  let verified: IVerifiedRequest<P>;
  try {
    verified =
      await options.partnerSecurityService.verifyIncomingRequest<P>(envelope);
  } catch (error) {
    const code = error instanceof PartnerSigningError ? error.code : "UNKNOWN";
    options.log.warn(
      `SECURITY: request to ${req.method} ${req.path} from partnerId=${envelope.partnerId} failed verification: ${code}`,
    );
    res.status(401).json({ error: code });
    return null;
  }

  return {
    payload: verified.payload,
    partnerId: verified.senderId,
    requestNonce: verified.nonce,
  };
}

export async function sendSignedJson<P>(
  res: Response,
  status: number,
  payload: P,
  call: IVerifiedCall<unknown>,
  options: IEnvelopeVerifierOptions,
): Promise<void> {
  if (!options.requireClientAuth || !call.partnerId || !call.requestNonce) {
    res.status(status).json(payload);
    return;
  }
  const envelope = await options.partnerSecurityService.signOutgoingResponse(
    call.partnerId,
    call.requestNonce,
    payload,
  );
  res.status(status).json(envelope);
}
