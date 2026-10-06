/**
 * End-to-end CBDC transaction benchmark.
 *
 * Brings up the full example stack exactly like `all-in-one.ts` (Besu + Geth
 * ledgers, SATP Hermes gateway, the PluginCBDCController central bank, and a
 * partner Express app) and then drives the *whole* CBDC transaction flow over
 * the partner HTTP API using the generated OpenAPI client:
 *
 *   1. POST /auth/login          (once, as a seeded user)
 *   2. POST /transactions  x N   (besu -> ethereum)
 *
 * `POST /transactions` runs synchronously through the central bank
 * (FX quote -> compliance -> SATP transfer) and only returns once the transfer
 * has settled, so the round-trip time of that call is the whole-transaction
 * time.
 *
 * In addition, the `ILedgerEnvironment.transact` hook on the Besu side is
 * instrumented so that, for every transaction, we also capture:
 *   - approve  : the on-chain allowance the sender grants the SATP wrapper
 *   - transact : the SATP gateway cross-chain transfer (dispatcher Transact)
 *
 * Final report aggregates min / max / mean / median / p95 / total and
 * throughput for the whole transaction as well as the approve and transact
 * sub-phases.
 *
 * A second experiment isolates the compliance phase. Artificial compliance
 * providers that sleep for a fixed delay before answering are registered with
 * the central bank, and transactions are submitted against N of them for every
 * (delay, N) combination. The controller calls the providers of a transaction
 * in parallel, so the phase should cost ~max(delay) rather than sum(delay);
 * the report puts the measured phase next to the sequential cost to show it.
 * The phase is timed inside the central bank, between the store write that
 * enters COMPLIANCE_CHECKS and the one that records the aggregated verdict.
 * The artificial providers answer MARKED_FOR_REVIEW, which parks the
 * transaction right after the compliance phase, so this experiment does not
 * pay for a SATP transfer per sample.
 *
 * Run with:
 *   yarn benchmark
 *   BENCH_ITERATIONS=50 BENCH_AMOUNT=1 yarn benchmark
 *   BENCH_COMPLIANCE_DELAYS=100,500,1000 BENCH_COMPLIANCE_PROVIDERS=1,2,4,8 \
 *     BENCH_COMPLIANCE_ITERATIONS=5 yarn benchmark
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import express from "express";
import axios, { AxiosInstance } from "axios";
import { randomBytes } from "node:crypto";
import {
  ComplianceResult,
  generatePartnerSecret,
  IGetComplianceCheckResponse,
  ILedgerEnvironment,
  ITransaction,
  NonceCache,
  parseEnvelope,
  PluginCBDCController,
  signResponse,
  TransactionStatus,
  TransactionStore,
  verifyRequest,
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
import { IChainRuntimeConfig, IPartnerConfig } from "../config/types";
import { ChainCode } from "../types";

import {
  AuthApi,
  TransactionsApi,
  ChainCode as ApiChainCode,
} from "../generated/openapi/typescript-axios";

const CONTRACT_NAME = "SATPContract";

const CONTROLLER_ID = "cb-shared";
const CB_PORT = 4100;
const PARTNER_A_PORT = 5100;
const COMPLIANCE_SIM_PORT = 5190;
const FX_RATE = 1.5;

// Tunables (overridable via env vars).
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
const AMOUNT_PER_TRANSACTION = Number(process.env.BENCH_AMOUNT ?? 1);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1);

const numberList = (raw: string | undefined, fallback: number[]) =>
  raw === undefined
    ? fallback
    : raw
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x >= 0);

// Compliance experiment: artificial provider latencies, how many providers a
// transaction fans out to, and samples per (delay, providers) combination.
const COMPLIANCE_DELAYS_MS = numberList(
  process.env.BENCH_COMPLIANCE_DELAYS,
  [100, 500, 1000],
);
const COMPLIANCE_PROVIDER_COUNTS = numberList(
  process.env.BENCH_COMPLIANCE_PROVIDERS,
  [1, 2, 4, 8],
).filter((n) => n >= 1);
const COMPLIANCE_ITERATIONS = Number(
  process.env.BENCH_COMPLIANCE_ITERATIONS ?? 5,
);

// The seeded user we log in as (see seedUsers below).
const SEED_USER = { taxId: "111", password: "demo", displayName: "Alice" };

// ---------------------------------------------------------------- timing utils

/** High-resolution stopwatch returning elapsed milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, value };
}

interface Stats {
  count: number;
  total: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((acc, x) => acc + x, 0);
  const quantile = (q: number) =>
    n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
  return {
    count: n,
    total,
    min: n ? sorted[0] : 0,
    max: n ? sorted[n - 1] : 0,
    mean: n ? total / n : 0,
    median: quantile(0.5),
    p95: quantile(0.95),
  };
}

const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

function printStats(label: string, samples: number[]): void {
  const s = computeStats(samples);
  const throughput = s.total > 0 ? (s.count / (s.total / 1000)).toFixed(2) : "n/a";
  console.log(`\n  ${label} (${s.count} samples)`);
  console.log(`    total   : ${fmt(s.total)}`);
  console.log(`    mean    : ${fmt(s.mean)}`);
  console.log(`    median  : ${fmt(s.median)}`);
  console.log(`    p95     : ${fmt(s.p95)}`);
  console.log(`    min/max : ${fmt(s.min)} / ${fmt(s.max)}`);
  console.log(`    rate    : ${throughput} ops/s`);
}

// ------------------------------------------------- compliance instrumentation

/**
 * Wraps the central bank's transaction store to time the compliance phase
 * from inside the controller, without touching the plugin: the phase starts
 * once the transaction is persisted as COMPLIANCE_CHECKS (FX quote done) and
 * ends when the controller writes back the aggregated compliance result.
 */
