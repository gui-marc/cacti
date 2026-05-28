import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import axios from "axios";
import { randomBytes } from "node:crypto";
import {
  ILedgerEnvironment,
  generatePartnerSecret,
  PluginCBDCController,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import {
  TokenType,
  TransactRequest,
  TransactRequestSourceAsset,
  ClaimFormat,
} from "@hyperledger/cactus-plugin-satp-hermes";
import {
  BesuTestEnvironment,
  SupportedContractTypes as BesuContractTypes,
} from "../../../../../packages/cacti-plugin-cbdc-controller/dist/lib/test/typescript/dummy-environment/besu-environment";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as EthContractTypes,
} from "../../../../../packages/cacti-plugin-cbdc-controller/dist/lib/test/typescript/dummy-environment/ethereum-environment";

import {
  applyCentralBankMigrations,
  openDatabase,
} from "../../main/typescript/store/sqlite/db";
import { SqliteTransactionStore } from "../../main/typescript/store/sqlite/sqlite-transaction-store";
import { SqlitePartnersStore } from "../../main/typescript/store/sqlite/sqlite-partners-store";
import { SqliteComplianceEndpointsStore } from "../../main/typescript/store/sqlite/sqlite-compliance-endpoints-store";
import { ConstantFxProvisionStrategy } from "../../main/typescript/central-bank/constant-fx-provision-strategy";
import { startSatpGateway } from "../../main/typescript/infrastructure/satp-gateway";
import { startPartner } from "../../main/typescript/partner/partner-app";
import { IPartnerConfig, IChainRuntimeConfig } from "../../main/typescript/config/types";
import { ChainCode } from "../../main/typescript/types";
import express from "express";
import http from "node:http";

const TIMEOUT = 15 * 60 * 1000;

const PARTNER_PORT = 5910;
const CB_PORT = 4910;

let tmpDir: string;
let besuEnv: BesuTestEnvironment;
let ethEnv: EthereumTestEnvironment;
let cbHttpServer: http.Server | null = null;
let gatewayShutdown: (() => Promise<void>) | null = null;
let stopPartner: (() => Promise<void>) | null = null;
let cbDb: ReturnType<typeof openDatabase> | null = null;
let secret: string;

const CONTRACT_NAME = "SATPContract";

beforeAll(async () => {
  // Knex SATP repositories pick their config by NODE_ENV / ENVIRONMENT.
  // knexLocalInstance only exposes a "default" key.
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "default";
  if (!process.env.ENVIRONMENT) process.env.ENVIRONMENT = "default";
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbdc-satp-e2e-"));
  secret = generatePartnerSecret();

  besuEnv = await BesuTestEnvironment.setupTestEnvironment(
    { logLevel: "WARN" },
    [{ assetType: BesuContractTypes.FUNGIBLE, contractName: CONTRACT_NAME }],
  );
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  ethEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel: "WARN" },
    [{ assetType: EthContractTypes.FUNGIBLE, contractName: CONTRACT_NAME }],
  );
  await ethEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  let dispatcherTransact: ((req: TransactRequest) => Promise<unknown>) | null =
    null;

  const besuCBDCEnv: ILedgerEnvironment = {
    getAsset(_id: string, amount: number): TransactRequestSourceAsset {
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
      } as TransactRequestSourceAsset;
    },
    async transact(request: TransactRequest) {
      if (!dispatcherTransact) throw new Error("Gateway not ready");
      return (await dispatcherTransact(request)) as never;
    },
  };

  const ethCBDCEnv: ILedgerEnvironment = {
    getAsset(_id: string, amount: number): TransactRequestSourceAsset {
      return {
        contractName: ethEnv.getTestFungibleContractName(),
        contractAddress: ethEnv.getTestFungibleContractAddress(),
        ercTokenStandard: "ERC20",
        id: ethEnv.defaultAsset.id,
        networkId: ethEnv.network,
        tokenType: TokenType.Fungible,
        owner: ethEnv.getTestOwnerAccount(),
        referenceId: ethEnv.defaultAsset.referenceId,
        amount: amount.toString(),
      } as TransactRequestSourceAsset;
    },
    async transact(request: TransactRequest) {
      if (!dispatcherTransact) throw new Error("Gateway not ready");
      return (await dispatcherTransact(request)) as never;
    },
  };

  cbDb = openDatabase(path.join(tmpDir, "cb.sqlite"));
  applyCentralBankMigrations(cbDb);
  const partnersStore = new SqlitePartnersStore(cbDb);
  const complianceEndpointsStore = new SqliteComplianceEndpointsStore(cbDb);
  const transactionStore = new SqliteTransactionStore(cbDb);

  await partnersStore.save({ id: "partner-a", apiKey: secret });

  const cbdcPlugin = new PluginCBDCController({
    instanceId: "cb-instance",
    controllerId: "cb-shared",
    partnersStore,
    complianceEndpointsStore,
    transactionStore,
    fxProvisionStrategy: new ConstantFxProvisionStrategy(1.5),
    environments: { besu: besuCBDCEnv, ethereum: ethCBDCEnv },
    logLevel: "WARN",
    requireHttps: false,
    requireClientAuth: true,
  });
  await cbdcPlugin.onPluginInit();

  const ontologyPath = path.resolve(
    __dirname,
    "../../../../../packages/cacti-plugin-cbdc-controller/src/test/json/ontologies",
  );

  const started = await startSatpGateway({
    gatewayConfig: {
      baseUrl: "http://localhost",
      serverPort: 3010,
      clientPort: 3011,
      gatewayId: "cb-shared-gateway",
    },
    bridgeConfig: [besuEnv.createBesuConfig(), ethEnv.createEthereumConfig()],
    ontologyPath,
    plugins: [cbdcPlugin],
    logLevel: "WARN",
  });
  gatewayShutdown = started.shutdown;
  dispatcherTransact = (req) =>
    started.gateway.BLODispatcherInstance!.Transact(req);

  // Mint + grant role + approve so SATP can actually move tokens
  await besuEnv.mintTokens("100", TokenType.Fungible);
  const besuWrapper = (
    await started.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await besuEnv.giveRoleToBridge(besuWrapper);
  await besuEnv.approveAssets(besuWrapper, "100", TokenType.Fungible);

  const ethWrapper = (
    await started.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: ethEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await ethEnv.giveRoleToBridge(ethWrapper);

  // Mount the CBDC plugin's express app on a port
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const pluginApp = (cbdcPlugin as unknown as { webApplication: express.Express })
    .webApplication;
  app.use("/cbdc", pluginApp);
  cbHttpServer = app.listen(CB_PORT);
  await new Promise<void>((r) => cbHttpServer!.on("listening", r));

  // Start partner pointing at the single CB for both chains
  const chains: Record<ChainCode, IChainRuntimeConfig> = {
    besu: {
      chainCode: "besu",
      networkId: besuEnv.network.id,
      rpcHttpUrl: "http://unused",
      rpcWsUrl: "ws://unused",
      cbdcContract: {
        contractName: besuEnv.getTestFungibleContractName(),
        contractAddress: besuEnv.getTestFungibleContractAddress(),
        ownerAddress: besuEnv.getTestOwnerAccount(),
        ownerPrivateKey: "",
      },
      satpWrapperAddress: besuWrapper,
    },
    ethereum: {
      chainCode: "ethereum",
      networkId: ethEnv.network.id,
      rpcHttpUrl: "http://unused",
      rpcWsUrl: "ws://unused",
      cbdcContract: {
        contractName: ethEnv.getTestFungibleContractName(),
        contractAddress: ethEnv.getTestFungibleContractAddress(),
        ownerAddress: ethEnv.getTestOwnerAccount(),
        ownerPrivateKey: "",
      },
      satpWrapperAddress: ethWrapper,
    },
  };

  const partnerCfg: IPartnerConfig = {
    role: "partner",
    partnerId: "partner-a",
    instanceId: "partner-a",
    httpPort: PARTNER_PORT,
    publicBaseUrl: `http://localhost:${PARTNER_PORT}`,
    centralBanks: [
      { chainCode: "besu", baseUrl: `http://localhost:${CB_PORT}`, apiKey: secret },
      { chainCode: "ethereum", baseUrl: `http://localhost:${CB_PORT}`, apiKey: secret },
    ],
    chains,
    seedUsers: [
      {
        taxId: "999",
        password: "pw",
        displayName: "Owner",
        ledgerAccounts: {
          besu: besuEnv.getTestOwnerAccount(),
          ethereum: ethEnv.getTestOwnerAccount(),
        },
      },
    ],
    sessionTtlSeconds: 600,
    sqlitePath: path.join(tmpDir, "partner.sqlite"),
    logLevel: "WARN",
    cookieSecret: randomBytes(32).toString("base64"),
  };

  const partner = await startPartner({
    config: partnerCfg,
    balanceReaders: {
      besu: { read: async () => "0" },
      ethereum: { read: async () => "0" },
    },
  });
  stopPartner = partner.shutdown;
}, TIMEOUT);

