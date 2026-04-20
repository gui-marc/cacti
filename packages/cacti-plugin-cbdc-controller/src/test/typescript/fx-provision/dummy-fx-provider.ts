import cors from "cors";
import express, { type Express } from "express";
import {
  IGetFXRateRequest,
  IGetFXRateResponse,
} from "../../../main/typescript/types";
import { Server } from "http";

interface IDummyFXProviderOptions {
  port: number;
}

export class DummyFXProvider {
  private readonly ENDPOINT = "/fx-rate";

  private readonly port: number;
  private readonly app: Express = express();
  private server!: Server;

  private nextRate: number = 1.5;

  constructor(options: IDummyFXProviderOptions) {
    this.port = options.port;
  }

  public getEndpoint(): string {
    return `http://localhost:${this.port}${this.ENDPOINT}`;
  }

  public async start(): Promise<void> {
    this.app.use(express.json());
    this.app.use(cors());

    this.app.post(this.ENDPOINT, (req, res) => {
      const body = req.body as IGetFXRateRequest;

      res.json({
        fxRate: this.nextRate,
        transactionId: body.transactionId,
      } satisfies IGetFXRateResponse);
    });

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`Dummy compliance provider listening on port ${this.port}`);
        resolve();
      });
    });
  }

  public async stop() {
    this.server.close();
  }

  public setNextRate(rate: number) {
    this.nextRate = rate;
  }
}