class CompliancePhaseTimer extends TransactionStore {
  private readonly startedAt = new Map<string, bigint>();
  private samples: number[] = [];

  constructor(private readonly inner: TransactionStore) {
    super();
  }

  save(transaction: ITransaction): Promise<void> {
    return this.inner.save(transaction);
  }

  get(transactionId: string): Promise<ITransaction | null> {
    return this.inner.get(transactionId);
  }

  delete(transactionId: string): Promise<void> {
    return this.inner.delete(transactionId);
  }

  async update(transactionId: string, update: ITransaction): Promise<void> {
    const startedAt = this.startedAt.get(transactionId);
    if (startedAt !== undefined && update.complianceResult !== undefined) {
      this.samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      this.startedAt.delete(transactionId);
    }
    await this.inner.update(transactionId, update);
    if (
      update.status === TransactionStatus.COMPLIANCE_CHECKS &&
      update.complianceResult === undefined
    ) {
      this.startedAt.set(transactionId, process.hrtime.bigint());
    }
  }

  /** Returns the phase durations collected since the last call. */
  drain(): number[] {
    const drained = this.samples;
    this.samples = [];
    return drained;
  }
}

interface SimulatedProvider {
  id: string;
  delayMs: number;
  apiKey: string;
}

interface ComplianceSimulator {
  server: http.Server;
  urlFor(providerId: string): string;
  /** Highest number of checks in flight at once since the last call. */
  takePeakInFlight(): number;
}

/**
 * One HTTP server hosting every artificial compliance provider under
 * /compliance/:providerId. Each provider verifies the signed request, sleeps
 * for its configured delay and answers MARKED_FOR_REVIEW.
 */
async function startComplianceSimulator(
  providers: SimulatedProvider[],
): Promise<ComplianceSimulator> {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const nonceCache = new NonceCache();
  let inFlight = 0;
  let peakInFlight = 0;

  const app = express();
  app.use(express.json());
  app.post("/compliance/:providerId", async (req, res) => {
    const provider = byId.get(req.params.providerId);
    if (!provider) {
      res.status(404).json({ error: "unknown provider" });
      return;
    }
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      const verified = verifyRequest<{ transactionId: string }>(
        parseEnvelope(req.body),
        (senderId) =>
          senderId === CONTROLLER_ID ? { apiKey: provider.apiKey } : null,
        nonceCache,
      );
      await new Promise((r) => setTimeout(r, provider.delayMs));
      const response: IGetComplianceCheckResponse = {
        transactionId: verified.payload.transactionId,
        result: ComplianceResult.MARKED_FOR_REVIEW,
      };
      res.json(
        signResponse(provider.id, provider.apiKey, verified.nonce, response),
      );
    } catch (e) {
      res.status(401).json({ error: (e as Error).message });
    } finally {
      inFlight--;
    }
  });

  const server = app.listen(COMPLIANCE_SIM_PORT);
  await new Promise<void>((r) => server.on("listening", r));
  return {
    server,
    urlFor: (providerId) =>
      `http://localhost:${COMPLIANCE_SIM_PORT}/compliance/${providerId}`,
    takePeakInFlight: () => {
      const peak = peakInFlight;
      peakInFlight = 0;
      return peak;
    },
  };
}

