import { fail } from "jest-extended";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  afterEach,
  beforeEach,
} from "@jest/globals";
import { createPluginFactory as createCBDCPluginFactory } from "../../../main/typescript/public-api";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  pruneDockerContainersIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import {
  SATPGatewayConfig,
  SATPGateway,
  PluginFactorySATPGateway,
  TokenType,
  Address,
  GatewayIdentity,
  ClaimFormat,
  MonitorService,
  TransactRequestSourceAsset,
} from "@hyperledger/cactus-plugin-satp-hermes";
import {
  IPluginFactoryOptions,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/core/constants";
import { Knex, knex } from "knex";
import { PluginRegistry } from "@hyperledger/cactus-core";
import path from "path";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as SupportedEthereumContractTypes,
} from "./ethereum-environment";
import {
  BesuTestEnvironment,
  SupportedContractTypes as SupportedBesuContractTypes,
} from "./besu-environment";
import { createMigrationSource } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile";
import { knexRemoteInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile-remote";
import { randomUUID } from "crypto";
import { InMemoryComplianceProvidersStore } from "../../../main/typescript/store/compliance-providers-store";
import { InMemoryTransactionStore } from "../../../main/typescript/store/transaction-store";
import { ILedgerEnvironment } from "../../../main/typescript/types";
import { DummyMemoryFXProvisionStrategy } from "../fx-provision/dummy-memory-fx-provision-strategy";
import { DummyInMemoryAMM } from "../fx-provision/dummy-memory-amm";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "CBDC - Integration",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

let knexSourceRemoteClient: Knex;
let knexLocalClient: Knex;
let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;
let gateway: SATPGateway;

const TIMEOUT = 900000; // 15 minutes

afterAll(async () => {
  if (ethereumEnv) {
    await ethereumEnv.tearDown();
  }
  if (besuEnv) {
    await besuEnv.tearDown();
  }

  await pruneDockerContainersIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
}, TIMEOUT);

afterEach(async () => {
  if (gateway) {
    await gateway.shutdown();
  }
  if (knexLocalClient) {
    await knexLocalClient.destroy();
  }
  if (knexSourceRemoteClient) {
    await knexSourceRemoteClient.destroy();
  }
  pruneDockerContainersIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
}, TIMEOUT);

beforeEach(() => {
  pruneDockerContainersIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
}, TIMEOUT);

beforeAll(async () => {
  {
    const erc20TokenContract = "SATPContract";
    const erc721TokenContract = "SATPNonFungibleContract";
    besuEnv = await BesuTestEnvironment.setupTestEnvironment(
      {
        logLevel,
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
    log.info("Besu Ledger started successfully");

    await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  }
  {
    const erc20TokenContract = "SATPContract";
    const erc721TokenContract = "SATPNonFungibleContract";
    ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
      {
        logLevel,
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
    log.info("Ethereum Ledger started successfully");
    await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  }
}, TIMEOUT);

describe("SATPGateway sending a token from Besu to Ethereum", () => {
  it(
    "should realize a transfer",
    async () => {
      //setup satp gateway
      const factoryOptions: IPluginFactoryOptions = {
        pluginImportType: PluginImportType.Local,
      };
      const factory = new PluginFactorySATPGateway(factoryOptions);

      const gatewayIdentity = {
        id: "mockID",
        name: "CustomGateway",
        version: [
          {
            Core: SATP_CORE_VERSION,
            Architecture: SATP_ARCHITECTURE_VERSION,
            Crash: SATP_CRASH_VERSION,
          },
        ],
        proofID: "mockProofID10",
        address: "http://localhost" as Address,
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

      const besuNetworkOptions = besuEnv.createBesuConfig();
      const ethereumNetworkOptions = ethereumEnv.createEthereumConfig();

      const ontologiesPath = path.join(__dirname, "../../json/ontologies");

      log.info("Creating CBDCController Plugin");

      const cbdcFactory = await createCBDCPluginFactory({
        pluginImportType: PluginImportType.Local,
      });

      const besuCBDCEnv: ILedgerEnvironment = {
        getAsset(asset, amount) {
          return {
            contractName: besuEnv.getTestFungibleContractName(),
            contractAddress: besuEnv.getTestFungibleContractAddress(),
            ercTokenStandard: "ERC20",
            id: besuEnv.defaultAsset.id,
            networkId: besuEnv.network,
            tokenType: TokenType.Fungible,
            owner: besuEnv.getTestOwnerAccount(),
            referenceId: besuEnv.defaultAsset.referenceId,
            amount: amount.toString(),
          } satisfies TransactRequestSourceAsset;
        },
        transact(request) {
          return dispatcher!.Transact(request);
        },
      };

      const ethereumCBDCEnv: ILedgerEnvironment = {
        getAsset(asset, amount) {
          return {
            contractName: ethereumEnv.getTestFungibleContractName(),
            contractAddress: ethereumEnv.getTestFungibleContractAddress(),
            ercTokenStandard: "ERC20",
            id: ethereumEnv.defaultAsset.id,
            networkId: ethereumEnv.network,
            tokenType: TokenType.Fungible,
            owner: ethereumEnv.getTestOwnerAccount(),
            referenceId: ethereumEnv.defaultAsset.referenceId,
            amount: amount.toString(),
          } satisfies TransactRequestSourceAsset;
        },
        transact(request) {
          return dispatcher!.Transact(request);
        },
      };

      const amm = new DummyInMemoryAMM();

      const cbdcPlugin = await cbdcFactory.create({
        instanceId: "test-instance",
        complianceProvidersStore: new InMemoryComplianceProvidersStore(),
        fxProvisionStrategy: new DummyMemoryFXProvisionStrategy(amm),
        transactionStore: new InMemoryTransactionStore(),
        environments: { besu: besuCBDCEnv, ethereum: ethereumCBDCEnv },
        logLevel,
      });
      await cbdcPlugin.onPluginInit();

      const options: SATPGatewayConfig = {
        instanceId: randomUUID(),
        logLevel: "DEBUG",
        gid: gatewayIdentity,
        ccConfig: {
          bridgeConfig: [besuNetworkOptions, ethereumNetworkOptions],
        },
        localRepository: knexLocalInstance.default,
        remoteRepository: knexRemoteInstance.default,
        pluginRegistry: new PluginRegistry({ plugins: [cbdcPlugin] }),
        ontologyPath: ontologiesPath,
        monitorService: monitorService,
      };
      gateway = await factory.create(options);
      expect(gateway).toBeInstanceOf(SATPGateway);

      const identity = gateway.Identity;
      // default servers
      expect(identity.gatewayServerPort).toBe(3010);
      expect(identity.gatewayClientPort).toBe(3011);
      expect(identity.address).toBe("http://localhost");
      await gateway.startup();

      const dispatcher = gateway.BLODispatcherInstance;

      const cbdcController = cbdcPlugin.getController();

      log.info("Adding liquidity to the AMM");

      amm.addLiquidity("besu", 523);
      amm.addLiquidity("ethereum", 413);

      await cbdcController.initiateTransaction({
        amount: 100,
        complianceProviders: [],
        destinationChainCode: "ethereum",
        senderAddress: besuEnv.getTestOwnerAccount(),
        receiverAddress: ethereumEnv.getTestOwnerAccount(),
        sourceChainCode: "besu",
        timeToExpire: new Date(Date.now() + 3600000),
      });

      await besuEnv.checkBalance(
        besuEnv.getTestFungibleContractName(),
        besuEnv.getTestFungibleContractAddress(),
        besuEnv.getTestFungibleContractAbi(),
        besuEnv.getTestOwnerAccount(),
        "0",
        besuEnv.getTestOwnerSigningCredential(),
      );
      log.info("Amount was transfer correctly from the Owner account");

      await ethereumEnv.checkBalance(
        ethereumEnv.getTestFungibleContractName(),
        ethereumEnv.getTestFungibleContractAddress(),
        ethereumEnv.getTestFungibleContractAbi(),
        ethereumEnv.getTestOwnerAccount(),
        "100", // todo: set fx rate
        ethereumEnv.getTestOwnerSigningCredential(),
      );
      log.info("Amount was transfer correctly to the Owner account");

      await gateway.shutdown();
    },
    TIMEOUT,
  );
});
