import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { BesuTestLedger } from "@hyperledger/cactus-test-tooling";
import {
  EthContractInvocationType as BesuContractInvocationType,
  DeployContractSolidityBytecodeV1Response,
  IPluginLedgerConnectorBesuOptions,
  PluginLedgerConnectorBesu,
  Web3SigningCredential,
  Web3SigningCredentialType as Web3SigningCredentialTypeBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID as uuidv4 } from "node:crypto";
import { signTypedData, SignTypedDataVersion } from "@metamask/eth-sig-util";
import Web3 from "web3";

import { FXQuote } from "../../../main/typescript/core/fx-provision";
import RFQSettlementContract from "../../solidity/generated/RFQSettlement.sol/RFQSettlement.json";

export interface BesuTokenInfo {
  contractName: string;
  address: string;
  abi: unknown[];
}

export interface DummyBesuRFQEnvironmentOptions {
  logLevel?: LogLevelDesc;
  network?: string;
}

export interface RFQQuoteData {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  expiry: string;
}

export interface RFQRequestQuoteResult {
  fxQuote: FXQuote;
  quote: RFQQuoteData;
  signature: string;
}

const DOMAIN_NAME = "CactiRFQSettlement";
const DOMAIN_VERSION = "1";
const DEFAULT_EXPIRY_SECONDS = 300;

export class DummyBesuRFQEnvironment {
  public static readonly BESU_NETWORK_ID: string = "BesuRFQTestNetwork";

  public ledger!: BesuTestLedger;
  public connector!: PluginLedgerConnectorBesu;
  public connectorOptions!: IPluginLedgerConnectorBesuOptions;
  public web3!: Web3;
  public ownerAccount!: string;

  private ownerPrivateKey!: string;
  private keychain!: PluginKeychainMemory;
  private settlementName: string = "RFQSettlement";
  private settlementAddress!: string;
  private chainId!: number;

  private currencies: Map<string, BesuTokenInfo> = new Map();
  private rates: Map<string, { num: bigint; den: bigint }> = new Map();

  private dockerNetwork: string = "rfq-besu";
  private readonly logLevel: LogLevelDesc;
  private readonly log: Logger;