interface ComplianceScenarioResult {
  label: string;
  providers: number;
  /** Phase cost if the providers were called one after the other. */
  sequentialMs: number;
  /** Phase cost of an ideal parallel fan-out (the slowest provider). */
  parallelMs: number;
  phaseSamples: number[];
  peakInFlight: number;
}

interface SatpTiming {
  approveMs: number;
  transactMs: number;
}

interface SeedUserSpec {
  taxId: string;
  password: string;
  displayName: string;
}

interface StartedStack {
  besuEnv: LocalBesuEnvironment;
  ethEnv: LocalEthereumEnvironment;
  satpGateway: Awaited<ReturnType<typeof startSatpGateway>>;
  cbServer: http.Server;
  cbDb: ReturnType<typeof openDatabase>;
  partnerA: Awaited<ReturnType<typeof startPartner>>;
  complianceServer: http.Server;
}

// ---------------------------------------------------------------- benchmark

async function runBenchmark(runtimeDir: string): Promise<StartedStack> {
  const setupTimings: Record<string, number> = {};
  // One entry pushed per Besu source transfer (== per CBDC transaction).
  const satpTimings: SatpTiming[] = [];

  // ----- ledgers -----

  console.log("[benchmark] starting Besu ledger...");
  const besu = await timed(() =>
    LocalBesuEnvironment.start({
      logLevel: "INFO",
      contractName: CONTRACT_NAME,
      claimFormat: ClaimFormat.BUNGEE,
    }),
  );
  setupTimings["besu boot + deploy"] = besu.ms;
  const besuEnv = besu.value;
  console.log(`[benchmark] Besu ready (${fmt(besu.ms)})`);

  console.log("[benchmark] starting Ethereum (geth) ledger...");
  const eth = await timed(() =>
    LocalEthereumEnvironment.start({
      logLevel: "INFO",
      contractName: CONTRACT_NAME,
      claimFormat: ClaimFormat.BUNGEE,
    }),
  );
  setupTimings["geth boot + deploy"] = eth.ms;
  const ethEnv = eth.value;
  console.log(`[benchmark] Ethereum ready (${fmt(eth.ms)})`);

  // ----- CBDC controller + SATP gateway wiring (mirrors all-in-one) -----

  let dispatcherTransact: ((req: TransactRequest) => Promise<unknown>) | null =
    null;
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
      // Instrument the two on-chain/cross-chain sub-phases of the transfer.
      const approve = await timed(() =>
        approveBesuAsset!(request.sourceAsset.owner, request.sourceAsset.amount!),
      );
      const transact = await timed(() => dispatcherTransact!(request));
      satpTimings.push({ approveMs: approve.ms, transactMs: transact.ms });
      return transact.value as never;
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
      await approveEthAsset(request.sourceAsset.owner, request.sourceAsset.amount);
      return (await dispatcherTransact(request)) as never;
    },
  };

  const cbDb = openDatabase(path.join(runtimeDir, "cb.sqlite"));
  applyCentralBankMigrations(cbDb);
  const partnersStore = new SqlitePartnersStore(cbDb);
  const complianceEndpointsStore = new SqliteComplianceEndpointsStore(cbDb);
  const transactionStore = new CompliancePhaseTimer(
    new SqliteTransactionStore(cbDb),
  );

  const partnerASecret = generatePartnerSecret();
  await partnersStore.save({ id: "partner-a", apiKey: partnerASecret });

  const cbdcPlugin = new PluginCBDCController({
    instanceId: CONTROLLER_ID,
    controllerId: CONTROLLER_ID,
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

  const ontologyPath = path.resolve(__dirname, "../../json/ontologies");

  console.log("[benchmark] starting SATP Hermes gateway...");
  const gw = await timed(() =>
    startSatpGateway({
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
    }),
  );
  setupTimings["gateway boot"] = gw.ms;
  const satpGateway = gw.value;
  console.log(`[benchmark] gateway ready (${fmt(gw.ms)})`);

  dispatcherTransact = (req) =>
    satpGateway.gateway.BLODispatcherInstance!.Transact(req);

  // ----- provisioning: one seeded user with a wallet on each chain -----

  const besuSigners = new Map<string, string>(); // address -> privateKey
  const ethSigners = new Map<string, string>(); // address -> passphrase

  const provisioning = await timed(async () => {
    const besuAcc = await besuEnv.createAccount();
    const ethAcc = await ethEnv.createAccount();
    besuSigners.set(besuAcc.address.toLowerCase(), besuAcc.privateKey);
    ethSigners.set(ethAcc.address.toLowerCase(), ethAcc.passphrase);

    const seedUser: SeedUserSpec & {
      ledgerAccounts: { besu: string; ethereum: string };
    } = {
      ...SEED_USER,
      ledgerAccounts: { besu: besuAcc.address, ethereum: ethAcc.address },
    };

    // Mint enough on Besu to cover every transfer (incl. warmup) with margin.
    const mintAmount = AMOUNT_PER_TRANSACTION * (ITERATIONS + WARMUP) + 1;
    await besuEnv.mint(mintAmount, besuAcc.address);

    // Grant BRIDGE_ROLE so each SATP wrapper can move funds, and wire the
    // per-transaction approve helpers (signing with each wallet's own creds).
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

    return { seedUser, besuWrapper, ethWrapper };
  });
  setupTimings["provisioning (accounts + mint + roles)"] = provisioning.ms;
  const { seedUser, besuWrapper, ethWrapper } = provisioning.value;
  console.log(`[benchmark] provisioning done (${fmt(provisioning.ms)})`);
  console.log(`[benchmark]   besu sender   : ${seedUser.ledgerAccounts.besu}`);
  console.log(`[benchmark]   eth receiver  : ${seedUser.ledgerAccounts.ethereum}`);

  // ----- central bank HTTP server -----

  const cbApp = express();
  cbApp.use(express.json({ limit: "10mb" }));
  const cbdcExpress = (
    cbdcPlugin as unknown as { webApplication: express.Express }
  ).webApplication;
  cbApp.use("/cbdc", cbdcExpress);
  const cbServer: http.Server = cbApp.listen(CB_PORT);
  await new Promise<void>((r) => cbServer.on("listening", r));
  console.log(`[benchmark] central bank HTTP on :${CB_PORT}`);

  // ----- partner app -----

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
    seedUsers: [seedUser],
    sessionTtlSeconds: 60 * 60,
    sqlitePath: path.join(runtimeDir, "partner-a.sqlite"),
    logLevel: "INFO",
    cookieSecret: randomBytes(32).toString("base64"),
  };

  const partnerA = await startPartner({
    config: partnerACfg,
    balanceReaders: {
      besu: { read: async (account) => besuEnv.getBalance(account) },
      ethereum: { read: async (account) => ethEnv.getBalance(account) },
    },
  });
  console.log(`[benchmark] partner-a HTTP on :${PARTNER_A_PORT}`);

  // ----- drive the whole CBDC transaction flow over the partner API -----

  const partnerBaseUrl = `http://localhost:${PARTNER_A_PORT}`;
  const httpClient: AxiosInstance = axios.create({ baseURL: partnerBaseUrl });
  const authApi = new AuthApi(undefined, partnerBaseUrl, httpClient);
  const txApi = new TransactionsApi(undefined, partnerBaseUrl, httpClient);

  // 1) login — capture the session cookie and attach it to every later call.
  const loginResp = await authApi.login({
    taxId: SEED_USER.taxId,
    password: SEED_USER.password,
  });
  const sessionCookie = (loginResp.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!sessionCookie) throw new Error("login did not return a session cookie");
  httpClient.defaults.headers.common["Cookie"] = sessionCookie;
  console.log(`[benchmark] logged in as taxId=${SEED_USER.taxId}`);

  const createTransaction = (complianceProviders: string[] = []) =>
    txApi.createTransaction({
      sourceChain: ApiChainCode.Besu,
      destinationChain: ApiChainCode.Ethereum,
      receiverAddress: seedUser.ledgerAccounts.ethereum,
      amount: AMOUNT_PER_TRANSACTION,
      complianceProviders,
    });

  // Warmup (not measured) to prime JIT / gateway sessions / connections.
  for (let i = 0; i < WARMUP; i++) {
    console.log(`[benchmark] warmup ${i + 1}/${WARMUP}...`);
    await createTransaction();
  }

  const txSamples: number[] = [];
  const benchStart = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    const { ms, value } = await timed(() => createTransaction());
    txSamples.push(ms);
    console.log(
      `[benchmark] tx ${i + 1}/${ITERATIONS}: whole=${fmt(ms)} ` +
        `status=${value.data.status}`,
    );
  }
  const wallClockMs = Number(process.hrtime.bigint() - benchStart) / 1e6;

  // Compliance phase of the measured transfers: no providers, so this is the
  // fixed cost of the phase itself (skip warmup entries).
  const baselineComplianceSamples = transactionStore.drain().slice(WARMUP);

  // ----- compliance experiment: artificial providers, parallel fan-out -----

  // Enough providers of each latency to serve the largest fan-out; every one
  // is its own partner with its own signing secret.
  const maxProviders = Math.max(1, ...COMPLIANCE_PROVIDER_COUNTS);
  const providerIdsByDelay = new Map<number, string[]>();
  const simulatedProviders: SimulatedProvider[] = [];
  for (const delayMs of COMPLIANCE_DELAYS_MS) {
    const ids: string[] = [];
    for (let i = 0; i < maxProviders; i++) {
      const id = `sim-${delayMs}ms-${i + 1}`;
      ids.push(id);
      simulatedProviders.push({ id, delayMs, apiKey: generatePartnerSecret() });
    }
    providerIdsByDelay.set(delayMs, ids);
  }

  const complianceSim = await startComplianceSimulator(simulatedProviders);
  for (const provider of simulatedProviders) {
    await partnersStore.save({ id: provider.id, apiKey: provider.apiKey });
    await complianceEndpointsStore.save({
      id: provider.id,
      partnerId: provider.id,
      url: complianceSim.urlFor(provider.id),
    });
  }
  console.log(
    `[benchmark] ${simulatedProviders.length} artificial compliance providers ` +
      `on :${COMPLIANCE_SIM_PORT}`,
  );

  const delayOf = new Map(simulatedProviders.map((p) => [p.id, p.delayMs]));
  const scenarios: { label: string; providerIds: string[] }[] = [];
  for (const delayMs of COMPLIANCE_DELAYS_MS) {
    for (const count of COMPLIANCE_PROVIDER_COUNTS) {
      scenarios.push({
        label: `${delayMs} ms`,
        providerIds: providerIdsByDelay.get(delayMs)!.slice(0, count),
      });
    }
  }
  // One provider of each latency: parallel cost is the slowest, not the sum.
  if (COMPLIANCE_DELAYS_MS.length > 1) {
    scenarios.push({
      label: `mixed ${COMPLIANCE_DELAYS_MS.join("/")} ms`,
      providerIds: COMPLIANCE_DELAYS_MS.map(
        (delayMs) => providerIdsByDelay.get(delayMs)![0],
      ),
    });
  }

  const complianceResults: ComplianceScenarioResult[] = [];
  if (COMPLIANCE_ITERATIONS > 0 && scenarios.length > 0) {
    // Unmeasured request to prime the simulator and the controller's client.
    await createTransaction(scenarios[0].providerIds.slice(0, 1));
    transactionStore.drain();
    complianceSim.takePeakInFlight();

    for (const scenario of scenarios) {
      for (let i = 0; i < COMPLIANCE_ITERATIONS; i++) {
        await createTransaction(scenario.providerIds);
      }
      const delays = scenario.providerIds.map((id) => delayOf.get(id)!);
      const result: ComplianceScenarioResult = {
        label: scenario.label,
        providers: scenario.providerIds.length,
        sequentialMs: delays.reduce((acc, d) => acc + d, 0),
        parallelMs: Math.max(...delays),
        phaseSamples: transactionStore.drain(),
        peakInFlight: complianceSim.takePeakInFlight(),
      };
      complianceResults.push(result);
      console.log(
        `[benchmark] compliance ${result.label} x${result.providers}: ` +
          `mean=${fmt(computeStats(result.phaseSamples).mean)}`,
      );
    }
  }

  // SATP sub-phase samples for the measured transactions (skip warmup entries).
  const measuredSatp = satpTimings.slice(WARMUP);
  const approveSamples = measuredSatp.map((t) => t.approveMs);
  const transactSamples = measuredSatp.map((t) => t.transactMs);

  // ----- report -----

  console.log("\n========================================");
  console.log("  CBDC end-to-end transaction benchmark");
  console.log("========================================");
  console.log(`  iterations : ${ITERATIONS} (after ${WARMUP} warmup)`);
  console.log(
    `  amount/tx  : ${AMOUNT_PER_TRANSACTION} BESU -> ` +
      `${Math.floor(AMOUNT_PER_TRANSACTION * FX_RATE)} ETH`,
  );

  console.log("\n  Setup phases:");
  for (const [phase, ms] of Object.entries(setupTimings)) {
    console.log(`    ${phase.padEnd(38)} ${fmt(ms)}`);
  }

  printStats("whole transaction (POST /transactions round-trip)", txSamples);
  printStats("  └─ approve (sender -> wrapper allowance)", approveSamples);
  printStats("  └─ transact (SATP gateway cross-chain)", transactSamples);
  printStats(
    "  └─ compliance phase (no providers)",
    baselineComplianceSamples,
  );

  console.log(
    `\n  Wall-clock for ${ITERATIONS} transactions: ${fmt(wallClockMs)} ` +
      `(${(ITERATIONS / (wallClockMs / 1000)).toFixed(2)} tx/s)`,
  );

  if (complianceResults.length > 0) {
    console.log(
      `\n  Compliance phase vs. provider latency and fan-out ` +
        `(${COMPLIANCE_ITERATIONS} samples each)`,
    );
    console.log(
      "    sequential = sum of provider delays, parallel = slowest provider;",
    );
    console.log(
      "    overhead = mean - parallel, speedup = sequential / mean\n",
    );
    const columns = [
      "provider delay",
      "providers",
      "mean",
      "median",
      "p95",
      "parallel",
      "sequential",
      "overhead",
      "speedup",
      "peak in-flight",
    ];
    const rows = complianceResults.map((r) => {
      const s = computeStats(r.phaseSamples);
      return [
        r.label,
        String(r.providers),
        fmt(s.mean),
        fmt(s.median),
        fmt(s.p95),
        fmt(r.parallelMs),
        fmt(r.sequentialMs),
        fmt(s.mean - r.parallelMs),
        s.mean > 0 ? `${(r.sequentialMs / s.mean).toFixed(2)}x` : "n/a",
        String(r.peakInFlight),
      ];
    });
    const widths = columns.map((c, i) =>
      Math.max(c.length, ...rows.map((row) => row[i].length)),
    );
    const line = (cells: string[]) =>
      "    " +
      cells
        .map((cell, i) =>
          i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
        )
        .join("  ");
    console.log(line(columns));
    console.log(line(widths.map((w) => "-".repeat(w))));
    for (const row of rows) console.log(line(row));
  }
  console.log("========================================\n");

  return {
    besuEnv,
    ethEnv,
    satpGateway,
    cbServer,
    cbDb,
    partnerA,
    complianceServer: complianceSim.server,
  };
}

