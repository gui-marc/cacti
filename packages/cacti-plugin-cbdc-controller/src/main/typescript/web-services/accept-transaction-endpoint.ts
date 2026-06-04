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
import { IAcceptTransactionRequest, IRequestOptions } from "../types";
import { sendSignedJson, verifyClientEnvelope } from "./envelope-verifier";

export class AcceptTransactionEndpointV1 implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "AcceptTransactionEndpointV1";

  private readonly log: Logger;

  private readonly options: IRequestOptions;

  public get className(): string {
    return AcceptTransactionEndpointV1.CLASS_NAME;
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
    return "post";
  }

  getPath(): string {
    return "/accept-transaction";
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

    const call = await verifyClientEnvelope<IAcceptTransactionRequest>(
      req,
      res,
      verifierOptions,
    );
    if (!call) {
      return;
    }

    const actorId =
      call.partnerId ?? this.options.partnerSecurityService.getControllerId();

    this.log.info(
      `Received request from partner ${actorId} to accept transaction with id ${call.payload.transactionId}`,
    );

    try {
      await this.options.controller.acceptTransaction(
        call.payload.transactionId,
        actorId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/is not the initiator/.test(message)) {
        res.status(403).json({ error: message });
        return;
      }
      throw error;
    }

    await sendSignedJson(
      res,
      200,
      {
        transactionId: call.payload.transactionId,
        status: "COMPLETED",
      },
      call,
      verifierOptions,
    );
  }
}
