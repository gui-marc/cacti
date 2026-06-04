import { randomUUID } from "node:crypto";
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
import { IAddComplianceEndpointRequest, IRequestOptions } from "../types";
import { sendSignedJson, verifyClientEnvelope } from "./envelope-verifier";

export class AddComplianceEndpointEndpointV1 implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "AddComplianceEndpointEndpointV1";

  private readonly log: Logger;
  private readonly options: IRequestOptions;

  public get className(): string {
    return AddComplianceEndpointEndpointV1.CLASS_NAME;
  }

  constructor(options: IRequestOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(
      options.complianceEndpointsStore,
      `${fnTag} arg options.complianceEndpointsStore`,
    );
    Checks.truthy(options.partnersStore, `${fnTag} arg options.partnersStore`);

    const level = options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });
    this.options = options;
  }

  getVerbLowerCase(): string {
    return "post";
  }

  getPath(): string {
    return "/compliance-endpoint";
  }

  getExpressRequestHandler(): IExpressRequestHandler {
    return this.handleRequest.bind(this);
  }

  getAuthorizationOptionsProvider(): IAsyncProvider<IEndpointAuthzOptions> {
    const requireClientAuth = this.options.requireClientAuth;
    return {
      async get() {
        return {
          isProtected: !requireClientAuth,
          requiredRoles: [],
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

    const call = await verifyClientEnvelope<IAddComplianceEndpointRequest>(
      req,
      res,
      verifierOptions,
    );
    if (!call) {
      return;
    }

    const { partnerId, url } = call.payload;

    if (!partnerId || !url) {
      res.status(400).json({
        error: "MISSING_FIELDS",
        message: "partnerId and url are required",
      });
      return;
    }

    if (this.options.requireHttps && !url.startsWith("https://")) {
      res.status(400).json({
        error: "NON_HTTPS_URL",
        message: "url must use HTTPS",
      });
      return;
    }

    const partner = await this.options.partnersStore.get(partnerId);
    if (!partner) {
      res.status(404).json({
        error: "UNKNOWN_PARTNER",
        message: `Partner ${partnerId} not found`,
      });
      return;
    }

    const id = randomUUID();
    const endpoint = { id, partnerId, url };
    await this.options.complianceEndpointsStore.save(endpoint);

    this.log.info(
      `Registered compliance endpoint id=${id} for partner ${partnerId}`,
    );

    await sendSignedJson(res, 201, endpoint, call, verifierOptions);
  }
}
