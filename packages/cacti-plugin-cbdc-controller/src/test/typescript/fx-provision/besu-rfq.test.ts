import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  Containers,
  pruneDockerContainersIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  EthContractInvocationType as BesuContractInvocationType,
  PluginLedgerConnectorBesu,
  Web3SigningCredential,
  Web3SigningCredentialType as Web3SigningCredentialTypeBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID as uuidv4 } from "node:crypto";

import { BesuTokenInfo, DummyBesuRFQEnvironment } from "./besu-rfq";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";

const logLevel: LogLevelDesc = "INFO";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "DummyBesuRFQEnvironmentTest",
});
const TIMEOUT = 900_000;

let env: DummyBesuRFQEnvironment;
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
  signingCredential: Web3SigningCredential = env.ownerSigningCredential,
): Promise<void> {
  await tokenConnector.invokeContract({
    contractName: token.contractName,
    contractAddress: token.address,
    contractAbi: token.abi,
    invocationType: BesuContractInvocationType.Send,
    methodName: "mint",
    params: [account, amount],
    signingCredential,
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

async function newTaker(): Promise<{
  address: string;
  cred: Web3SigningCredential;
}> {
  const taker = await env.ledger.createEthTestAccount();
  return {
    address: taker.address,
    cred: {
      ethAccount: taker.address,
      secret: taker.privateKey,
      type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
    },
  };
}

describe("DummyBesuRFQEnvironment", () => {
  beforeAll(async () => {
    env = new DummyBesuRFQEnvironment({ logLevel });
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

    // MM (= owner) escrows liquidity for both directions.
    await env.deposit("USD", 1_000_000, env.ownerSigningCredential);
    await env.deposit("EUR", 1_000_000, env.ownerSigningCredential);

    // 1 USD = 0.9 EUR, 1 EUR = 1.1 USD (asymmetric).
    env.setRate("USD", "EUR", 9, 10);
    env.setRate("EUR", "USD", 11, 10);
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

  it("deploys the RFQSettlement at a valid address", () => {
    expect(env.getSettlementAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("credits available escrow on deposit", async () => {
    expect(await env.getAvailableLiquidity("USD")).toBe(1_000_000n);
    expect(await env.getAvailableLiquidity("EUR")).toBe(1_000_000n);
  });

  it("rejects requestQuote when source currency is not registered", async () => {
    await expect(
      env.requestQuote(uuidv4(), "JPY", "EUR", 100, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects requestQuote when destination currency is not registered", async () => {
    await expect(
      env.requestQuote(uuidv4(), "USD", "JPY", 100, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects requestQuote when no rate is set for the pair", async () => {
    env.registerCurrency("GBP", tokenA);
    await expect(
      env.requestQuote(uuidv4(), "USD", "GBP", 100, env.ownerAccount),
    ).rejects.toThrow(/No rate/);
  });

  it("prices a quote with a rate matching num/den", async () => {
    const taker = await newTaker();
    const result = await env.requestQuote(
      uuidv4(),
      "USD",
      "EUR",
      1_000,
      taker.address,
    );

    expect(result.fxQuote.baseCurrency).toBe("USD");
    expect(result.fxQuote.destinationCurrency).toBe("EUR");
    expect(result.fxQuote.rate).toBeCloseTo(0.9, 5);
    expect(result.quote.amountIn).toBe("1000");
    expect(result.quote.amountOut).toBe("900");
  });

  it(
    "rejects lock when the MM has insufficient escrow",
    async () => {
      const taker = await newTaker();
      const { quote, signature } = await env.requestQuote(
        uuidv4(),
        "USD",
        "EUR",
        100_000_000,
        taker.address,
      );
      await expect(env.lock(quote, signature, taker.cred)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "locks then settles, moving tokens between MM and taker",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      const expectedAmountOut = 900n;

      await mintTo(tokenA, taker.address, amountIn);

      const mmUsdBefore = await env.getAvailableLiquidity("USD");
      const mmEurAvailBefore = await env.getAvailableLiquidity("EUR");
      const takerEurBefore = await balanceOf(tokenB, taker.address);
      const takerUsdBefore = await balanceOf(tokenA, taker.address);

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );

      await env.lock(quote, signature, taker.cred);

      // Lock earmarks the output: available EUR drops, locked EUR rises.
      expect(await env.getAvailableLiquidity("EUR")).toBe(
        mmEurAvailBefore - expectedAmountOut,
      );
      expect(await env.getLockedLiquidity("EUR")).toBeGreaterThanOrEqual(
        expectedAmountOut,
      );

      await env.settle(txId, "USD", amountIn, taker.cred);

      const takerEurAfter = await balanceOf(tokenB, taker.address);
      const takerUsdAfter = await balanceOf(tokenA, taker.address);

      // Taker paid amountIn USD and received the locked amountOut EUR.
      expect(takerEurAfter - takerEurBefore).toBe(expectedAmountOut);
      expect(takerUsdBefore - takerUsdAfter).toBe(BigInt(amountIn));

      // Escrow: tokenIn accrued to available USD, locked EUR released.
      expect(await env.getAvailableLiquidity("USD")).toBe(
        mmUsdBefore + BigInt(amountIn),
      );
      expect(await env.getLockedLiquidity("EUR")).toBe(0n);
    },
    TIMEOUT,
  );

  it(
    "settle is idempotent: a second settle no-ops",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      await mintTo(tokenA, taker.address, amountIn);

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );
      await env.lock(quote, signature, taker.cred);
      await env.settle(txId, "USD", amountIn, taker.cred);

      const takerEurAfterFirst = await balanceOf(tokenB, taker.address);

      // Retrying settle must not pay out again.
      await env.settle(txId, "USD", amountIn, taker.cred);
      expect(await balanceOf(tokenB, taker.address)).toBe(takerEurAfterFirst);
    },
    TIMEOUT,
  );

  it(
    "honours the locked rate even if the MM reprices before settle (slippage-free)",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      const lockedAmountOut = 900n;
      await mintTo(tokenA, taker.address, amountIn);

      const takerEurBefore = await balanceOf(tokenB, taker.address);

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );
      await env.lock(quote, signature, taker.cred);

      // Market moves against the taker after the lock is held.
      env.setRate("USD", "EUR", 5, 10);
      try {
        await env.settle(txId, "USD", amountIn, taker.cred);

        // Taker still receives the rate locked at request time, not the new one.
        expect((await balanceOf(tokenB, taker.address)) - takerEurBefore).toBe(
          lockedAmountOut,
        );
      } finally {
        env.setRate("USD", "EUR", 9, 10);
      }
    },
    TIMEOUT,
  );

  it(
    "rejects lock on a tampered signature",
    async () => {
      const taker = await newTaker();
      const { quote, signature } = await env.requestQuote(
        uuidv4(),
        "USD",
        "EUR",
        1_000,
        taker.address,
      );

      const flipped =
        signature.slice(0, 4) +
        (signature[4] === "0" ? "1" : "0") +
        signature.slice(5);

      await expect(env.lock(quote, flipped, taker.cred)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "rejects lock on an expired quote",
    async () => {
      const taker = await newTaker();
      const { quote, signature } = await env.requestQuote(
        uuidv4(),
        "USD",
        "EUR",
        1_000,
        taker.address,
        1, // 1-second expiry
      );

      await new Promise((r) => setTimeout(r, 2_500));

      await expect(env.lock(quote, signature, taker.cred)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "rejects a duplicate lock for the same id (replay)",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      await mintTo(tokenA, taker.address, amountIn);

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );
      await env.lock(quote, signature, taker.cred);

      await expect(env.lock(quote, signature, taker.cred)).rejects.toThrow();

      // Clean up the outstanding lock.
      await env.release(txId, env.ownerSigningCredential);
    },
    TIMEOUT,
  );

  it(
    "release returns earmarked escrow and is idempotent",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      const amountOut = 900n;

      const availBefore = await env.getAvailableLiquidity("EUR");

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );
      await env.lock(quote, signature, taker.cred);
      expect(await env.getAvailableLiquidity("EUR")).toBe(
        availBefore - amountOut,
      );

      await env.release(txId, env.ownerSigningCredential);
      expect(await env.getAvailableLiquidity("EUR")).toBe(availBefore);

      // Releasing again is a safe no-op (idempotent).
      await env.release(txId, env.ownerSigningCredential);
      expect(await env.getAvailableLiquidity("EUR")).toBe(availBefore);
    },
    TIMEOUT,
  );

  it(
    "rejects settle after a lock has been released",
    async () => {
      const taker = await newTaker();
      const amountIn = 1_000;
      await mintTo(tokenA, taker.address, amountIn);

      const txId = uuidv4();
      const { quote, signature } = await env.requestQuote(
        txId,
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );
      await env.lock(quote, signature, taker.cred);
      await env.release(txId, env.ownerSigningCredential);

      await expect(
        env.settle(txId, "USD", amountIn, taker.cred),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
