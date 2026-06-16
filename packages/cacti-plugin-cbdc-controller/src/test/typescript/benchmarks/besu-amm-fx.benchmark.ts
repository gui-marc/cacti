import {
  BesuTokenInfo,
  DummyBesuAMMEnvironment,
} from "../fx-provision/besu-amm";
import { BesuAMMFXProvisionStrategy } from "../fx-provision/besu-amm-fx-provision-strategy";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";
import {
  EthContractInvocationType as BesuContractInvocationType,
  PluginLedgerConnectorBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { randomUUID } from "node:crypto";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { LogLevelDesc } from "@hyperledger/cactus-common";

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, value };
}

const USD = "USD";
const EUR = "EUR";
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1);

const logLevel: LogLevelDesc = "DEBUG";

const requestFXQuoteTimings: number[] = [];
const releaseLiquidityTimings: number[] = [];
const confirmSettlementTimings: number[] = [];

let ammEnv: DummyBesuAMMEnvironment;
let ammTokenConnector: PluginLedgerConnectorBesu;
let ammTokenKeychain: PluginKeychainMemory;

async function deployAmmToken(contractName: string): Promise<BesuTokenInfo> {
  await ammTokenKeychain.set(contractName, JSON.stringify(SATPTokenContract));
  const deployRes = await ammTokenConnector.deployContract({
    keychainId: ammTokenKeychain.getKeychainId(),
    contractName,
    contractAbi: SATPTokenContract.abi,
    constructorArgs: [ammEnv.ownerAccount],
    web3SigningCredential: ammEnv.ownerSigningCredential,
    bytecode: SATPTokenContract.bytecode.object,
    gas: 1_000_000,
  });
  const address = deployRes.transactionReceipt.contractAddress;
  if (!address) {
    throw new Error(`Deployment of ${contractName} did not return an address`);
  }
  return { contractName, address, abi: SATPTokenContract.abi };
}

async function mintAmmToken(
  token: BesuTokenInfo,
  account: string,
  amount: number,
): Promise<void> {
  await ammTokenConnector.invokeContract({
    contractName: token.contractName,
    contractAddress: token.address,
    contractAbi: token.abi,
    invocationType: BesuContractInvocationType.Send,
    methodName: "mint",
    params: [account, amount],
    signingCredential: ammEnv.ownerSigningCredential,
    gas: 1_000_000,
  });
}

async function run() {
  ammEnv = new DummyBesuAMMEnvironment({ logLevel: "DEBUG" });
  await ammEnv.init();
  await ammEnv.deployAndSetupContracts();

  ammTokenKeychain = new PluginKeychainMemory({
    instanceId: randomUUID(),
    keychainId: randomUUID(),
    backend: new Map(),
    logLevel,
  });

  ammTokenConnector = new PluginLedgerConnectorBesu({
    instanceId: randomUUID(),
    rpcApiHttpHost: ammEnv.connectorOptions.rpcApiHttpHost,
    rpcApiWsHost: ammEnv.connectorOptions.rpcApiWsHost,
    pluginRegistry: new PluginRegistry({ plugins: [ammTokenKeychain] }),
    logLevel,
  });

  const strategy = new BesuAMMFXProvisionStrategy({
    besuAMM: ammEnv,
    signingCredential: ammEnv.ownerSigningCredential,
    recipient: ammEnv.ownerAccount,
  });

  const usdLiquidtyToken = await deployAmmToken("USDLiquidityToken");
  const eurLiquidtyToken = await deployAmmToken("EURLiquidityToken");

  await mintAmmToken(usdLiquidtyToken, ammEnv.ownerAccount, 10_000_000);
  await mintAmmToken(eurLiquidtyToken, ammEnv.ownerAccount, 10_000_000);

  ammEnv.registerCurrency(USD, usdLiquidtyToken);
  ammEnv.registerCurrency(EUR, eurLiquidtyToken);

  await ammEnv.provideLiquidity(
    USD,
    EUR,
    500_000,
    400_000,
    ammEnv.ownerSigningCredential,
  );

  console.log(`Warming up for ${WARMUP} iterations...`);
  for (let i = 0; i < WARMUP; i++) {
    const txId = randomUUID();
    await strategy.requestFXQuote(txId, USD, EUR, 100, {
      min: 0,
    });
    await strategy.releaseLiquidity(txId, USD, EUR, 100);
  }

  console.log(`Running benchmark for ${ITERATIONS} iterations...`);
  for (let i = 0; i < ITERATIONS; i++) {
    // Each lock is held under its own transaction id. requestFXQuote and
    // releaseLiquidity are measured against one lock...
    const releaseTxId = randomUUID();
    const { ms: requestFXQuoteMs } = await timed(() =>
      strategy.requestFXQuote(releaseTxId, USD, EUR, 100, {
        min: 0,
      }),
    );
    requestFXQuoteTimings.push(requestFXQuoteMs);

    const { ms: releaseLiquidityMs } = await timed(() =>
      strategy.releaseLiquidity(releaseTxId, USD, EUR, 100),
    );
    releaseLiquidityTimings.push(releaseLiquidityMs);

    // ...and confirmSettlement against a fresh lock, since settling requires an
    // active (un-released) lock.
    const settleTxId = randomUUID();
    await strategy.requestFXQuote(settleTxId, USD, EUR, 100, { min: 0 });
    const { ms: confirmSettlementMs } = await timed(() =>
      strategy.confirmSettlement(settleTxId, USD, EUR, 100),
    );
    confirmSettlementTimings.push(confirmSettlementMs);
  }
}

run()
  .catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await ammEnv.tearDown();

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const percentile = (arr: number[], p: number) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    };

    const stats = (arr: number[]) => ({
      min: Math.min(...arr),
      avg: avg(arr),
      median: median(arr),
      p95: percentile(arr, 95),
      max: Math.max(...arr),
    });

    const fmt = (n: number) => `${n.toFixed(2)} ms`;
    const pad = (s: string, w: number) => s.padEnd(w);
    const padL = (s: string, w: number) => s.padStart(w);

    const rows: Array<[string, number[]]> = [
      ["requestFXQuote", requestFXQuoteTimings],
      ["releaseLiquidity", releaseLiquidityTimings],
      ["confirmSettlement", confirmSettlementTimings],
    ];

    const cols = ["min", "avg", "median", "p95", "max"] as const;
    const opW = Math.max(9, ...rows.map(([name]) => name.length));
    const colW = 12;

    console.log("");
    console.log(
      `╭${"─".repeat(opW + 2)}┬${cols.map(() => "─".repeat(colW)).join("┬")}╮`,
    );
    console.log(
      `│ ${pad("operation", opW)} │${cols
        .map((c) => padL(c, colW - 1) + " ")
        .join("│")}│`,
    );
    console.log(
      `├${"─".repeat(opW + 2)}┼${cols.map(() => "─".repeat(colW)).join("┼")}┤`,
    );
    for (const [name, arr] of rows) {
      const s = stats(arr);
      console.log(
        `│ ${pad(name, opW)} │${cols
          .map((c) => padL(fmt(s[c]), colW - 1) + " ")
          .join("│")}│`,
      );
    }
    console.log(
      `╰${"─".repeat(opW + 2)}┴${cols.map(() => "─".repeat(colW)).join("┴")}╯`,
    );
    console.log(`\n${ITERATIONS} iterations (after ${WARMUP} warmup)\n`);
  });
