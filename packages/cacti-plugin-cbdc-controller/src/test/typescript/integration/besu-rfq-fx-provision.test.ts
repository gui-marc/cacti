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
  EthContractInvocationType as BesuContractInvocationType,
  PluginLedgerConnectorBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { randomUUID as uuidv4 } from "node:crypto";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as SupportedEthereumContractTypes,
} from "../dummy-environment/ethereum-environment";
import {
  BesuTestEnvironment,
  SupportedContractTypes as SupportedBesuContractTypes,
} from "../dummy-environment/besu-environment";
import { createMigrationSource } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile";
import { knexRemoteInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile-remote";
import { randomUUID } from "crypto";
import { InMemoryPartnersStore } from "../../../main/typescript/store/partners-store";
import { InMemoryComplianceEndpointsStore } from "../../../main/typescript/store/compliance-endpoints-store";
import { InMemoryTransactionStore } from "../../../main/typescript/store/transaction-store";
import { ILedgerEnvironment } from "../../../main/typescript/types";
import { BesuRFQFXProvisionStrategy } from "../fx-provision/besu-rfq-fx-provision-strategy";
import {
  BesuTokenInfo,
  DummyBesuRFQEnvironment,
} from "../fx-provision/besu-rfq";
import { DummyComplianceProvider } from "../compliance/dummy-compliance-provider";
import { generatePartnerSecret } from "../../../main/typescript/core/partner-signing";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "CBDC - BesuRFQ FX Integration",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

const SOURCE_CHAIN_CODE = "besu";
const DESTINATION_CHAIN_CODE = "ethereum";
const COMPLIANCE_PROVIDER_PORT = 3030;
const CONTROLLER_ID = "besu-rfq-test-controller";
const INITIATOR_PARTNER_ID = "besu-rfq-test-initiator";
const INITIATOR_SECRET = generatePartnerSecret();
const COMPLIANCE_PARTNER_ID = "besu-rfq-test-compliance-bank";
const COMPLIANCE_ENDPOINT_ID = "besu-rfq-test-compliance-endpoint";
const COMPLIANCE_PROVIDER_SECRET = generatePartnerSecret();
const RATE_NUM = 4n;
const RATE_DEN = 5n;

let knexSourceRemoteClient: Knex;
let knexLocalClient: Knex;
let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;
let rfqEnv: DummyBesuRFQEnvironment;
let rfqTokenConnector: PluginLedgerConnectorBesu;
let rfqTokenKeychain: PluginKeychainMemory;
let gateway: SATPGateway;
let complianceProvider: DummyComplianceProvider;

const TIMEOUT = 900000; // 15 minutes

async function deployRfqToken(contractName: string): Promise<BesuTokenInfo> {
  await rfqTokenKeychain.set(contractName, JSON.stringify(SATPTokenContract));
  const deployRes = await rfqTokenConnector.deployContract({
    keychainId: rfqTokenKeychain.getKeychainId(),
    contractName,
    contractAbi: SATPTokenContract.abi,
    constructorArgs: [rfqEnv.ownerAccount],
    web3SigningCredential: rfqEnv.ownerSigningCredential,
    bytecode: SATPTokenContract.bytecode.object,
    gas: 1_000_000,
  });
  const address = deployRes.transactionReceipt.contractAddress;
  if (!address) {
    throw new Error(`Deployment of ${contractName} did not return an address`);
  }
  return { contractName, address, abi: SATPTokenContract.abi };
}

async function mintRfqToken(
  token: BesuTokenInfo,
  account: string,
  amount: number,
): Promise<void> {
  await rfqTokenConnector.invokeContract({
    contractName: token.contractName,
    contractAddress: token.address,
    contractAbi: token.abi,
    invocationType: BesuContractInvocationType.Send,
    methodName: "mint",
    params: [account, amount],
    signingCredential: rfqEnv.ownerSigningCredential,
    gas: 1_000_000,
  });
}

afterAll(async () => {
  if (complianceProvider) {
    await complianceProvider.stop();
  }
  if (rfqEnv) {
    await rfqEnv.tearDown();
  }
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
  {
    rfqEnv = new DummyBesuRFQEnvironment({ logLevel });
    await rfqEnv.init();
    await rfqEnv.deployAndSetupContracts();
    log.info("RFQ Besu Ledger started successfully");

    rfqTokenKeychain = new PluginKeychainMemory({
      instanceId: uuidv4(),
      keychainId: uuidv4(),
      backend: new Map(),
      logLevel,
    });
    rfqTokenConnector = new PluginLedgerConnectorBesu({
      instanceId: uuidv4(),
      rpcApiHttpHost: rfqEnv.connectorOptions.rpcApiHttpHost,
      rpcApiWsHost: rfqEnv.connectorOptions.rpcApiWsHost,
      pluginRegistry: new PluginRegistry({ plugins: [rfqTokenKeychain] }),
      logLevel,
    });

    const besuLiquidityToken = await deployRfqToken("BesuLiquidityToken");
    const ethereumLiquidityToken = await deployRfqToken(
      "EthereumLiquidityToken",
    );

    await mintRfqToken(besuLiquidityToken, rfqEnv.ownerAccount, 10_000_000);
    await mintRfqToken(ethereumLiquidityToken, rfqEnv.ownerAccount, 10_000_000);

    rfqEnv.registerCurrency(SOURCE_CHAIN_CODE, besuLiquidityToken);
    rfqEnv.registerCurrency(DESTINATION_CHAIN_CODE, ethereumLiquidityToken);

    // MM seeds reserves on both sides for either-direction quoting.
    await rfqEnv.provideLiquidity(
      SOURCE_CHAIN_CODE,
      500_000,
      rfqEnv.ownerSigningCredential,
    );
    await rfqEnv.provideLiquidity(
      DESTINATION_CHAIN_CODE,
      500_000,
      rfqEnv.ownerSigningCredential,
    );

    rfqEnv.setRate(
      SOURCE_CHAIN_CODE,
      DESTINATION_CHAIN_CODE,
      RATE_NUM,
      RATE_DEN,
    );
    rfqEnv.setRate(
      DESTINATION_CHAIN_CODE,
      SOURCE_CHAIN_CODE,
      RATE_DEN,
      RATE_NUM,
    );

    log.info("RFQ liquidity provided");
  }

  complianceProvider = new DummyComplianceProvider({
    port: COMPLIANCE_PROVIDER_PORT,
    partnerId: COMPLIANCE_PARTNER_ID,
    apiKey: COMPLIANCE_PROVIDER_SECRET,
    controllerId: CONTROLLER_ID,
  });
  await complianceProvider.start();
}, TIMEOUT);

describe("CBDC controller using BesuRFQFXProvisionStrategy", () => {
  it(
    "performs a SATP transfer from Besu to Ethereum priced by an off-chain signed RFQ",
    async () => {
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

      const fxProvisionStrategy = new BesuRFQFXProvisionStrategy({
        besuRFQ: rfqEnv,
        takerSigningCredential: rfqEnv.ownerSigningCredential,
        takerAccount: rfqEnv.ownerAccount,
      });

      const partnersStore = new InMemoryPartnersStore();
      await partnersStore.save({
        id: INITIATOR_PARTNER_ID,
        apiKey: INITIATOR_SECRET,
      });
      await partnersStore.save({
        id: COMPLIANCE_PARTNER_ID,
        apiKey: COMPLIANCE_PROVIDER_SECRET,
      });
      const complianceEndpointsStore = new InMemoryComplianceEndpointsStore();
      await complianceEndpointsStore.save({
        id: COMPLIANCE_ENDPOINT_ID,
        partnerId: COMPLIANCE_PARTNER_ID,
        url: complianceProvider.getEndpointUrl(),
      });

      const cbdcPlugin = await cbdcFactory.create({
        instanceId: "test-instance",
        controllerId: CONTROLLER_ID,
        partnersStore,
        complianceEndpointsStore,
        fxProvisionStrategy,
        transactionStore: new InMemoryTransactionStore(),
        environments: { besu: besuCBDCEnv, ethereum: ethereumCBDCEnv },
        logLevel,
        requireHttps: false,
        requireClientAuth: false,
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
      expect(identity.gatewayServerPort).toBe(3010);
      expect(identity.gatewayClientPort).toBe(3011);
      expect(identity.address).toBe("http://localhost");
      await gateway.startup();
      await gateway.getOrCreateHttpServer();

      const dispatcher = gateway.BLODispatcherInstance;

      const cbdcController = cbdcPlugin.getController();

      const amountIn = 100;
      const expectedAmountOut = (BigInt(amountIn) * RATE_NUM) / RATE_DEN;
      log.info(
        `RFQ rate: ${Number(RATE_NUM) / Number(RATE_DEN)}, expected amountOut: ${expectedAmountOut}`,
      );

      // Initiate the transaction through the gateway, which will route it to the CBDC controller plugin
      await besuEnv.mintTokens("100", TokenType.Fungible);

      const besuWrapper = (
        await dispatcher!.GetApproveAddress({
          networkId: besuEnv.network,
          tokenType: TokenType.Fungible,
        })
      ).approveAddress;

      await besuEnv.giveRoleToBridge(besuWrapper);
      await besuEnv.approveAssets(besuWrapper, "100", TokenType.Fungible);

      const ethWrapper = (
        await dispatcher!.GetApproveAddress({
          networkId: ethereumEnv.network,
          tokenType: TokenType.Fungible,
        })
      ).approveAddress;
      await ethereumEnv.giveRoleToBridge(ethWrapper);

      await cbdcController.initiateTransaction({
        amount: amountIn,
        initiatorId: INITIATOR_PARTNER_ID,
        complianceProviders: [COMPLIANCE_ENDPOINT_ID],
        destinationChainCode: DESTINATION_CHAIN_CODE,
        senderAddress: besuEnv.getTestOwnerAccount(),
        receiverAddress: ethereumEnv.getTestOwnerAccount(),
        sourceChainCode: SOURCE_CHAIN_CODE,
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
      log.info("Amount was transferred correctly from the Owner account");

      await ethereumEnv.checkBalance(
        ethereumEnv.getTestFungibleContractName(),
        ethereumEnv.getTestFungibleContractAddress(),
        ethereumEnv.getTestFungibleContractAbi(),
        ethereumEnv.getTestOwnerAccount(),
        expectedAmountOut.toString(),
        ethereumEnv.getTestOwnerSigningCredential(),
      );
      log.info("Amount was transferred correctly to the Owner account");

      await gateway.shutdown();
    },
    TIMEOUT,
  );
});
