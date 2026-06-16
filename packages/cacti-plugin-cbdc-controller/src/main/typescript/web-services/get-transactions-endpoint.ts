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
import { IInitiateTransactionRequest, IRequestOptions } from "../types";
import { sendSignedJson, verifyClientEnvelope } from "./envelope-verifier";

export class GetTransactionsEndpointV1 implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "GetTransactionsEndpointV1";

  private readonly log: Logger;

  private readonly options: IRequestOptions;

  public get className(): string {
    return GetTransactionsEndpointV1.CLASS_NAME;
  }

  constructor(options: IRequestOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(
      options.infrastructure,
      `${fnTag} arg options.infrastructure`,
    );
    Checks.truthy(
      options.partnerSecurityService,
      `${fnTag} arg options.partnerSecurityService`,
    );

    const level = options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });

    this.options = options;
  }

  getVerbLowerCase(): string {
    return "get";
  }

  getPath(): string {
    return "/transactions";
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

    const call = await verifyClientEnvelope<IInitiateTransactionRequest>(
      req,
      res,
      verifierOptions,
    );
    if (!call) {
      return;
    }

    const initiatorId =
      call.partnerId ?? this.options.partnerSecurityService.getControllerId();

    this.log.info(
      `Received request to initiate transaction from partner ${initiatorId}`,
    );

    const result = await this.options.controller.initiateTransaction({
      ...call.payload,
      initiatorId,
      timeToExpire: new Date(call.payload.timeToExpire),
    });

    const status = result.kind === "marked_for_review" ? 202 : 200;
    const body =
      result.kind === "marked_for_review"
        ? { transactionId: result.transactionId, status: "MARKED_FOR_REVIEW" }
        : { transactionId: result.transactionId };

    await sendSignedJson(res, status, body, call, verifierOptions);
  }
}
