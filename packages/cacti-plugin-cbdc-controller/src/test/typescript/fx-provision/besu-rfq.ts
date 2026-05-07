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
import { randomBytes, randomUUID as uuidv4 } from "node:crypto";
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
  quoteId: string;
  quote: RFQQuoteData;
  signature: string;
}

interface PendingQuote {
  quote: RFQQuoteData;
  signature: string;
  baseCurrency: string;
  destinationCurrency: string;
  amountInNumber: number;
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
  private availableLiquidity: Map<string, bigint> = new Map();
  private pendingQuotes: Map<string, PendingQuote> = new Map();

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

  public async provideLiquidity(
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

    const prev = this.availableLiquidity.get(token.address.toLowerCase()) ?? 0n;
    this.availableLiquidity.set(token.address.toLowerCase(), prev + amountBig);

    this.log.info(`MM provided ${amountBig} of ${currency} (${token.address})`);
  }

  public async requestQuote(
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

    const tokenOutKey = tokenOut.address.toLowerCase();
    const available = this.availableLiquidity.get(tokenOutKey) ?? 0n;
    if (available < amountOut) {
      throw new Error(
        `Insufficient MM liquidity for ${to}: requested ${amountOut}, available ${available}`,
      );
    }

    const quoteId = "0x" + randomBytes(32).toString("hex");
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

    this.availableLiquidity.set(tokenOutKey, available - amountOut);
    this.pendingQuotes.set(quoteId, {
      quote,
      signature,
      baseCurrency: from,
      destinationCurrency: to,
      amountInNumber: amount,
    });

    const fxQuote: FXQuote = {
      id: quoteId,
      baseCurrency: from,
      destinationCurrency: to,
      rate: Number(amountOut) / amount,
      availableLiquidity: Number(available - amountOut),
    };

    this.log.info(
      `Issued RFQ quote ${quoteId} ${amount} ${from} -> ${amountOut} ${to} for taker ${taker}`,
    );

    return { fxQuote, quoteId, quote, signature };
  }

  public async releaseQuote(quoteId: string): Promise<void> {
    const pending = this.pendingQuotes.get(quoteId);
    if (!pending) {
      throw new Error(`No pending quote with id ${quoteId}`);
    }

    const tokenOut = this.requireCurrency(pending.destinationCurrency);
    const tokenOutKey = tokenOut.address.toLowerCase();
    const amountOut = BigInt(pending.quote.amountOut);
    const current = this.availableLiquidity.get(tokenOutKey) ?? 0n;
    this.availableLiquidity.set(tokenOutKey, current + amountOut);

    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "invalidate",
      params: [quoteId],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });

    this.pendingQuotes.delete(quoteId);
    this.log.info(`Released quote ${quoteId} and invalidated on-chain`);
  }

  public async settleQuote(
    quoteId: string,
    takerSigningCredential: Web3SigningCredential,
  ): Promise<FXQuote> {
    const pending = this.pendingQuotes.get(quoteId);
    if (!pending) {
      throw new Error(`No pending quote with id ${quoteId}`);
    }

    const tokenIn = this.requireCurrency(pending.baseCurrency);

    await this.connector.invokeContract({
      contractName: tokenIn.contractName,
      contractAddress: tokenIn.address,
      contractAbi: tokenIn.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [this.settlementAddress, pending.quote.amountIn],
      signingCredential: takerSigningCredential,
      gas: 1_000_000,
    });

    await this.connector.invokeContract({
      contractName: this.settlementName,
      contractAddress: this.settlementAddress,
      contractAbi: RFQSettlementContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "settle",
      params: [
        [
          pending.quote.id,
          pending.quote.taker,
          pending.quote.tokenIn,
          pending.quote.tokenOut,
          pending.quote.amountIn,
          pending.quote.amountOut,
          pending.quote.expiry,
        ],
        pending.signature,
      ],
      signingCredential: takerSigningCredential,
      gas: 9_000_000,
    });

    this.pendingQuotes.delete(quoteId);

    const amountOut = BigInt(pending.quote.amountOut);
    this.log.info(
      `Settled quote ${quoteId}: taker received ${amountOut} ${pending.destinationCurrency}`,
    );

    return {
      id: quoteId,
      baseCurrency: pending.baseCurrency,
      destinationCurrency: pending.destinationCurrency,
      rate: Number(amountOut) / pending.amountInNumber,
      availableLiquidity: Number(
        this.availableLiquidity.get(
          this.requireCurrency(
            pending.destinationCurrency,
          ).address.toLowerCase(),
        ) ?? 0n,
      ),
    };
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

  public getPendingQuote(quoteId: string): RFQQuoteData | undefined {
    return this.pendingQuotes.get(quoteId)?.quote;
  }

  public getAvailableLiquidity(currency: string): bigint {
    const token = this.requireCurrency(currency);
    return this.availableLiquidity.get(token.address.toLowerCase()) ?? 0n;
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
