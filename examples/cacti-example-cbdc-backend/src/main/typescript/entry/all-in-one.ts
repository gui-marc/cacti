/**
 * All-in-one orchestrator: brings up the full CBDC example stack from a
 * single Node process.
 *
 *   - Starts Besu + Geth ledger containers via the local
 *     LocalBesuEnvironment / LocalEthereumEnvironment classes
 *   - Deploys SATPTokenContract on each chain
 *   - Starts one SATP Hermes gateway
 *   - Starts one PluginCBDCController (acts as both central banks)
 *   - Starts partner-a and partner-b Express apps
 *   - Provisions a fresh on-chain account per seed user, mints starting
 *     balances, and grants BRIDGE_ROLE so partners can transact
 *
 * Run with:
 *   yarn all-in-one
 *
 * Then point a frontend at http://localhost:5100 (partner-a) or
 * http://localhost:5200 (partner-b). Seeded credentials are printed at boot.
 */

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

import { LocalBesuEnvironment } from "../infrastructure/besu-environment";
import { LocalEthereumEnvironment } from "../infrastructure/ethereum-environment";

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

const PER_USER_MINT = 10_000;

interface SeedUserSpec {
  taxId: string;
  password: string;
  displayName: string;
}

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
  const besuEnv = await LocalBesuEnvironment.start({
    logLevel: "INFO",
    contractName: CONTRACT_NAME,
    claimFormat: ClaimFormat.BUNGEE,
  });
  console.log("[all-in-one] Besu ready");

  console.log("[all-in-one] starting Ethereum (geth) ledger...");
  const ethEnv = await LocalEthereumEnvironment.start({
    logLevel: "INFO",
    contractName: CONTRACT_NAME,
    claimFormat: ClaimFormat.BUNGEE,
  });
  console.log("[all-in-one] Ethereum ready");

  // ----- CBDC controller + SATP gateway -----

  let dispatcherTransact: ((req: TransactRequest) => Promise<unknown>) | null =
    null;
  // Per-transaction allowance helpers, wired once the SATP wrapper addresses
  // are known (see the GetApproveAddress calls below). Each one makes the asset
  // `owner` wallet approve the SATP wrapper for exactly the amount it is about
  // to lock, signing with that wallet's own credentials.
  let approveBesuAsset:
    | ((owner: string, amount: string | number) => Promise<void>)
    | null = null;
  let approveEthAsset:
    | ((owner: string, amount: string | number) => Promise<void>)
    | null = null;

  const besuCBDCEnv: ILedgerEnvironment = {
    getAsset(account, amount): TransactRequestSourceAsset {
      return {
        contractName: besuEnv.getContractName(),
        contractAddress: besuEnv.getContractAddress(),
        ercTokenStandard: "ERC20",
        id: besuEnv.defaultAsset.id,
        networkId: besuEnv.network,
        tokenType: TokenType.Fungible,
        // The asset is owned by the wallet the controller is transferring for
        // (the sender on the source chain / the receiver on the destination
        // chain), not the genesis account.
        owner: account,
        referenceId: besuEnv.defaultAsset.referenceId,
        amount: amount.toString(),
      } as TransactRequestSourceAsset;
    },
    async transact(request) {
      if (!dispatcherTransact || !approveBesuAsset)
        throw new Error("Gateway not ready");
      if (request.sourceAsset.amount === undefined)
        throw new Error("Source asset amount missing");
      // Have the sender wallet approve the SATP wrapper to pull exactly this
      // transfer's amount before routing it through the gateway.
      await approveBesuAsset(
        request.sourceAsset.owner,
        request.sourceAsset.amount,
      );
      return (await dispatcherTransact(request)) as never;
    },
  };

  const ethCBDCEnv: ILedgerEnvironment = {
    getAsset(account, amount): TransactRequestSourceAsset {
      return {
        contractName: ethEnv.getContractName(),
        contractAddress: ethEnv.getContractAddress(),
        ercTokenStandard: "ERC20",
        id: ethEnv.defaultAsset.id,
        networkId: ethEnv.network,
        tokenType: TokenType.Fungible,
        // The asset is owned by the wallet the controller is transferring for
        // (the sender on the source chain / the receiver on the destination
        // chain), not the whale account.
        owner: account,
        referenceId: ethEnv.defaultAsset.referenceId,
        amount: amount.toString(),
      } as TransactRequestSourceAsset;
    },
    async transact(request) {
      if (!dispatcherTransact || !approveEthAsset)
        throw new Error("Gateway not ready");
      if (request.sourceAsset.amount === undefined)
        throw new Error("Source asset amount missing");
      // Have the sender wallet approve the SATP wrapper to pull exactly this
      // transfer's amount before routing it through the gateway.
      await approveEthAsset(
        request.sourceAsset.owner,
        request.sourceAsset.amount,
      );
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

  // ----- per-user account provisioning + mint + grant + approve -----

  const seedUserSpecsA: SeedUserSpec[] = [
    { taxId: "111", password: "demo", displayName: "Alice" },
    { taxId: "222", password: "demo", displayName: "Bob" },
  ];
  const seedUserSpecsB: SeedUserSpec[] = [
    { taxId: "333", password: "demo", displayName: "Carol" },
  ];

  // Signing credentials for the per-user wallets, keyed by lower-cased address.
  // The transact hooks use these to make the sender approve the SATP wrapper.
  const besuSigners = new Map<string, string>(); // address -> privateKey
  const ethSigners = new Map<string, string>(); // address -> passphrase

  // Spin up a dedicated wallet on each chain for every seed user.
  const provisionSeedUsers = async (specs: SeedUserSpec[]) => {
    const result = [];
    for (const spec of specs) {
      const besuAcc = await besuEnv.createAccount();
      const ethAcc = await ethEnv.createAccount();
      besuSigners.set(besuAcc.address.toLowerCase(), besuAcc.privateKey);
      ethSigners.set(ethAcc.address.toLowerCase(), ethAcc.passphrase);
      result.push({
        ...spec,
        ledgerAccounts: {
          besu: besuAcc.address,
          ethereum: ethAcc.address,
        },
      });
    }
    return result;
  };

  const seedUsersA = await provisionSeedUsers(seedUserSpecsA);
  const seedUsersB = await provisionSeedUsers(seedUserSpecsB);

  // Mint per-user starting balance on Besu (the origin chain).
  const allUsers = [...seedUsersA, ...seedUsersB];
  for (const user of allUsers) {
    await besuEnv.mint(PER_USER_MINT, user.ledgerAccounts.besu);
  }

  // Grant BRIDGE_ROLE so each SATP wrapper can move funds. The allowance is
  // set per-transaction inside the ILedgerEnvironment.transact hooks above, so
  // the wrapper only ever holds an allowance for the amount it is about to
  // pull.
  const besuWrapper = (
    await satpGateway.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await besuEnv.grantBridgeRole(besuWrapper);
  approveBesuAsset = (owner, amount) => {
    const secret = besuSigners.get(owner.toLowerCase());
    if (!secret) throw new Error(`No Besu signing key for wallet ${owner}`);
    return besuEnv.approve(besuWrapper, amount, { ethAccount: owner, secret });
  };

  const ethWrapper = (
    await satpGateway.gateway.BLODispatcherInstance!.GetApproveAddress({
      networkId: ethEnv.network,
      tokenType: TokenType.Fungible,
    })
  ).approveAddress;
  await ethEnv.grantBridgeRole(ethWrapper);
  approveEthAsset = (owner, amount) => {
    const passphrase = ethSigners.get(owner.toLowerCase());
    if (!passphrase)
      throw new Error(`No Ethereum signing key for wallet ${owner}`);
    return ethEnv.approve(ethWrapper, amount, {
      ethAccount: owner,
      passphrase,
    });
  };

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
      rpcHttpUrl: "",
      rpcWsUrl: "",
      cbdcContract: {
        contractName: besuEnv.getContractName(),
        contractAddress: besuEnv.getContractAddress(),
        ownerAddress: besuEnv.getOwnerAccount(),
        ownerPrivateKey: "",
      },
      satpWrapperAddress: besuWrapper,
    },
    ethereum: {
      chainCode: "ethereum",
      networkId: ethEnv.network.id,
      rpcHttpUrl: "",
      rpcWsUrl: "",
      cbdcContract: {
        contractName: ethEnv.getContractName(),
        contractAddress: ethEnv.getContractAddress(),
        ownerAddress: ethEnv.getOwnerAccount(),
        ownerPrivateKey: "",
      },
      satpWrapperAddress: ethWrapper,
    },
  };

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
      besu: { read: async (account) => besuEnv.getBalance(account) },
      ethereum: { read: async (account) => ethEnv.getBalance(account) },
    },
  });
  const partnerB = await startPartner({
    config: partnerBCfg,
    balanceReaders: {
      besu: { read: async (account) => besuEnv.getBalance(account) },
      ethereum: { read: async (account) => ethEnv.getBalance(account) },
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
  for (const u of seedUsersA) {
    console.log(`  partner-a: taxId=${u.taxId} (${u.displayName})`);
    console.log(`    besu=${u.ledgerAccounts.besu} eth=${u.ledgerAccounts.ethereum}`);
  }
  for (const u of seedUsersB) {
    console.log(`  partner-b: taxId=${u.taxId} (${u.displayName})`);
    console.log(`    besu=${u.ledgerAccounts.besu} eth=${u.ledgerAccounts.ethereum}`);
  }
  console.log(`\nFX rate: 1 BESU = ${FX_RATE} ETH`);
  console.log(`Initial supply: ${PER_USER_MINT} CBDC minted per user on Besu`);
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
