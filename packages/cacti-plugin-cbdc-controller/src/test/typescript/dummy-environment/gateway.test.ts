import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import {
  BesuTestEnvironment,
  SupportedContractTypes as SupportedBesuContractTypes,
} from "./besu-environment";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as SupportedEthereumContractTypes,
} from "./ethereum-environment";
import {
  Address,
  AdminApi,
  ClaimFormat,
  Configuration,
  GatewayIdentity,
  GetApproveAddressApi,
  MonitorService,
  SATPGateway,
  SATPGatewayConfig,
  TokenType,
  TransactionApi,
  TransactRequest,
  PluginFactorySATPGateway,
} from "@hyperledger/cactus-plugin-satp-hermes";
import {
  IPluginFactoryOptions,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/core/constants";
import knex, { Knex } from "knex";
import { knexRemoteInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile-remote";
import { createMigrationSource } from "./knex/knex-migration-source";
import { knexLocalInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile";
import path from "path";
import { randomUUID } from "crypto";
import { PluginRegistry } from "@hyperledger/cactus-core";

const LOG_LEVEL = "DEBUG" as LogLevelDesc;
const TIMEOUT = 1_000_000;

const LOG = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "besu-environment-test",
});

const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

let knexSourceRemoteClient: Knex;
let knexTargetRemoteClient: Knex;
let knexLocalClient: Knex;

let gateway1: SATPGateway;
let gateway2: SATPGateway;

describe("2 SATP Gatways should send a NFT from Besu to Ethereum", () => {
  let ethereumEnv: EthereumTestEnvironment;
  let besuEnv: BesuTestEnvironment;

  it(
    "should initialize besu environment",
    async () => {
      const erc20TokenContract = "SATPContract";
      const erc721TokenContract = "SATPNonFungibleContract";
      besuEnv = await BesuTestEnvironment.setupTestEnvironment(
        {
          logLevel: LOG_LEVEL,
        },
        [
          {
            assetType: SupportedBesuContractTypes.FUNGIBLE,
            contractName: erc20TokenContract,
          },
          {
            assetType: SupportedBesuContractTypes.NONFUNGIBLE,
            contractName: erc721TokenContract,
          },
        ],
      );
      LOG.info("Besu Ledger started successfully");

      await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
    },
    TIMEOUT,
  );

  it(
    "should initialize ethereum environment",
    async () => {
      const erc20TokenContract = "SATPContract";
      const erc721TokenContract = "SATPNonFungibleContract";
      ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
        {
          logLevel: LOG_LEVEL,
        },
        [
          {
            assetType: SupportedEthereumContractTypes.FUNGIBLE,
            contractName: erc20TokenContract,
          },
          {
            assetType: SupportedEthereumContractTypes.NONFUNGIBLE,
            contractName: erc721TokenContract,
          },
        ],
      );
      LOG.info("Ethereum Ledger started successfully");
      await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
    },
    TIMEOUT,
  );

  it(
    "should mint 100 tokens to the besu account",
    async () => {
      await besuEnv.mintTokens("100", TokenType.Fungible);
      await besuEnv.checkBalance(
        besuEnv.getTestFungibleContractName(),
        besuEnv.getTestFungibleContractAddress(),
        besuEnv.getTestFungibleContractAbi(),
        besuEnv.getTestOwnerAccount(),
        "100",
        besuEnv.getTestOwnerSigningCredential(),
      );
    },
    TIMEOUT,
  );

  it(
    "should initialize the gateway",
    async () => {
      const factoryOptions: IPluginFactoryOptions = {
        pluginImportType: PluginImportType.Local,
      };
      const factory = new PluginFactorySATPGateway(factoryOptions);

      const gatewayIdentity1 = {
        id: "mockID-1",
        name: "CustomGateway",
        version: [
          {
            Core: SATP_CORE_VERSION,
            Architecture: SATP_ARCHITECTURE_VERSION,
            Crash: SATP_CRASH_VERSION,
          },
        ],
        connectedDLTs: [
          {
            id: BesuTestEnvironment.BESU_NETWORK_ID,
            ledgerType: LedgerType.Besu2X,
          },
        ],
        proofID: "mockProofID10",
        address: "http://localhost" as Address,
        gatewayOapiPort: 4010,
        gatewayServerPort: 3010,
        gatewayClientPort: 3011,
      } as GatewayIdentity;

      const gatewayIdentity2 = {
        id: "mockID-2",
        name: "CustomGateway",
        version: [
          {
            Core: SATP_CORE_VERSION,
            Architecture: SATP_ARCHITECTURE_VERSION,
            Crash: SATP_CRASH_VERSION,
          },
        ],
        connectedDLTs: [
          {
            id: EthereumTestEnvironment.ETH_NETWORK_ID,
            ledgerType: LedgerType.Ethereum,
          },
        ],
        proofID: "mockProofID11",
        address: "http://localhost" as Address,
        gatewayOapiPort: 4011,
        gatewayServerPort: 3012,
        gatewayClientPort: 3013,
      } as GatewayIdentity;

      const migrationSource = await createMigrationSource();
      knexLocalClient = knex({
        ...knexLocalInstance.default,
        migrations: {
          migrationSource: migrationSource,
        },
      });

      knexSourceRemoteClient = knex({
        ...knexRemoteInstance.default,
        migrations: {
          migrationSource: migrationSource,
        },
      });
      await knexSourceRemoteClient.migrate.latest();

      knexTargetRemoteClient = knex({
        ...knexRemoteInstance.default,
        migrations: {
          migrationSource: migrationSource,
        },
      });
      await knexSourceRemoteClient.migrate.latest();

      const besuNetworkOptions = await besuEnv.createBesuDockerConfig();
      const ethereumNetworkOptions = ethereumEnv.createEthereumConfig();

      const ontologiesPath = path.join(__dirname, "../../json/ontologies");

      const options1: SATPGatewayConfig = {
        instanceId: randomUUID(),
        logLevel: "DEBUG",
        gid: gatewayIdentity1,
        ccConfig: {
          bridgeConfig: [besuNetworkOptions],
        },
        counterPartyGateways: [gatewayIdentity2],
        localRepository: knexLocalInstance.default,
        remoteRepository: knexRemoteInstance.default,
        pluginRegistry: new PluginRegistry({ plugins: [] }),
        ontologyPath: ontologiesPath,
        monitorService: monitorService,
      };

      const options2: SATPGatewayConfig = {
        instanceId: randomUUID(),
        logLevel: "DEBUG",
        gid: gatewayIdentity2,
        ccConfig: {
          bridgeConfig: [ethereumNetworkOptions],
        },
        counterPartyGateways: [gatewayIdentity1],
        localRepository: knexLocalInstance.default,
        remoteRepository: knexRemoteInstance.default,
        pluginRegistry: new PluginRegistry({ plugins: [] }),
        ontologyPath: ontologiesPath,
        monitorService: monitorService,
      };

      gateway1 = await factory.create(options1);
      expect(gateway1).toBeInstanceOf(SATPGateway);
      await gateway1.onPluginInit();

      gateway2 = await factory.create(options2);
      expect(gateway2).toBeInstanceOf(SATPGateway);
      await gateway2.onPluginInit();

      const identity1 = gateway1.Identity;
      expect(identity1.gatewayServerPort).toBe(3010);
      expect(identity1.gatewayClientPort).toBe(3011);
      expect(identity1.gatewayOapiPort).toBe(4010);
      expect(identity1.address).toBe("http://localhost");

      const identity2 = gateway2.Identity;
      expect(identity2.gatewayServerPort).toBe(3012);
      expect(identity2.gatewayClientPort).toBe(3013);
      expect(identity2.gatewayOapiPort).toBe(4011);
      expect(identity2.address).toBe("http://localhost");
    },
    TIMEOUT,
  );

  it(
    "should transfer the NFT from Besu to Ethereum",
    async () => {
      const identity1 = gateway1.Identity;
      expect(identity1.gatewayServerPort).toBe(3010);
      expect(identity1.gatewayClientPort).toBe(3011);
      expect(identity1.address).toBe("http://localhost");

      const identity2 = gateway2.Identity;
      expect(identity2.gatewayServerPort).toBe(3012);
      expect(identity2.gatewayClientPort).toBe(3013);
      expect(identity2.address).toBe("http://localhost");

      const apiServer1 = await gateway1.getOrCreateHttpServer();

      const apiServer2 = await gateway2.getOrCreateHttpServer();

      const approveAddressApi1 = new GetApproveAddressApi(
        new Configuration({ basePath: gateway1.getAddressOApiAddress() }),
      );

      const approveAddressApi2 = new GetApproveAddressApi(
        new Configuration({ basePath: gateway2.getAddressOApiAddress() }),
      );

      const reqApproveBesuAddress = await approveAddressApi1.getApproveAddress(
        besuEnv.network,
        TokenType.Fungible,
      );

      if (!reqApproveBesuAddress?.data.approveAddress) {
        throw new Error("Approve address is undefined");
      }

      expect(reqApproveBesuAddress?.data.approveAddress).toBeDefined();

      await besuEnv.giveRoleToBridge(
        reqApproveBesuAddress?.data.approveAddress,
      );

      if (reqApproveBesuAddress?.data.approveAddress) {
        await besuEnv.approveAssets(
          reqApproveBesuAddress.data.approveAddress,
          "100",
          TokenType.Fungible,
        );
      } else {
        throw new Error("Approve address is undefined");
      }

      LOG.debug("Approved 100 amout to the Besu Bridge Address");

      const reqApproveEthereumAddress =
        await approveAddressApi2.getApproveAddress(
          ethereumEnv.network,
          TokenType.Fungible,
        );

      expect(reqApproveEthereumAddress?.data.approveAddress).toBeDefined();

      if (!reqApproveEthereumAddress?.data.approveAddress) {
        throw new Error("Approve address is undefined");
      }

      await ethereumEnv.giveRoleToBridge(
        reqApproveEthereumAddress?.data.approveAddress,
      );

      const satpApi1 = new TransactionApi(
        new Configuration({ basePath: gateway1.getAddressOApiAddress() }),
      );
      const adminApi = new AdminApi(
        new Configuration({ basePath: gateway1.getAddressOApiAddress() }),
      );

      const integrations1 = await satpApi1.getIntegrations();
      expect(integrations1?.data.integrations).toBeDefined();
      expect(integrations1?.data.integrations.length).toEqual(1);

      const integration = integrations1?.data.integrations[0];
      expect(integration).toBeDefined();
      expect(integration.environment).toBe("testnet");
      expect(integration.id).toBe("BesuLedgerTestNetwork");
      expect(integration.name).toBe("Hyperledger Besu");
      expect(integration.type).toBe("BESU_2X");
      LOG.info("Integration 1 is correct");

      const satpApi2 = new TransactionApi(
        new Configuration({
          basePath: gateway2.getAddressOApiAddress(),
        }),
      );

      const integrations2 = await satpApi2.getIntegrations();
      expect(integrations2?.data.integrations).toBeDefined();
      expect(integrations2?.data.integrations.length).toEqual(1);

      const integration2 = integrations2?.data.integrations[0];
      expect(integration2).toBeDefined();
      expect(integration2.environment).toBe("testnet");
      expect(integration2.id).toBe("EthereumLedgerTestNetwork");
      expect(integration2.name).toBe("Ethereum");
      expect(integration2.type).toBe("ETHEREUM");
      LOG.info("Integration 2 is correct");

      const sourceAsset = { ...besuEnv.defaultAsset, amount: "100" };
      const receiverAsset = { ...ethereumEnv.defaultAsset, amount: "100" };

      const request = {
        contextID: randomUUID(),
        receiverAsset,
        sourceAsset,
      } as TransactRequest;

      const res = await satpApi1?.transact(request);
      LOG.info(res?.status);
      LOG.info(res.data.statusResponse);
      expect(res?.status).toBe(200);

      const statusResponse = await adminApi.getStatus(res.data.sessionID);

      expect(statusResponse?.data.startTime).toBeDefined();
      expect(statusResponse?.data.status).toBe("DONE");
      expect(statusResponse?.data.substatus).toBe("COMPLETED");
      expect(statusResponse?.data.stage).toBe("SATP_STAGE_3");

      // check audit endpoint and get audit data
      const auditResponse = await adminApi.performAudit(0, Date.now());

      expect(auditResponse?.data.sessions).toBeDefined();
      expect(auditResponse?.data.sessions?.length).toEqual(1);

      LOG.info(
        `Audit response: ${JSON.stringify(auditResponse?.data.sessions?.[0])}`,
      );

      const json_parsed = JSON.parse(
        auditResponse?.data.sessions?.[0] || "{}",
      ) as any;
      expect(json_parsed).toBeDefined();
      expect(json_parsed.id).toBe(res.data.sessionID);
    },
    TIMEOUT,
  );
});
