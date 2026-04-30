import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  Containers,
  pruneDockerContainersIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  EthContractInvocationType as BesuContractInvocationType,
  PluginLedgerConnectorBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID as uuidv4 } from "node:crypto";

import { BesuTokenInfo, DummyBesuAMMEnvironment } from "./besu-amm";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";

const logLevel: LogLevelDesc = "INFO";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "DummyBesuAMMEnvironmentTest",
});
const TIMEOUT = 900_000;

let env: DummyBesuAMMEnvironment;
let tokenKeychain: PluginKeychainMemory;
let tokenConnector: PluginLedgerConnectorBesu;
let tokenA: BesuTokenInfo;
let tokenB: BesuTokenInfo;

async function deployToken(contractName: string): Promise<BesuTokenInfo> {
  tokenKeychain.set(contractName, JSON.stringify(SATPTokenContract));
  const deployRes = await tokenConnector.deployContract({
    keychainId: tokenKeychain.getKeychainId(),
    contractName,
    contractAbi: SATPTokenContract.abi,
    constructorArgs: [env.ownerAccount],
    web3SigningCredential: env.ownerSigningCredential,
    bytecode: SATPTokenContract.bytecode.object,
    gas: 1_000_000,
  });
  const address = deployRes.transactionReceipt.contractAddress;
  if (!address) {
    throw new Error(`Deployment of ${contractName} did not return an address`);
  }
  return { contractName, address, abi: SATPTokenContract.abi };
}

async function mintTo(
  token: BesuTokenInfo,
  account: string,
  amount: number,
): Promise<void> {
  await tokenConnector.invokeContract({
    contractName: token.contractName,
    contractAddress: token.address,
    contractAbi: token.abi,
    invocationType: BesuContractInvocationType.Send,
    methodName: "mint",
    params: [account, amount],
    signingCredential: env.ownerSigningCredential,
    gas: 1_000_000,
  });
}

async function balanceOf(
  token: BesuTokenInfo,
  account: string,
): Promise<bigint> {
  const res = await tokenConnector.invokeContract({
    contractName: token.contractName,
    contractAddress: token.address,
    contractAbi: token.abi,
    invocationType: BesuContractInvocationType.Call,
    methodName: "balanceOf",
    params: [account],
    signingCredential: env.ownerSigningCredential,
    gas: 1_000_000,
  });
  return BigInt(res.callOutput.toString());
}

describe("DummyBesuAMMEnvironment", () => {
  beforeAll(async () => {
    env = new DummyBesuAMMEnvironment({ logLevel });
    await env.init();
    await env.deployAndSetupContracts();

    tokenKeychain = new PluginKeychainMemory({
      instanceId: uuidv4(),
      keychainId: uuidv4(),
      backend: new Map(),
      logLevel,
    });
    tokenConnector = new PluginLedgerConnectorBesu({
      instanceId: uuidv4(),
      rpcApiHttpHost: env.connectorOptions.rpcApiHttpHost,
      rpcApiWsHost: env.connectorOptions.rpcApiWsHost,
      pluginRegistry: new PluginRegistry({ plugins: [tokenKeychain] }),
      logLevel,
    });

    tokenA = await deployToken("TokenA");
    tokenB = await deployToken("TokenB");

    await mintTo(tokenA, env.ownerAccount, 10_000_000);
    await mintTo(tokenB, env.ownerAccount, 10_000_000);

    env.registerCurrency("USD", tokenA);
    env.registerCurrency("EUR", tokenB);
  }, TIMEOUT);

  afterAll(async () => {
    if (env) {
      await env.tearDown();
    }
    await pruneDockerContainersIfGithubAction({ logLevel })
      .then(() => log.info("Pruning OK"))
      .catch(async () => {
        await Containers.logDiagnostics({ logLevel });
        throw new Error("Pruning didn't throw OK");
      });
  }, TIMEOUT);

  it("deploys the LiquidityPoolFactory at a valid address", () => {
    expect(env.getFactoryAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects swaps when the source currency is not registered", async () => {
    await expect(
      env.swap("JPY", "EUR", 100, env.ownerSigningCredential, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects swaps when the destination currency is not registered", async () => {
    await expect(
      env.swap("USD", "JPY", 100, env.ownerSigningCredential, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects swaps when no pair has been created yet", async () => {
    await expect(
      env.swap("USD", "EUR", 100, env.ownerSigningCredential, env.ownerAccount),
    ).rejects.toThrow(/No pair/);
  });

  it(
    "creates a pair and transfers liquidity on provideLiquidity",
    async () => {
      const ownerBeforeA = await balanceOf(tokenA, env.ownerAccount);
      const ownerBeforeB = await balanceOf(tokenB, env.ownerAccount);

      await env.provideLiquidity(
        "USD",
        "EUR",
        100_000,
        200_000,
        env.ownerSigningCredential,
      );

      const ownerAfterA = await balanceOf(tokenA, env.ownerAccount);
      const ownerAfterB = await balanceOf(tokenB, env.ownerAccount);
      expect(ownerBeforeA - ownerAfterA).toBe(100_000n);
      expect(ownerBeforeB - ownerAfterB).toBe(200_000n);
    },
    TIMEOUT,
  );

  it(
    "swaps tokens, returns a quote, and credits the recipient",
    async () => {
      const recipient = await env.ledger.createEthTestAccount();
      const recipientBefore = await balanceOf(tokenB, recipient.address);
      expect(recipientBefore).toBe(0n);

      const amountIn = 1_000;
      const quote = await env.swap(
        "USD",
        "EUR",
        amountIn,
        env.ownerSigningCredential,
        recipient.address,
      );

      expect(typeof quote.id).toBe("string");
      expect(quote.id.length).toBeGreaterThan(0);
      expect(quote.baseCurrency).toBe("USD");
      expect(quote.destinationCurrency).toBe("EUR");
      expect(quote.rate).toBeGreaterThan(0);
      // Pool was 100k USD / 200k EUR, so 1 USD should buy < 2 EUR after slippage.
      expect(quote.rate).toBeLessThan(2);
      expect(quote.availableLiquidity).toBeGreaterThan(0);

      const recipientAfter = await balanceOf(tokenB, recipient.address);
      const received = Number(recipientAfter - recipientBefore);
      expect(received).toBeGreaterThan(0);
      expect(received).toBeCloseTo(amountIn * quote.rate, 0);
    },
    TIMEOUT,
  );

  it(
    "reuses the existing pair when more liquidity is added",
    async () => {
      const ownerBeforeA = await balanceOf(tokenA, env.ownerAccount);
      const ownerBeforeB = await balanceOf(tokenB, env.ownerAccount);

      await env.provideLiquidity(
        "USD",
        "EUR",
        50_000,
        100_000,
        env.ownerSigningCredential,
      );

      const ownerAfterA = await balanceOf(tokenA, env.ownerAccount);
      const ownerAfterB = await balanceOf(tokenB, env.ownerAccount);
      expect(ownerBeforeA - ownerAfterA).toBe(50_000n);
      expect(ownerBeforeB - ownerAfterB).toBe(100_000n);
    },
    TIMEOUT,
  );
});
