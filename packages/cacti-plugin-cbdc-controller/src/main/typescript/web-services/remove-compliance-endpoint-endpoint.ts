import {
  Checks,
  IAsyncProvider,
  Logger,
  LoggerProvider,
} from "@hyperledger/cactus-common";
import { registerWebServiceEndpoint } from "@hyperledger/cactus-core";
import {
  IEndpointAuthzOptions,
  IExpressRequestHandler,
  IWebServiceEndpoint,
} from "@hyperledger/cactus-core-api";

import { Request, Response, type Express } from "express";
import { IRequestOptions } from "../types";
import { verifyClientEnvelope } from "./envelope-verifier";

export class RemoveComplianceEndpointEndpointV1 implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "RemoveComplianceEndpointEndpointV1";

  private readonly log: Logger;
  private readonly options: IRequestOptions;

  public get className(): string {
    return RemoveComplianceEndpointEndpointV1.CLASS_NAME;
  }

  constructor(options: IRequestOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(
      options.complianceEndpointsStore,
      `${fnTag} arg options.complianceEndpointsStore`,
    );

    const level = options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });
    this.options = options;
  }

  getVerbLowerCase(): string {
    return "delete";
  }

  getPath(): string {
    return "/compliance-endpoint/:id";
  }

  getExpressRequestHandler(): IExpressRequestHandler {
    return this.handleRequest.bind(this);
  }

  getAuthorizationOptionsProvider(): IAsyncProvider<IEndpointAuthzOptions> {
    return {
      async get() {
        return {
          isProtected: true,
          requiredRoles: ["admin"],
        };
      },
    };
  }

  public async registerExpress(
    expressApp: Express,
  ): Promise<IWebServiceEndpoint> {
    await registerWebServiceEndpoint(expressApp, this);
    return this;
  }

  public async handleRequest(req: Request, res: Response): Promise<void> {
    const reqTag = `${this.getVerbLowerCase()} - ${this.getPath()}`;
    this.log.debug(reqTag);

    const verifierOptions = {
      partnerSecurityService: this.options.partnerSecurityService,
      requireClientAuth: this.options.requireClientAuth,
      log: this.log,
    };

    const call = await verifyClientEnvelope<Record<string, never>>(
      req,
      res,
      verifierOptions,
    );
    if (!call) {
      return;
    }

    const { id } = req.params;

    if (typeof id !== "string") {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Endpoint id must be a string",
      });
      return;
    }

    const existing = await this.options.complianceEndpointsStore.get(id);
    if (!existing) {
      res.status(404).json({
        error: "NOT_FOUND",
        message: `Compliance endpoint ${id} not found`,
      });
      return;
    }

    await this.options.complianceEndpointsStore.delete(id);

    this.log.info(`Removed compliance endpoint id=${id}`);

    res.status(204).send();
  }
}
