import {
  BesuTokenInfo,
  DummyBesuRFQEnvironment,
} from "../fx-provision/besu-rfq";
import { BesuRFQFXProvisionStrategy } from "../fx-provision/besu-rfq-fx-provision-strategy";
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
const VALUE = Number(process.env.BENCH_VALUE ?? 100);

// 1 USD = 0.8 EUR (5:4), matching the AMM benchmark's effective rate so the two
// strategies are compared on equal pricing.
const RATE_NUM = 4;
const RATE_DEN = 5;

const HEADROOM = Number(process.env.BENCH_LIQUIDITY_HEADROOM ?? 10);
const totalDemand = VALUE * ITERATIONS;
const USD_LIQUIDITY = Math.max(500_000, totalDemand * HEADROOM);
const EUR_LIQUIDITY = Math.round(USD_LIQUIDITY * 0.8); // 5:4 rate
const MINT_AMOUNT = Math.max(10_000_000, USD_LIQUIDITY * 2);

const logLevel: LogLevelDesc = "DEBUG";

const requestFXQuoteTimings: number[] = [];
const releaseLiquidityTimings: number[] = [];
const confirmSettlementTimings: number[] = [];

let rfqEnv: DummyBesuRFQEnvironment;
let rfqTokenConnector: PluginLedgerConnectorBesu;
let rfqTokenKeychain: PluginKeychainMemory;

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

async function run() {
  console.log(
    `Running Besu RFQ FX benchmark with ${ITERATIONS} iterations (after ${WARMUP} warmup) and value ${VALUE}...`,
  );

  rfqEnv = new DummyBesuRFQEnvironment({ logLevel: "DEBUG" });
  await rfqEnv.init();
  await rfqEnv.deployAndSetupContracts();

  rfqTokenKeychain = new PluginKeychainMemory({
    instanceId: randomUUID(),
    keychainId: randomUUID(),
    backend: new Map(),
    logLevel,
  });

  rfqTokenConnector = new PluginLedgerConnectorBesu({
    instanceId: randomUUID(),
    rpcApiHttpHost: rfqEnv.connectorOptions.rpcApiHttpHost,
    rpcApiWsHost: rfqEnv.connectorOptions.rpcApiWsHost,
    pluginRegistry: new PluginRegistry({ plugins: [rfqTokenKeychain] }),
    logLevel,
  });

  // The market maker (= owner) is also the taker in this single-process
  // benchmark; it signs quotes, escrows liquidity, and settles against itself.
  const strategy = new BesuRFQFXProvisionStrategy({
    besuRFQ: rfqEnv,
    takerSigningCredential: rfqEnv.ownerSigningCredential,
    takerAccount: rfqEnv.ownerAccount,
  });

  const usdLiquidtyToken = await deployRfqToken("USDLiquidityToken");
  const eurLiquidtyToken = await deployRfqToken("EURLiquidityToken");

  await mintRfqToken(usdLiquidtyToken, rfqEnv.ownerAccount, MINT_AMOUNT);
  await mintRfqToken(eurLiquidtyToken, rfqEnv.ownerAccount, MINT_AMOUNT);

  rfqEnv.registerCurrency(USD, usdLiquidtyToken);
  rfqEnv.registerCurrency(EUR, eurLiquidtyToken);

  rfqEnv.setRate(USD, EUR, RATE_NUM, RATE_DEN);
  rfqEnv.setRate(EUR, USD, RATE_DEN, RATE_NUM);

  // Escrow the payout currency (EUR) the MM will quote out for USD->EUR trades.
  // Incoming USD from settlements accrues into available escrow on its own.
  await rfqEnv.deposit(EUR, EUR_LIQUIDITY, rfqEnv.ownerSigningCredential);

  console.log(`Warming up for ${WARMUP} iterations...`);
  for (let i = 0; i < WARMUP; i++) {
    const txId = randomUUID();
    await strategy.requestFXQuote(txId, USD, EUR, VALUE, {
      min: 0,
    });
    await strategy.releaseLiquidity(txId, USD, EUR, VALUE);
  }

  console.log(`Running benchmark for ${ITERATIONS} iterations...`);
  for (let i = 0; i < ITERATIONS; i++) {
    // Each lock is held under its own transaction id. requestFXQuote and
    // releaseLiquidity are measured against one lock...
    const releaseTxId = randomUUID();
    const { ms: requestFXQuoteMs } = await timed(() =>
      strategy.requestFXQuote(releaseTxId, USD, EUR, VALUE, {
        min: 0,
      }),
    );
    requestFXQuoteTimings.push(requestFXQuoteMs);

    const { ms: releaseLiquidityMs } = await timed(() =>
      strategy.releaseLiquidity(releaseTxId, USD, EUR, VALUE),
    );
    releaseLiquidityTimings.push(releaseLiquidityMs);

    // ...and confirmSettlement against a fresh lock, since settling requires an
    // active (un-released) lock.
    const settleTxId = randomUUID();
    await strategy.requestFXQuote(settleTxId, USD, EUR, VALUE, { min: 0 });
    const { ms: confirmSettlementMs } = await timed(() =>
      strategy.confirmSettlement(settleTxId, USD, EUR, VALUE),
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
    await rfqEnv.tearDown();

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