afterAll(async () => {
  if (stopPartner) await stopPartner();
  if (cbHttpServer)
    await new Promise<void>((r, j) =>
      cbHttpServer!.close((e) => (e ? j(e) : r())),
    );
  if (gatewayShutdown) await gatewayShutdown();
  if (cbDb) cbDb.close();
  if (besuEnv) await besuEnv.tearDown();
  if (ethEnv) await ethEnv.tearDown();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}, TIMEOUT);

describe("CBDC backend with real SATP gateway", () => {
  it(
    "moves tokens Besu -> Ethereum via partner HTTP",
    async () => {
      const base = `http://localhost:${PARTNER_PORT}`;
      const login = await axios.post(
        `${base}/auth/login`,
        { taxId: "999", password: "pw" },
        { validateStatus: () => true },
      );
      expect(login.status).toBe(200);
      const cookie = (login.headers["set-cookie"] as string[])
        .map((c) => c.split(";")[0])
        .join("; ");

      const tx = await axios.post(
        `${base}/transactions`,
        {
          sourceChain: "besu",
          destinationChain: "ethereum",
          receiverAddress: ethEnv.getTestOwnerAccount(),
          amount: 100,
          complianceProviders: [],
          timeToExpireSeconds: 600,
        },
        { headers: { cookie }, validateStatus: () => true },
      );

      expect(tx.status).toBe(201);
      expect(tx.data.controllerTransactionId).toBeTruthy();

      // Source balance drained
      await besuEnv.checkBalance(
        besuEnv.getTestFungibleContractName(),
        besuEnv.getTestFungibleContractAddress(),
        besuEnv.getTestFungibleContractAbi(),
        besuEnv.getTestOwnerAccount(),
        "0",
        besuEnv.getTestOwnerSigningCredential(),
      );

      // Destination credited: controller scales receiver by * 1e6
      // (cbdc-controller.ts performSATPTransfer): floor(100 * 1.5 * 1e6) = 150_000_000
      await ethEnv.checkBalance(
        ethEnv.getTestFungibleContractName(),
        ethEnv.getTestFungibleContractAddress(),
        ethEnv.getTestFungibleContractAbi(),
        ethEnv.getTestOwnerAccount(),
        "150000000",
        ethEnv.getTestOwnerSigningCredential(),
      );
    },
    TIMEOUT,
  );
});
