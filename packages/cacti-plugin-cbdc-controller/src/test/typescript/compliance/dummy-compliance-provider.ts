import cors from "cors";
import express, { type Express } from "express";
import { Server } from "http";
import { ComplianceResult } from "../../../main/typescript/types";
import {
  ISignedEnvelope,
  NonceCache,
  PartnerSigningError,
  parseEnvelope,
  signResponse,
  verifyRequest,
} from "../../../main/typescript/core/partner-signing";

interface IDummyComplianceProviderOptions {
  port: number;
  partnerId: string;
  apiKey: string;
  controllerId: string;
  nextCheckResponse?: ComplianceResult;
}

interface IComplianceRequestPayload {
  transactionId: string;
  sourceChainCode: string;
  destinationChainCode: string;
  senderAddress: string;
  receiverAddress: string;
  amount: number;
}

export class DummyComplianceProvider {
  private readonly ENDPOINT = "/compliance-check";

  private server!: Server;
  private readonly app: Express = express();
  private readonly nonceCache = new NonceCache();

  private readonly port: number;
  private readonly partnerId: string;
  private readonly apiKey: string;
  private readonly controllerId: string;
  private nextCheckResponse: ComplianceResult;

  constructor(options: IDummyComplianceProviderOptions) {
    this.port = options.port;
    this.partnerId = options.partnerId;
    this.apiKey = options.apiKey;
    this.controllerId = options.controllerId;
    this.nextCheckResponse =
      options.nextCheckResponse ?? ComplianceResult.APPROVED;
  }

  public async start(): Promise<void> {
    this.app.use(express.json());
    this.app.use(cors());

    this.app.post(this.ENDPOINT, (req, res) => {
      let envelope: ISignedEnvelope;
      try {
        envelope = parseEnvelope(req.body);
      } catch (error) {
        const code =
          error instanceof PartnerSigningError ? error.code : "UNKNOWN";
        res.status(401).json({ error: code });
        return;
      }

      if (envelope.partnerId !== this.controllerId) {
        res.status(401).json({ error: "UNKNOWN_SENDER" });
        return;
      }

      let verified;
      try {
        verified = verifyRequest<IComplianceRequestPayload>(
          envelope,
          () => ({ apiKey: this.apiKey }),
          this.nonceCache,
        );
      } catch (error) {
        const code =
          error instanceof PartnerSigningError ? error.code : "UNKNOWN";
        res.status(401).json({ error: code });
        return;
      }

      const responsePayload = {
        transactionId: verified.payload.transactionId,
        result: this.nextCheckResponse,
      };
      res.json(
        signResponse(
          this.partnerId,
          this.apiKey,
          verified.nonce,
          responsePayload,
        ),
      );
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`Dummy compliance provider listening on port ${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    this.server.close();
  }

  public setNextCheckResponse(response: ComplianceResult) {
    this.nextCheckResponse = response;
  }

  public getEndpointUrl(): string {
    return `http://localhost:${this.port}${this.ENDPOINT}`;
  }
}