  constructor(private readonly options: DummyBesuRFQEnvironmentOptions = {}) {
    if (options.network) {
      this.dockerNetwork = options.network;
    }
    this.logLevel = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "DummyBesuRFQEnvironment",
    });
  }

  public async init(): Promise<void> {
    this.ledger = new BesuTestLedger({
      emitContainerLogs: true,
      envVars: ["BESU_NETWORK=dev"],
      containerImageVersion: "v2.2.0-rc.2",
      containerImageName: "ghcr.io/hyperledger-cacti/besu-all-in-one",
      networkName: this.dockerNetwork,
      logLevel: this.logLevel,
    });

    await this.ledger.start(false);

    const rpcApiHttpHost = await this.ledger.getRpcApiHttpHost();
    const rpcApiWsHost = await this.ledger.getRpcApiWsHost();

    this.web3 = new Web3(rpcApiHttpHost);
    this.chainId = Number(await this.web3.eth.getChainId());

    this.ownerAccount = this.ledger.getGenesisAccountPubKey();
    this.ownerPrivateKey = this.ledger.getGenesisAccountPrivKey();

    this.keychain = new PluginKeychainMemory({
      instanceId: uuidv4(),
      keychainId: uuidv4(),
      backend: new Map(),
      logLevel: this.logLevel,
    });

    const pluginRegistry = new PluginRegistry({ plugins: [this.keychain] });

    this.connectorOptions = {
      instanceId: uuidv4(),
      rpcApiHttpHost,
      rpcApiWsHost,
      pluginRegistry,
      logLevel: this.logLevel,
    };

    this.connector = new PluginLedgerConnectorBesu(this.connectorOptions);
  }

  public async deployAndSetupContracts(): Promise<void> {
    await this.keychain.set(
      this.settlementName,
      JSON.stringify(RFQSettlementContract),
    );

    let deployRes: DeployContractSolidityBytecodeV1Response;
    try {
      this.log.debug("Deploying RFQSettlement contract...");
      deployRes = await this.connector.deployContract({
        keychainId: this.keychain.getKeychainId(),
        contractName: this.settlementName,
        contractAbi: RFQSettlementContract.abi,
        constructorArgs: [this.ownerAccount],
        web3SigningCredential: this.ownerSigningCredential,
        bytecode: RFQSettlementContract.bytecode.object,
        gas: 9_000_000,
      });
    } catch (error) {
      this.log.error("Error deploying RFQSettlement contract:", error);
      throw error;
    }

    const address = deployRes.transactionReceipt.contractAddress;
    if (!address) {
      throw new Error("RFQSettlement deployment did not return an address");
    }
    this.settlementAddress = address;
    this.log.info(`RFQSettlement deployed at ${this.settlementAddress}`);
  }

  public registerCurrency(currency: string, token: BesuTokenInfo): void {
    this.currencies.set(currency, token);
  }

  public setRate(
    from: string,
    to: string,
    num: bigint | number,
    den: bigint | number,
  ): void {
    const key = this.rateKey(from, to);
    this.rates.set(key, { num: BigInt(num), den: BigInt(den) });
  }

  // The MM supplies priceless inventory into the settlement contract's escrow:
  // approve the contract, then `deposit` so the funds become available to back
  // future quotes. Replaces the old approve-only "provideLiquidity".
  public async deposit(
    currency: string,
    amount: number | bigint,
    signingCredential: Web3SigningCredential,
  ): Promise<void> {
    const token = this.requireCurrency(currency);
    const amountBig = BigInt(amount);

    await this.connector.invokeContract({
      contractName: token.contractName,
      contractAddress: token.address,
      contractAbi: token.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [this.settlementAddress, amountBig.toString()],
      signingCredential,
      gas: 1_000_000,
    });

    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "deposit",
      params: [token.address, amountBig.toString()],
      signingCredential,
      gas: 1_000_000,
    });

    this.log.info(
      `MM deposited ${amountBig} of ${currency} (${token.address})`,
    );
  }

  // The MM prices `amount` of `from` into `to` at its current rate and signs an
  // EIP-712 Quote (classic RFQ). Pure / off-chain: it neither mutates nor reads
  // escrow beyond the informational available-liquidity figure. The quote id is
  // derived deterministically from the caller-owned `transactionId` so the lock
  // can be acted on later from that id alone.
  public async requestQuote(
    transactionId: string,
    from: string,
    to: string,
    amount: number,
    taker: string,
    expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): Promise<RFQRequestQuoteResult> {
    const tokenIn = this.requireCurrency(from);
    const tokenOut = this.requireCurrency(to);
    const rate = this.rates.get(this.rateKey(from, to));
    if (!rate) {
      throw new Error(`No rate set for pair ${from}->${to}`);
    }

    const amountIn = BigInt(amount);
    const amountOut = (amountIn * rate.num) / rate.den;
    if (amountOut <= 0n) {
      throw new Error(`Computed amountOut is zero for ${amount} ${from}`);
    }

    const quoteId = this.toLockId(transactionId);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + expirySeconds);

    const quote: RFQQuoteData = {
      id: quoteId,
      taker,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      expiry: expiry.toString(),
    };

    const signature = this.signQuote(quote);

    const available = await this.getAvailableLiquidity(to);

    const fxQuote: FXQuote = {
      id: quoteId,
      baseCurrency: from,
      destinationCurrency: to,
      rate: Number(amountOut) / amount,
      availableLiquidity: Number(available),
    };

    this.log.info(
      `Priced RFQ quote ${quoteId} ${amount} ${from} -> ${amountOut} ${to} for taker ${taker}`,
    );

    return { fxQuote, quote, signature };
  }

  // Open the on-chain hold over a signed quote. Submitted by the taker; the
  // contract verifies the MM signature, enforces the acceptance bounds, and
  // earmarks the quote's amountOut from escrow. Reverts on a duplicate id, a
  // bad/expired signature, out-of-range output, or insufficient liquidity.
  public async lock(
    quote: RFQQuoteData,
    signature: string,
    takerSigningCredential: Web3SigningCredential,
    opts: { minAmountOut?: number; maxAmountOut?: number } = {},
  ): Promise<void> {
    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "lock",
      params: [
        [
          quote.id,
          quote.taker,
          quote.tokenIn,
          quote.tokenOut,
          quote.amountIn,
          quote.amountOut,
          quote.expiry,
        ],
        signature,
        (opts.minAmountOut ?? 0).toString(),
        (opts.maxAmountOut ?? 0).toString(),
      ],
      signingCredential: takerSigningCredential,
      gas: 9_000_000,
    });

    this.log.info(`Locked quote ${quote.id} on-chain`);
  }

  // Return the earmarked output of a held quote to available escrow. Maps the
  // caller-owned transaction id to the on-chain lock and is safe to retry: the
  // contract no-ops on any non-active lock.
  public async release(
    transactionId: string,
    signingCredential: Web3SigningCredential,
  ): Promise<void> {
    const lockId = this.toLockId(transactionId);

    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "release",
      params: [lockId],
      signingCredential,
      gas: 1_000_000,
    });

    this.log.info(`Released lock for tx=${transactionId} (${lockId})`);
  }

  // Settle a held quote at the frozen rate: the taker approves the contract to
  // pull `amount` of the input token, then `settle` consumes the lock. Safe to
  // retry — the contract no-ops on an already-settled lock.
  public async settle(
    transactionId: string,
    from: string,
    amount: number,
    takerSigningCredential: Web3SigningCredential,
  ): Promise<void> {
    const tokenIn = this.requireCurrency(from);
    const lockId = this.toLockId(transactionId);

    await this.connector.invokeContract({
      contractName: tokenIn.contractName,
      contractAddress: tokenIn.address,
      contractAbi: tokenIn.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [this.settlementAddress, amount.toString()],
      signingCredential: takerSigningCredential,
      gas: 1_000_000,
    });

    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "settle",
      params: [lockId],
      signingCredential: takerSigningCredential,
      gas: 9_000_000,
    });

    this.log.info(`Settled lock for tx=${transactionId} (${lockId})`);
  }

  public async tearDown(): Promise<void> {
    await this.ledger.stop();
    await this.ledger.destroy();
  }

  public get ownerSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: this.ownerAccount,
      secret: this.ownerPrivateKey,
      type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
    };
  }

  public getSettlementAddress(): string {
    return this.settlementAddress;
  }

  // Reads the MM's currently available (unlocked) escrow for a currency.
  public async getAvailableLiquidity(currency: string): Promise<bigint> {
    return this.readBalanceMap("available", currency);
  }

  // Reads the escrow currently earmarked by outstanding active locks.
  public async getLockedLiquidity(currency: string): Promise<bigint> {
    return this.readBalanceMap("locked", currency);
  }

  // Reads the on-chain lock state for a caller-owned transaction id. The public
  // mapping getter returns the Lock struct fields in declaration order:
  // (state, taker, tokenIn, tokenOut, amountIn, amountOut, expiry).
  public async getLockState(transactionId: string): Promise<number> {
    const lockId = this.toLockId(transactionId);
    const res = await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName: "locks",
      params: [lockId],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });
    const out = res.callOutput as unknown;
    let state: unknown;
    if (Array.isArray(out)) {
      state = out[0];
    } else if (out && typeof out === "object") {
      const rec = out as Record<string, unknown>;
      state = rec.state ?? rec["0"];
    } else {
      state = out;
    }
    return Number(state);
  }

  private async readBalanceMap(
    methodName: "available" | "locked",
    currency: string,
  ): Promise<bigint> {
    const token = this.requireCurrency(currency);
    const res = await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName,
      params: [token.address],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });
    return BigInt(res.callOutput.toString());
  }

  // Derives the bytes32 on-chain lock key from a caller-owned transaction id.
  // The MM signs this same id into the quote, and release/settle recompute it,
  // so the lock can be acted on from the transaction id alone with no off-chain
  // state. Any deterministic hash works since the contract treats it as opaque.
  private toLockId(transactionId: string): string {
    const id = this.web3.utils.soliditySha3({
      type: "string",
      value: transactionId,
    });
    if (!id) {
      throw new Error(
        `Failed to derive lock id from transaction id ${transactionId}`,
      );
    }
    return id;
  }

  private signQuote(quote: RFQQuoteData): string {
    const privateKey = Buffer.from(
      this.ownerPrivateKey.replace(/^0x/, ""),
      "hex",
    );

    return signTypedData({
      privateKey,
      version: SignTypedDataVersion.V4,
      data: {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Quote: [
            { name: "id", type: "bytes32" },
            { name: "taker", type: "address" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "amountOut", type: "uint256" },
            { name: "expiry", type: "uint256" },
          ],
        },
        primaryType: "Quote",
        domain: {
          name: DOMAIN_NAME,
          version: DOMAIN_VERSION,
          chainId: this.chainId,
          verifyingContract: this.settlementAddress,
        },
        message: {
          id: quote.id,
          taker: quote.taker,
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          expiry: quote.expiry,
        },
      },
    });
  }

  private requireCurrency(currency: string): BesuTokenInfo {
    const token = this.currencies.get(currency);
    if (!token) {
      throw new Error(`Currency ${currency} is not registered with the RFQ`);
    }
    return token;
  }

  private rateKey(from: string, to: string): string {
    return `${from}->${to}`;
  }
}
