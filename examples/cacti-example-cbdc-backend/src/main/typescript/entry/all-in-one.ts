/**
 * All-in-one orchestrator: brings up the full CBDC example stack from a
 * single Node process.
 *
 *   - Starts Besu + Geth ledger containers via test-tooling
 *   - Deploys SATPTokenContract + SATPWrapperContract on each chain
 *   - Starts one SATP Hermes gateway
 *   - Starts one PluginCBDCController (acts as both central banks)
 *   - Starts partner-a and partner-b Express apps
 *   - Mints starting balances + grants BRIDGE_ROLE so partners can transact
 *
 * Run with:
 *   yarn all-in-one
 *
 * Then point a frontend at http://localhost:5100 (partner-a) or
 * http://localhost:5200 (partner-b). Seeded credentials are printed at boot.
 */

// Must be first: stubs `@jest/globals` so the plugin's test-env helpers
// load outside Jest.
import "./jest-globals-shim";

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import express from "express";
import exitHook from "async-exit-hook";
import { randomBytes } from "node:crypto";
import {
  generatePartnerSecret,
  ILedgerEnvironment,
  PluginCBDCController,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import {
  ClaimFormat,
  TokenType,
  TransactRequest,
  TransactRequestSourceAsset,
} from "@hyperledger/cactus-plugin-satp-hermes";

import {
  BesuTestEnvironment,
  SupportedContractTypes as BesuContractTypes,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller/dist/lib/test/typescript/dummy-environment/besu-environment";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as EthContractTypes,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller/dist/lib/test/typescript/dummy-environment/ethereum-environment";

import {
  applyCentralBankMigrations,
  openDatabase,
} from "../store/sqlite/db";
import { SqliteTransactionStore } from "../store/sqlite/sqlite-transaction-store";
import { SqlitePartnersStore } from "../store/sqlite/sqlite-partners-store";
import { SqliteComplianceEndpointsStore } from "../store/sqlite/sqlite-compliance-endpoints-store";
import { ConstantFxProvisionStrategy } from "../central-bank/constant-fx-provision-strategy";
import { startSatpGateway } from "../infrastructure/satp-gateway";
import { startPartner } from "../partner/partner-app";
import {
  IChainRuntimeConfig,
  IPartnerConfig,
} from "../config/types";
import { ChainCode } from "../types";

const CONTRACT_NAME = "SATPContract";

const CB_PORT = 4100;
const PARTNER_A_PORT = 5100;
const PARTNER_B_PORT = 5200;
const FX_RATE = 1.5;

async function main() {
  // SATP knex repos use NODE_ENV / ENVIRONMENT to pick a config key; the
  // bundled knexfile only ships "default".
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "default";
  if (!process.env.ENVIRONMENT) process.env.ENVIRONMENT = "default";

  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cbdc-all-in-one-"),
  );
  console.log(`[all-in-one] runtime dir: ${runtimeDir}`);

  console.log("[all-in-one] starting Besu ledger...");
  const besuEnv = await BesuTestEnvironment.setupTestEnvironment(
    { logLevel: "INFO" },
    [{ assetType: BesuContractTypes.FUNGIBLE, contractName: CONTRACT_NAME }],
  );
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  console.log("[all-in-one] Besu ready");

  console.log("[all-in-one] starting Ethereum (geth) ledger...");
  const ethEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel: "INFO" },
    [{ assetType: EthContractTypes.FUNGIBLE, contractName: CONTRACT_NAME }],
  );
  await ethEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  console.log("[all-in-one] Ethereum ready");

  // ----- CBDC controller + SATP gateway -----

  let dispatcherTransact: ((req: TransactRequest) => Promise<unknown>) | null =
    null;

  const besuCBDCEnv: ILedgerEnvironment = {
    getAsset(_id, amount): TransactRequestSourceAsset {
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
    async transact(request) {
      if (!dispatcherTransact) throw new Error("Gateway not ready");
      return (await dispatcherTransact(request)) as never;
    },
  };

  const ethCBDCEnv: ILedgerEnvironment = {
    getAsset(_id, amount): TransactRequestSourceAsset {
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
    async transact(request) {
      if (!dispatcherTransact) throw new Error("Gateway not ready");
      return (await dispatcherTransact(request)) as never;
    },
  };

  const cbDb = openDatabase(path.join(runtimeDir, "cb.sqlite"));
  applyCentralBankMigrations(cbDb);
  const partnersStore = new SqlitePartnersStore(cbDb);
  const complianceEndpointsStore = new SqliteComplianceEndpointsStore(cbDb);
  const transactionStore = new SqliteTransactionStore(cbDb);

  const partnerASecret = generatePartnerSecret();
  const partnerBSecret = generatePartnerSecret();
  await partnersStore.save({ id: "partner-a", apiKey: partnerASecret });
  await partnersStore.save({ id: "partner-b", apiKey: partnerBSecret });

  const cbdcPlugin = new PluginCBDCController({
    instanceId: "cb-shared",
    controllerId: "cb-shared",
    partnersStore,
    complianceEndpointsStore,
    transactionStore,
    fxProvisionStrategy: new ConstantFxProvisionStrategy(FX_RATE),
    environments: { besu: besuCBDCEnv, ethereum: ethCBDCEnv },
    logLevel: "INFO",
    requireHttps: false,
    requireClientAuth: true,
  });
  await cbdcPlugin.onPluginInit();

  const ontologyPath = path.resolve(
    __dirname,
    "../../json/ontologies",
  );

  console.log("[all-in-one] starting SATP Hermes gateway...");
  const satpGateway = await startSatpGateway({
    gatewayConfig: {
      baseUrl: "http://localhost",
      serverPort: 3010,
      clientPort: 3011,
      gatewayId: "cb-shared-gateway",
    },
    bridgeConfig: [besuEnv.createBesuConfig(), ethEnv.createEthereumConfig()],
    ontologyPath,
    plugins: [cbdcPlugin],
    logLevel: "INFO",
  });
  dispatcherTransact = (req) =>
    satpGateway.gateway.BLODispatcherInstance!.Transact(req);

  // ----- mint + grant + approve so transfers can actually happen -----

  const initialMint = 1_000_000;
  await besuEnv.mintTokens(initialMint.toString(), TokenType.Fungible);
  const besuWrapper = (
    await satpGateway.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await besuEnv.giveRoleToBridge(besuWrapper);
  await besuEnv.approveAssets(
    besuWrapper,
    initialMint.toString(),
    TokenType.Fungible,
  );

  const ethWrapper = (
    await satpGateway.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: ethEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await ethEnv.giveRoleToBridge(ethWrapper);

  // ----- mount CBDC plugin on an Express server -----

  const cbApp = express();
  cbApp.use(express.json({ limit: "10mb" }));
  const cbdcExpress = (cbdcPlugin as unknown as { webApplication: express.Express })
    .webApplication;
  cbApp.use("/cbdc", cbdcExpress);
  cbApp.get("/health", (_req, res) =>
    res.json({ status: "ok", role: "central-bank" }),
  );
  const cbServer: http.Server = cbApp.listen(CB_PORT);
  await new Promise<void>((r) => cbServer.on("listening", r));
  console.log(`[all-in-one] central bank HTTP on :${CB_PORT}`);

  // ----- partners -----

  const chains: Record<ChainCode, IChainRuntimeConfig> = {
    besu: {
      chainCode: "besu",
      networkId: besuEnv.network.id,
      rpcHttpUrl: "n/a",
      rpcWsUrl: "n/a",
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
      rpcHttpUrl: "n/a",
      rpcWsUrl: "n/a",
      cbdcContract: {
        contractName: ethEnv.getTestFungibleContractName(),
        contractAddress: ethEnv.getTestFungibleContractAddress(),
        ownerAddress: ethEnv.getTestOwnerAccount(),
        ownerPrivateKey: "",
      },
      satpWrapperAddress: ethWrapper,
    },
  };

  const seedUsersA = [
    {
      taxId: "111",
      password: "demo",
      displayName: "Alice (Bank A)",
      ledgerAccounts: {
        besu: besuEnv.getTestOwnerAccount(),
        ethereum: ethEnv.getTestOwnerAccount(),
      },
    },
    {
      taxId: "222",
      password: "demo",
      displayName: "Bob (Bank A)",
      ledgerAccounts: {
        besu: besuEnv.getTestOwnerAccount(),
        ethereum: ethEnv.getTestOwnerAccount(),
      },
    },
  ];
  const seedUsersB = [
    {
      taxId: "333",
      password: "demo",
      displayName: "Carol (Bank B)",
      ledgerAccounts: {
        besu: besuEnv.getTestOwnerAccount(),
        ethereum: ethEnv.getTestOwnerAccount(),
      },
    },
  ];

  const partnerACfg: IPartnerConfig = {
    role: "partner",
    partnerId: "partner-a",
    instanceId: "partner-a",
    httpPort: PARTNER_A_PORT,
    publicBaseUrl: `http://localhost:${PARTNER_A_PORT}`,
    centralBanks: [
      { chainCode: "besu", baseUrl: `http://localhost:${CB_PORT}`, apiKey: partnerASecret },
      { chainCode: "ethereum", baseUrl: `http://localhost:${CB_PORT}`, apiKey: partnerASecret },
    ],
    chains,
    seedUsers: seedUsersA,
    sessionTtlSeconds: 60 * 60,
    sqlitePath: path.join(runtimeDir, "partner-a.sqlite"),
    logLevel: "INFO",
    cookieSecret: randomBytes(32).toString("base64"),
  };

  const partnerBCfg: IPartnerConfig = {
    ...partnerACfg,
    partnerId: "partner-b",
    instanceId: "partner-b",
    httpPort: PARTNER_B_PORT,
    publicBaseUrl: `http://localhost:${PARTNER_B_PORT}`,
    centralBanks: [
      { chainCode: "besu", baseUrl: `http://localhost:${CB_PORT}`, apiKey: partnerBSecret },
      { chainCode: "ethereum", baseUrl: `http://localhost:${CB_PORT}`, apiKey: partnerBSecret },
    ],
    seedUsers: seedUsersB,
    sqlitePath: path.join(runtimeDir, "partner-b.sqlite"),
    cookieSecret: randomBytes(32).toString("base64"),
  };

  const partnerA = await startPartner({
    config: partnerACfg,
    balanceReaders: {
      besu: { read: async () => "0" },
      ethereum: { read: async () => "0" },
    },
  });
  const partnerB = await startPartner({
    config: partnerBCfg,
    balanceReaders: {
      besu: { read: async () => "0" },
      ethereum: { read: async () => "0" },
    },
  });

  console.log("\n========================================");
  console.log("  CBDC example stack is up");
  console.log("========================================");
  console.log(`  Central bank:  http://localhost:${CB_PORT}`);
  console.log(`  Partner A:     http://localhost:${PARTNER_A_PORT}`);
  console.log(`  Partner B:     http://localhost:${PARTNER_B_PORT}`);
  console.log(`  SATP gateway:  http://localhost:3010`);
  console.log(`\nSeeded users (password "demo"):`);
  console.log(`  partner-a: taxId=111 (Alice), taxId=222 (Bob)`);
  console.log(`  partner-b: taxId=333 (Carol)`);
  console.log(`\nFX rate: 1 BESU = ${FX_RATE} ETH`);
  console.log(`Initial supply: ${initialMint} CBDC minted on Besu`);
  console.log("\nPress Ctrl-C to shut down.\n");

  exitHook((done: any) => {
    (async () => {
      console.log("[all-in-one] shutting down...");
      try {
        await partnerA.shutdown();
      } catch (e) {
        console.error(e);
      }
      try {
        await partnerB.shutdown();
      } catch (e) {
        console.error(e);
      }
      await new Promise<void>((res) =>
        cbServer.close(() => res()),
      );
      await satpGateway.shutdown();
      cbDb.close();
      await besuEnv.tearDown();
      await ethEnv.tearDown();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      console.log("[all-in-one] done.");
    })().then(done, done);
  });
}

main().catch((err) => {
  console.error("[all-in-one] fatal:", err);
  process.exit(1);
});
