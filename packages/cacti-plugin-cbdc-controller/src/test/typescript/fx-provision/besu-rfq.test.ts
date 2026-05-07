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

    // MM (= owner) seeds liquidity for both directions.
    await env.provideLiquidity("USD", 1_000_000, env.ownerSigningCredential);
    await env.provideLiquidity("EUR", 1_000_000, env.ownerSigningCredential);

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

  it("rejects requestQuote when source currency is not registered", async () => {
    await expect(
      env.requestQuote("JPY", "EUR", 100, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects requestQuote when destination currency is not registered", async () => {
    await expect(
      env.requestQuote("USD", "JPY", 100, env.ownerAccount),
    ).rejects.toThrow(/JPY/);
  });

  it("rejects requestQuote when no rate is set for the pair", async () => {
    env.registerCurrency("GBP", tokenA);
    await expect(
      env.requestQuote("USD", "GBP", 100, env.ownerAccount),
    ).rejects.toThrow(/No rate/);
  });

  it("returns a quote with a rate matching num/den", async () => {
    const taker = await env.ledger.createEthTestAccount();
    const result = await env.requestQuote("USD", "EUR", 1_000, taker.address);

    expect(result.fxQuote.id).toBe(result.quoteId);
    expect(result.fxQuote.baseCurrency).toBe("USD");
    expect(result.fxQuote.destinationCurrency).toBe("EUR");
    expect(result.fxQuote.rate).toBeCloseTo(0.9, 5);
    expect(result.quote.amountIn).toBe("1000");
    expect(result.quote.amountOut).toBe("900");

    // Release so other tests don't see this quote in pending state.
    await env.releaseQuote(result.quoteId);
  });

  it("rejects requestQuote when MM has insufficient liquidity", async () => {
    const taker = await env.ledger.createEthTestAccount();
    await expect(
      env.requestQuote("USD", "EUR", 100_000_000, taker.address),
    ).rejects.toThrow(/Insufficient/);
  });

  it(
    "settles a valid quote, transferring tokens between MM and taker",
    async () => {
      const taker = await env.ledger.createEthTestAccount();
      const takerCred: Web3SigningCredential = {
        ethAccount: taker.address,
        secret: taker.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      };

      const amountIn = 1_000;
      const expectedAmountOut = 900n;

      // Fund the taker with USD and a little ETH for gas.
      await mintTo(tokenA, taker.address, amountIn);

      const mmUsdBefore = await balanceOf(tokenA, env.ownerAccount);
      const mmEurBefore = await balanceOf(tokenB, env.ownerAccount);
      const takerEurBefore = await balanceOf(tokenB, taker.address);

      const result = await env.requestQuote(
        "USD",
        "EUR",
        amountIn,
        taker.address,
      );

      const settled = await env.settleQuote(result.quoteId, takerCred);

      expect(settled.id).toBe(result.quoteId);
      expect(settled.rate).toBeCloseTo(0.9, 5);

      const mmUsdAfter = await balanceOf(tokenA, env.ownerAccount);
      const mmEurAfter = await balanceOf(tokenB, env.ownerAccount);
      const takerEurAfter = await balanceOf(tokenB, taker.address);

      expect(mmUsdAfter - mmUsdBefore).toBe(BigInt(amountIn));
      expect(mmEurBefore - mmEurAfter).toBe(expectedAmountOut);
      expect(takerEurAfter - takerEurBefore).toBe(expectedAmountOut);
    },
    TIMEOUT,
  );

  it(
    "rejects settle on a tampered signature",
    async () => {
      const taker = await env.ledger.createEthTestAccount();
      const takerCred: Web3SigningCredential = {
        ethAccount: taker.address,
        secret: taker.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      };
      await mintTo(tokenA, taker.address, 1_000);

      const result = await env.requestQuote("USD", "EUR", 1_000, taker.address);

      // Mutate one byte of the signature in the pending entry.
      const pending = (
        env as unknown as {
          pendingQuotes: Map<string, { signature: string }>;
        }
      ).pendingQuotes.get(result.quoteId)!;
      const sig = pending.signature;
      const flipped =
        sig.slice(0, 4) + (sig[4] === "0" ? "1" : "0") + sig.slice(5);
      pending.signature = flipped;

      await expect(
        env.settleQuote(result.quoteId, takerCred),
      ).rejects.toThrow();

      // Restore and clean up.
      pending.signature = sig;
      await env.releaseQuote(result.quoteId);
    },
    TIMEOUT,
  );

  it(
    "rejects settle after the quote expires",
    async () => {
      const taker = await env.ledger.createEthTestAccount();
      const takerCred: Web3SigningCredential = {
        ethAccount: taker.address,
        secret: taker.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      };
      await mintTo(tokenA, taker.address, 1_000);

      const result = await env.requestQuote(
        "USD",
        "EUR",
        1_000,
        taker.address,
        1, // 1-second expiry
      );

      await new Promise((r) => setTimeout(r, 2_500));

      await expect(
        env.settleQuote(result.quoteId, takerCred),
      ).rejects.toThrow();

      await env.releaseQuote(result.quoteId);
    },
    TIMEOUT,
  );

  it(
    "rejects replayed settlement of the same quote",
    async () => {
      const taker = await env.ledger.createEthTestAccount();
      const takerCred: Web3SigningCredential = {
        ethAccount: taker.address,
        secret: taker.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      };
      await mintTo(tokenA, taker.address, 2_000);

      const result = await env.requestQuote("USD", "EUR", 1_000, taker.address);
      await env.settleQuote(result.quoteId, takerCred);

      // Re-insert the same quote into pending and try to settle again.
      const pendingMap = (
        env as unknown as {
          pendingQuotes: Map<
            string,
            {
              quote: unknown;
              signature: string;
              baseCurrency: string;
              destinationCurrency: string;
              amountInNumber: number;
            }
          >;
        }
      ).pendingQuotes;
      pendingMap.set(result.quoteId, {
        quote: result.quote,
        signature: result.signature,
        baseCurrency: "USD",
        destinationCurrency: "EUR",
        amountInNumber: 1_000,
      });

      await expect(
        env.settleQuote(result.quoteId, takerCred),
      ).rejects.toThrow();
      pendingMap.delete(result.quoteId);
    },
    TIMEOUT,
  );

  it(
    "releaseQuote restores available liquidity and prevents settlement",
    async () => {
      const taker = await env.ledger.createEthTestAccount();
      const takerCred: Web3SigningCredential = {
        ethAccount: taker.address,
        secret: taker.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      };
      await mintTo(tokenA, taker.address, 1_000);

      const liqBefore = env.getAvailableLiquidity("EUR");

      const result = await env.requestQuote("USD", "EUR", 1_000, taker.address);
      expect(env.getAvailableLiquidity("EUR")).toBe(liqBefore - 900n);

      await env.releaseQuote(result.quoteId);
      expect(env.getAvailableLiquidity("EUR")).toBe(liqBefore);

      // Re-inject and confirm the on-chain invalidate blocks any settle attempt.
      const pendingMap = (
        env as unknown as {
          pendingQuotes: Map<
            string,
            {
              quote: unknown;
              signature: string;
              baseCurrency: string;
              destinationCurrency: string;
              amountInNumber: number;
            }
          >;
        }
      ).pendingQuotes;
      pendingMap.set(result.quoteId, {
        quote: result.quote,
        signature: result.signature,
        baseCurrency: "USD",
        destinationCurrency: "EUR",
        amountInNumber: 1_000,
      });

      await expect(
        env.settleQuote(result.quoteId, takerCred),
      ).rejects.toThrow();
      pendingMap.delete(result.quoteId);
    },
    TIMEOUT,
  );
});
