import {
  Checks,
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { BesuEnvironment } from "./besu-environment";

import { Knex } from "knex";
import { Container } from "dockerode";
import { SATPGatewayRunner } from "@hyperledger/cactus-test-tooling";
import {
  AdminApi,
  TransactionApi,
} from "@hyperledger/cactus-plugin-satp-hermes";

import Docker from "dockerode";

interface IDumyBesuGatewayOptions {
  logLevel: LogLevelDesc;
}

export class DummyBesuGateway {
  public static readonly CLASS_NAME = "CbdcBridgingAppDummyInfrastructure";

  private static readonly networkName = "CDBC_Network";

  private static readonly DOCKER_IMAGE_VERSION = "5f190f37f-2025-08-19";
  private static readonly DOCKER_IMAGE_NAME =
    "kubaya/cacti-satp-hermes-gateway";

  private readonly log: Logger;
  private readonly logLevel: LogLevelDesc;

  private readonly besuEnvironment: BesuEnvironment;

  private dbLocalConfig?: Knex.Config;
  private dbRemoteConfig?: Knex.Config;
  private dbLocal?: Container;
  private dbRemote?: Container;

  private runner?: SATPGatewayRunner;
  private address = "besu-gateway.satp-hermes";
  private approveAddress?: string;

  private transactionApi?: TransactionApi;
  private adminApi?: AdminApi;

  constructor(public readonly options: IDumyBesuGatewayOptions) {
    const fnTag = `${DummyBesuGateway.CLASS_NAME}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);

    this.logLevel = options.logLevel;
    const label = `${DummyBesuGateway.CLASS_NAME}`;
    this.log = LoggerProvider.getOrCreate({ level: this.logLevel, label });
    this.besuEnvironment = new BesuEnvironment(
      options.logLevel,
      DummyBesuGateway.networkName,
    );
  }

  public async init() {
    this.log.info(`Initializing dummy Besu gateway...`);

    // Create docker network
    this.log.info(`Creating docker network ${DummyBesuGateway.networkName}...`);
    const docker = new Docker();
    const networks = await docker.listNetworks();
    const networkExists = networks.some(
      (n) => n.Name === DummyBesuGateway.networkName,
    );
    if (!networkExists) {
      await docker.createNetwork({
        Name: DummyBesuGateway.networkName,
        Driver: "bridge",
      });
      this.log.info(`Docker network ${DummyBesuGateway.networkName} created`);
    } else {
      this.log.info(
        `Docker network ${DummyBesuGateway.networkName} already exists, skipping creation`,
      );
    }

    this.log.info(`Initializing Besu environment...`);
    await this.besuEnvironment.init();
    this.log.info(`Deploying Besu contracts and setting up environment...`);
    await this.besuEnvironment.deployAndSetupContracts();
  }
}
