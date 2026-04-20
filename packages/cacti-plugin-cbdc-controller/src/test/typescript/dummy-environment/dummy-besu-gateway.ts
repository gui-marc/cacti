import {
  Checks,
  Logger,
  LoggerProvider,
  LogLevelDesc,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { BesuEnvironment } from "./besu-environment";

import { Knex } from "knex";
import { Container } from "dockerode";
import {
  ISATPGatewayRunnerConstructorOptions,
  SATPGatewayRunner,
} from "@hyperledger/cactus-test-tooling";
import {
  AdminApi,
  Configuration,
  DEFAULT_PORT_GATEWAY_CLIENT,
  DEFAULT_PORT_GATEWAY_OAPI,
  DEFAULT_PORT_GATEWAY_SERVER,
  GatewayIdentity,
  GetApproveAddressApi,
  SATPGatewayConfig,
  TokenType,
  TransactionApi,
  TransactRequestSourceAsset,
} from "@hyperledger/cactus-plugin-satp-hermes";

import Docker from "dockerode";
import { ILedgerEnvironment } from "../../../main/typescript/types";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { setupGatewayDockerFiles } from "../utils";
import { createPGDatabase, setupDBTable } from "./db-infrastructure";

interface IDummyBesuGatewayOptions {
  logLevel: LogLevelDesc;
  portModifier?: number;
}

export class DummyBesuGateway implements ILedgerEnvironment {
  public static readonly CLASS_NAME = "DummyBesuGateway";

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

  constructor(private readonly options: IDummyBesuGatewayOptions) {
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

    await this.createDBs();
    await this.createSATPGateway();
  }

  public async stop() {
    await this.runner?.stop();
    await this.runner?.destroy();

    await this.dbLocal?.stop();
    await this.dbRemote?.stop();
    await this.dbLocal?.remove();
    await this.dbRemote?.remove();

    await this.besuEnvironment.tearDown();
  }

  private async createDBs() {
    this.log.info(`Creating local Postgres database...`);
    ({ config: this.dbLocalConfig, container: this.dbLocal } =
      await createPGDatabase({
        network: DummyBesuGateway.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));
    this.log.info(`Creating remote Postgres database...`);
    ({ config: this.dbRemoteConfig, container: this.dbRemote } =
      await createPGDatabase({
        network: DummyBesuGateway.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));

    this.log.info("Setting up database tables...");
    await setupDBTable(this.dbRemoteConfig);
  }

  private async createSATPGateway() {
    this.log.info(`Creating SATP Gateway...`);

    const gatewayKeyPair = Secp256k1Keys.generateKeyPairsBuffer();

    const gatewayIdentity = {
      id: "BesuGateway",
      name: "CustomGateway",
      version: [
        {
          Core: "v02",
          Architecture: "v02",
          Crash: "v02",
        },
      ],
      connectedDLTs: [
        {
          id: BesuEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
      ],
      proofID: "mockProofID11",
      address: `http://${this.address}`,
      gatewayClientPort:
        DEFAULT_PORT_GATEWAY_CLIENT + (this.options.portModifier || 0),
      gatewayServerPort:
        DEFAULT_PORT_GATEWAY_SERVER + (this.options.portModifier || 0),
      gatewayOapiPort:
        DEFAULT_PORT_GATEWAY_OAPI + (this.options.portModifier || 0),
      pubKey: Buffer.from(gatewayKeyPair.publicKey).toString("hex"),
    } as GatewayIdentity;

    const besuConfig = await this.besuEnvironment.createBesuDockerConfig();

    const gatewayOptions = {
      gid: gatewayIdentity,
      logLevel: this.logLevel,
      counterPartyGateways: [gatewayIdentity],
      localRepository: this.dbLocalConfig
        ? ({
            client: this.dbLocalConfig.client,
            connection: this.dbLocalConfig.connection,
          } satisfies Knex.Config)
        : undefined,
      remoteRepository: this.dbRemoteConfig
        ? ({
            client: this.dbRemoteConfig.client,
            connection: this.dbRemoteConfig.connection,
          } satisfies Knex.Config)
        : undefined,
      environment: "production",
      ccConfig: {
        bridgeConfig: [besuConfig],
      },
      enableCrashRecovery: false,
      keyPair: {
        publicKey: Buffer.from(gatewayKeyPair.publicKey).toString("hex"),
        privateKey: gatewayKeyPair.privateKey.toString("hex"),
      },
      ontologyPath: "/opt/cacti/satp-hermes/ontologies",
    } as Partial<SATPGatewayConfig>;

    const gatewayDockerFiles = setupGatewayDockerFiles(gatewayOptions);

    const gatewayRunnerOptions: ISATPGatewayRunnerConstructorOptions = {
      containerImageVersion: DummyBesuGateway.DOCKER_IMAGE_VERSION,
      containerImageName: DummyBesuGateway.DOCKER_IMAGE_NAME,
      serverPort:
        DEFAULT_PORT_GATEWAY_SERVER + (this.options.portModifier || 0),
      clientPort:
        DEFAULT_PORT_GATEWAY_CLIENT + (this.options.portModifier || 0),
      oapiPort: DEFAULT_PORT_GATEWAY_OAPI + (this.options.portModifier || 0),
      logLevel: this.logLevel,
      emitContainerLogs: true,
      configPath: gatewayDockerFiles.configPath,
      logsPath: gatewayDockerFiles.logsPath,
      ontologiesPath: gatewayDockerFiles.ontologiesPath,
      networkName: DummyBesuGateway.networkName,
      url: this.address,
    };

    this.runner = new SATPGatewayRunner(gatewayRunnerOptions);
    this.log.debug("Starting Gateway Runner...");
    await this.runner.start();
    this.log.debug("Gateway Runner started");

    const approveAddressApi = new GetApproveAddressApi(
      new Configuration({
        basePath: `http://${await this.runner.getOApiHost()}`,
      }),
    );

    const reqApproveAddress = await approveAddressApi.getApproveAddress(
      {
        id: BesuEnvironment.BESU_NETWORK_ID,
        ledgerType: LedgerType.Besu2X,
      },
      TokenType.Fungible,
    );

    if (!reqApproveAddress?.data.approveAddress) {
      throw new Error("Failed to get approve address");
    }

    this.approveAddress = reqApproveAddress.data.approveAddress;

    this.besuEnvironment.setApproveAddress(this.approveAddress);

    await this.besuEnvironment.giveRoleToBridge(this.approveAddress);

    this.transactionApi = new TransactionApi(
      new Configuration({
        basePath: `http://${await this.runner.getOApiHost()}`,
      }),
    );

    this.adminApi = new AdminApi(
      new Configuration({
        basePath: `http://${await this.runner.getOApiHost()}`,
      }),
    );

    this.log.info(`SATP Gateway created and initialized`);
  }

  getAsset(
    id: string,
    amount: number,
  ): Promise<TransactRequestSourceAsset> | TransactRequestSourceAsset {
    return this.besuEnvironment.getBesuAsset(id, amount.toString());
  }

  getTransactionApi(): TransactionApi {
    return this.transactionApi!;
  }
}
