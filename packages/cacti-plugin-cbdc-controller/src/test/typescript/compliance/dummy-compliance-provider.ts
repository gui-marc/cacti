import cors from "cors";
import express, { type Express } from "express";
import { Server } from "http";
import { ComplianceResult } from "../../../main/typescript/types";
import {
  ComplianceSigningError,
  ISignedEnvelope,
  NonceCache,
  signResponse,
  verifyRequest,
} from "../../../main/typescript/core/compliance-signing";

interface IDummyComplianceProviderOptions {
  port: number;
  apiKey: string;
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
  private readonly apiKey: string;
  private nextCheckResponse: ComplianceResult;

  constructor(options: IDummyComplianceProviderOptions) {
    this.port = options.port;
    this.apiKey = options.apiKey;
    this.nextCheckResponse =
      options.nextCheckResponse ?? ComplianceResult.APPROVED;
  }

  public async start(): Promise<void> {
    this.app.use(express.json());
    this.app.use(cors());

    this.app.post(this.ENDPOINT, (req, res) => {
      let verified;
      try {
        verified = verifyRequest<IComplianceRequestPayload>(
          this.apiKey,
          req.body as ISignedEnvelope,
          this.nonceCache,
        );
      } catch (error) {
        const code =
          error instanceof ComplianceSigningError ? error.code : "UNKNOWN";
        res.status(401).json({ error: code });
        return;
      }

      const responsePayload = {
        transactionId: verified.payload.transactionId,
        result: this.nextCheckResponse,
      };
      res.json(signResponse(this.apiKey, verified.nonce, responsePayload));
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
