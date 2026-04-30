import cors from "cors";
import express, { type Express } from "express";
import { ComplianceResult } from "../../../main/typescript/types";
import { Server } from "http";

interface IDummyComplianceProviderOptions {
  port: number;
  nextCheckResponse?: ComplianceResult;
}
export class DummyComplianceProvider {
  private readonly ENDPOINT = "/compliance-check";

  private server!: Server;
  private readonly app: Express = express();

  private readonly port: number;
  private nextCheckResponse: ComplianceResult;

  constructor(options: IDummyComplianceProviderOptions) {
    this.port = options.port;
    this.nextCheckResponse =
      options.nextCheckResponse ?? ComplianceResult.APPROVED;
  }

  public async start(): Promise<void> {
    this.app.use(express.json());
    this.app.use(cors());

    this.app.post(this.ENDPOINT, (req, res) => {
      res.json({
        transactionId: req.body.transactionId,
        result: this.nextCheckResponse,
      });
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
