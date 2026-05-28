import cors from "cors";
import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";

import {
  ICactusPlugin,
  ICactusPluginOptions,
} from "@hyperledger/cactus-core-api";

import express, { type Express } from "express";
import { IInfrastructure, ILedgerEnvironment, IRequestOptions } from "./types";
import { registerWebServiceEndpoint } from "@hyperledger/cactus-core";
import { InitiateTransactionEndpointV1 } from "./web-services/initiate-transaction-endpoint";
import { AcceptTransactionEndpointV1 } from "./web-services/accept-transaction-endpoint";
import { AddComplianceEndpointEndpointV1 } from "./web-services/add-compliance-endpoint-endpoint";
import { RemoveComplianceEndpointEndpointV1 } from "./web-services/remove-compliance-endpoint-endpoint";
import CBDCController from "./core/cbdc-controller";
import { TransactionStore } from "./store/transaction-store";
import { PartnersStore } from "./store/partners-store";
import { ComplianceEndpointsStore } from "./store/compliance-endpoints-store";
import { FXProvisionStrategy } from "./core/fx-provision";
import { PartnerSecurityService } from "./core/partner-security-service";

export interface IPluginCBDCOptions extends ICactusPluginOptions {
  controllerId: string;
  logLevel?: LogLevelDesc;
  environments: Record<string, ILedgerEnvironment>;
  transactionStore: TransactionStore;
  fxProvisionStrategy: FXProvisionStrategy;
  partnersStore: PartnersStore;
  complianceEndpointsStore: ComplianceEndpointsStore;
  requireHttps?: boolean;
  requireClientAuth?: boolean;
}

export class PluginCBDCController implements ICactusPlugin {
  public static readonly CLASS_NAME = "PluginCBDCController";

  private readonly instanceId: string;
  private readonly logLevel: LogLevelDesc;
  private readonly log: Logger;
  private readonly options: IPluginCBDCOptions;
  private readonly controller: CBDCController;
  private readonly partnerSecurityService: PartnerSecurityService;
  private readonly requireClientAuth: boolean;

  private webApplication: Express;

  private infrastructure: IInfrastructure;

  constructor(options: IPluginCBDCOptions) {
    if (!options.controllerId) {
      throw new Error(
        "IPluginCBDCOptions.controllerId is required so the controller can identify itself in signed messages",
      );
    }
    this.logLevel = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "CBDCController",
    });
    this.options = options;
    this.instanceId = this.options.instanceId;
    this.requireClientAuth = this.options.requireClientAuth ?? true;
    this.webApplication = express();

    this.infrastructure = {
      environments: this.options.environments,
    };

    this.partnerSecurityService = new PartnerSecurityService({
      controllerId: this.options.controllerId,
      partnersStore: this.options.partnersStore,
    });

    this.controller = new CBDCController({
      transactionStore: this.options.transactionStore,
      fxProvisionStrategy: this.options.fxProvisionStrategy,
      complianceEndpointsStore: this.options.complianceEndpointsStore,
      partnerSecurityService: this.partnerSecurityService,
      infrastructure: this.infrastructure,
      logLevel: this.logLevel,
      requireHttps: this.options.requireHttps,
    });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getPackageName(): string {
    return `@hyperledger-cacti/cacti-plugin-cbdc-controller`;
  }

  getController() {
    return this.controller;
  }

  getPartnerSecurityService() {
    return this.partnerSecurityService;
  }

  async onPluginInit(): Promise<unknown> {
    await this.createWebServices();
    return;
  }

  private async createWebServices() {
    this.log.debug("Creating web services...");

    this.webApplication.use(express.json({ limit: "250mb" }));
    this.webApplication.use(cors());

    const requestOptions: IRequestOptions = {
      infrastructure: this.infrastructure,
      logLevel: this.logLevel,
      controller: this.controller,
      partnerSecurityService: this.partnerSecurityService,
      complianceEndpointsStore: this.options.complianceEndpointsStore,
      partnersStore: this.options.partnersStore,
      requireClientAuth: this.requireClientAuth,
      requireHttps: this.options.requireHttps ?? true,
    };

    await Promise.all([
      registerWebServiceEndpoint(
        this.webApplication,
        new InitiateTransactionEndpointV1(requestOptions),
      ),
      registerWebServiceEndpoint(
        this.webApplication,
        new AcceptTransactionEndpointV1(requestOptions),
      ),
      registerWebServiceEndpoint(
        this.webApplication,
        new AddComplianceEndpointEndpointV1(requestOptions),
      ),
      registerWebServiceEndpoint(
        this.webApplication,
        new RemoveComplianceEndpointEndpointV1(requestOptions),
      ),
    ]);
  }
}