async function main() {
  // SATP knex repos use NODE_ENV / ENVIRONMENT to pick a config key.
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "default";
  if (!process.env.ENVIRONMENT) process.env.ENVIRONMENT = "default";

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbdc-benchmark-"));
  console.log(`[benchmark] runtime dir: ${runtimeDir}`);
  console.log(
    `[benchmark] config: iterations=${ITERATIONS} amount=${AMOUNT_PER_TRANSACTION} ` +
      `warmup=${WARMUP} fxRate=${FX_RATE}`,
  );
  console.log(
    `[benchmark] compliance: delays=[${COMPLIANCE_DELAYS_MS.join(",")}]ms ` +
      `providers=[${COMPLIANCE_PROVIDER_COUNTS.join(",")}] ` +
      `iterations=${COMPLIANCE_ITERATIONS}`,
  );

  let started: StartedStack | null = null;
  try {
    started = await runBenchmark(runtimeDir);
  } finally {
    console.log("[benchmark] shutting down...");
    if (started) {
      await started.partnerA.shutdown().catch((e) => console.error(e));
      await new Promise<void>((res) => started!.cbServer.close(() => res()));
      await new Promise<void>((res) =>
        started!.complianceServer.close(() => res()),
      );
      await started.satpGateway.shutdown().catch((e) => console.error(e));
      started.cbDb.close();
      await started.besuEnv.tearDown().catch((e) => console.error(e));
      await started.ethEnv.tearDown().catch((e) => console.error(e));
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    console.log("[benchmark] done.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[benchmark] fatal:", err);
    process.exit(1);
  });
