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
import { IRequestOptions, ISetComplianceCheckResultRequest } from "../types";

export class SetComplianceChecksEndpointV1 implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "SetComplianceChecksEndpointV1";

  private readonly log: Logger;

  private readonly options: IRequestOptions;

  public get className(): string {
    return SetComplianceChecksEndpointV1.CLASS_NAME;
  }

  constructor(options: IRequestOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(
      options.infrastructure,
      `${fnTag} arg options.infrastructure`,
    );

    const level = options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });

    this.options = options;
  }

  getVerbLowerCase(): string {
    return "post";
  }

  getPath(): string {
    return "/set-compliance-check-result";
  }

  getExpressRequestHandler(): IExpressRequestHandler {
    return this.handleRequest.bind(this);
  }

  getAuthorizationOptionsProvider(): IAsyncProvider<IEndpointAuthzOptions> {
    return {
      async get() {
        return {
          isProtected: true,
          requiredRoles: ["compliance-provider"],
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
    const body = req.body as ISetComplianceCheckResultRequest;

    const transactionId = body.transactionId;

    this.log.info(
      `Received request to set compliance check result for transaction with id ${transactionId}`,
    );

    await this.options.controller.processComplianceCheckResult(
      body.transactionId,
      body.result,
    );

    res.status(200).json({
      transactionId,
    });
  }
}
