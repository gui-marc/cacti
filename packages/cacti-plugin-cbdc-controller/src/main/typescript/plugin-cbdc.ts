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
import {
  AdminApi,
  Configuration,
  TransactionApi,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { IInfrastructure, ILedgerEnvironment, IRequestOptions } from "./types";
import { registerWebServiceEndpoint } from "@hyperledger/cactus-core";
import { InitiateTransactionEndpointV1 } from "./web-services/initiate-transaction-endpoint";
import CBDCController from "./core/cbdc-controller";
import { TransactionStore } from "./store/transaction-store";
import { FXProvidersStore } from "./store/fx-providers-store";
import { ComplianceProvidersStore } from "./store/compliance-providers-store";
import { SetComplianceChecksEndpointV1 } from "./web-services/set-compliance-checks-endpoint";
import { SetExchangeRateEndpointV1 } from "./web-services/set-exchange-rate-endpoint";

export interface IPluginCBDCOptions extends ICactusPluginOptions {
  logLevel?: LogLevelDesc;
  satpConfig: Configuration;
  environments: Record<string, ILedgerEnvironment>;
  transactionStore: TransactionStore;
  fxProvidersStore: FXProvidersStore;
  complianceProvidersStore: ComplianceProvidersStore;
}

export class PluginCBDCController implements ICactusPlugin {
  public static readonly CLASS_NAME = "PluginCBDCController";

  private readonly instanceId: string;
  private readonly logLevel: LogLevelDesc;
  private readonly log: Logger;
  private readonly options: IPluginCBDCOptions;
  private readonly controller: CBDCController;

  private webApplication: Express;

  private infrastructure: IInfrastructure;

  constructor(options: IPluginCBDCOptions) {
    this.logLevel = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "CBDCController",
    });
    this.options = options;
    this.instanceId = this.options.instanceId;
    this.webApplication = express();

    this.infrastructure = {
      satpGateway: {
        transactionApi: new TransactionApi(this.options.satpConfig),
        adminApi: new AdminApi(this.options.satpConfig),
      },
      environments: this.options.environments,
    };

    this.controller = new CBDCController(
      this.options.transactionStore,
      this.options.fxProvidersStore,
      this.options.complianceProvidersStore,
    );
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getPackageName(): string {
    return `@hyperledger-cacti/cacti-plugin-cbdc-controller`;
  }

  async onPluginInit(): Promise<unknown> {
    await this.createWebServices();
    return;
  }

  private async createWebServices() {
    this.webApplication.use(express.json({ limit: "250mb" }));
    this.webApplication.use(cors());

    const requestOptions = {
      infrastructure: this.infrastructure,
      logLevel: this.logLevel,
      controller: this.controller,
    } as IRequestOptions;

    await Promise.all([
      registerWebServiceEndpoint(
        this.webApplication,
        new InitiateTransactionEndpointV1(requestOptions),
      ),
      registerWebServiceEndpoint(
        this.webApplication,
        new SetComplianceChecksEndpointV1(requestOptions),
      ),
      registerWebServiceEndpoint(
        this.webApplication,
        new SetExchangeRateEndpointV1(requestOptions),
      ),
    ]);
  }
}
