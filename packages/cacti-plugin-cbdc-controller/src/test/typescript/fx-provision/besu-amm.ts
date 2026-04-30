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
import Web3 from "web3";

import { FXQuote } from "../../../main/typescript/core/fx-provision";
import LiquidityPoolFactoryContract from "../../solidity/generated/LiquidityPoolFactory.sol/LiquidityPoolFactory.json";
import LiquidityPoolPairContract from "../../solidity/generated/LiquidityPoolPair.sol/LiquidityPoolPair.json";

export interface BesuTokenInfo {
  contractName: string;
  address: string;
  abi: unknown[];
}

export interface DummyBesuAMMEnvironmentOptions {
  logLevel?: LogLevelDesc;
  network?: string;
}

export class DummyBesuAMMEnvironment {
  public static readonly BESU_NETWORK_ID: string = "BesuAMMTestNetwork";

  public ledger!: BesuTestLedger;
  public connector!: PluginLedgerConnectorBesu;
  public connectorOptions!: IPluginLedgerConnectorBesuOptions;
  public web3!: Web3;
  public ownerAccount!: string;

  private ownerPrivateKey!: string;
  private keychain!: PluginKeychainMemory;
  private keychainEntryKey!: string;
  private pairName = "LiquidityPoolPair";
  private pairAddress!: string;
  private factoryName: string = "LiquidityPoolFactory";
  private factoryAddress!: string;

  private currencies: Map<string, BesuTokenInfo> = new Map();
  private pairs: Map<string, { address: string; token0: string }> = new Map();

  private dockerNetwork: string = "amm-besu";
  private readonly logLevel: LogLevelDesc;
  private readonly log: Logger;

  constructor(private readonly options: DummyBesuAMMEnvironmentOptions = {}) {
    if (options.network) {
      this.dockerNetwork = options.network;
    }
    this.logLevel = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "DummyBesuAMMEnvironment",
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

    this.ownerAccount = this.ledger.getGenesisAccountPubKey();
    this.ownerPrivateKey = this.ledger.getGenesisAccountPrivKey();

    this.keychainEntryKey = uuidv4();
    this.keychain = new PluginKeychainMemory({
      instanceId: uuidv4(),
      keychainId: uuidv4(),
      backend: new Map([[this.keychainEntryKey, this.ownerPrivateKey]]),
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
      this.factoryName,
      JSON.stringify(LiquidityPoolFactoryContract),
    );

    let deployRes: DeployContractSolidityBytecodeV1Response;
    try {
      this.log.debug("Deploying LiquidityPoolFactory contract...");
      deployRes = await this.connector.deployContract({
        keychainId: this.keychain.getKeychainId(),
        contractName: this.factoryName,
        contractAbi: LiquidityPoolFactoryContract.abi,
        constructorArgs: [],
        web3SigningCredential: this.ownerSigningCredential,
        bytecode: LiquidityPoolFactoryContract.bytecode.object,
        gas: 9_000_000,
      });
    } catch (error) {
      this.log.error("Error deploying LiquidityPoolFactory contract:", error);
      throw error;
    }

    const address = deployRes.transactionReceipt.contractAddress;
    if (!address) {
      throw new Error(
        "LiquidityPoolFactory deployment did not return an address",
      );
    }
    this.factoryAddress = address;
    this.log.info(`LiquidityPoolFactory deployed at ${this.factoryAddress}`);
  }

  public registerCurrency(currency: string, token: BesuTokenInfo): void {
    this.currencies.set(currency, token);
  }

  public async provideLiquidity(
    currencyA: string,
    currencyB: string,
    amountA: number,
    amountB: number,
    signingCredential: Web3SigningCredential,
  ): Promise<void> {
    const tokenA = this.requireCurrency(currencyA);
    const tokenB = this.requireCurrency(currencyB);

    const pair = await this.getOrCreatePair(tokenA, tokenB);

    await this.connector.invokeContract({
      contractName: tokenA.contractName,
      contractAddress: tokenA.address,
      contractAbi: tokenA.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [pair.address, amountA],
      signingCredential,
      gas: 1_000_000,
    });

    await this.connector.invokeContract({
      contractName: tokenB.contractName,
      contractAddress: tokenB.address,
      contractAbi: tokenB.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [pair.address, amountB],
      signingCredential,
      gas: 1_000_000,
    });

    const isAToken0 =
      tokenA.address.toLowerCase() === pair.token0.toLowerCase();
    const amount0 = isAToken0 ? amountA : amountB;
    const amount1 = isAToken0 ? amountB : amountA;

    await this.connector.invokeContract({
      contractName: "LiquidityPoolPair",
      contractAddress: pair.address,
      contractAbi: LiquidityPoolPairContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "addLiquidity",
      params: [amount0, amount1],
      signingCredential,
      gas: 9_000_000,
    });

    this.log.info(
      `Liquidity added to ${currencyA}/${currencyB} pair: ${amountA}/${amountB}`,
    );
  }

  public async getQuote(
    from: string,
    to: string,
    amount: number,
  ): Promise<FXQuote> {
    const tokenIn = this.requireCurrency(from);
    const tokenOut = this.requireCurrency(to);

    const pair = this.requirePair(tokenIn, tokenOut);

    const { amountOut, reserveOut } = await this.computeSwapOutput(
      pair,
      tokenIn,
      amount,
    );

    return {
      id: uuidv4(),
      baseCurrency: from,
      destinationCurrency: to,
      rate: Number(amountOut) / amount,
      availableLiquidity: Number(reserveOut),
    };
  }

  public async swap(
    from: string,
    to: string,
    amount: number,
    signingCredential: Web3SigningCredential,
    recipient: string,
  ): Promise<FXQuote> {
    const tokenIn = this.requireCurrency(from);
    const tokenOut = this.requireCurrency(to);

    const pair = this.requirePair(tokenIn, tokenOut);

    const { amountIn, amountOut, reserveOut, isInToken0 } =
      await this.computeSwapOutput(pair, tokenIn, amount);

    await this.connector.invokeContract({
      contractName: tokenIn.contractName,
      contractAddress: tokenIn.address,
      contractAbi: tokenIn.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "transfer",
      params: [pair.address, amountIn.toString()],
      signingCredential,
      gas: 1_000_000,
    });

    const amount0Out = isInToken0 ? 0n : amountOut;
    const amount1Out = isInToken0 ? amountOut : 0n;

    await this.connector.invokeContract({
      contractName: "LiquidityPoolPair",
      contractAddress: pair.address,
      contractAbi: LiquidityPoolPairContract.abi,
      invocationType: BesuContractInvocationType.Send,
      methodName: "swap",
      params: [amount0Out.toString(), amount1Out.toString(), recipient],
      signingCredential,
      gas: 9_000_000,
    });

    const amountOutNum = Number(amountOut);
    const reserveOutAfter = Number(reserveOut - amountOut);

    this.log.info(
      `Swapped ${amount} ${from} -> ${amountOutNum} ${to} (recipient=${recipient})`,
    );

    return {
      id: uuidv4(),
      baseCurrency: from,
      destinationCurrency: to,
      rate: amountOutNum / amount,
      availableLiquidity: reserveOutAfter,
    };
  }

  private async computeSwapOutput(
    pair: { address: string; token0: string },
    tokenIn: BesuTokenInfo,
    amount: number,
  ): Promise<{
    amountIn: bigint;
    amountOut: bigint;
    reserveIn: bigint;
    reserveOut: bigint;
    isInToken0: boolean;
  }> {
    const reserve0Res = await this.connector.invokeContract({
      contractName: "LiquidityPoolPair",
      contractAddress: pair.address,
      contractAbi: LiquidityPoolPairContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName: "reserve0",
      params: [],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });
    const reserve1Res = await this.connector.invokeContract({
      contractName: "LiquidityPoolPair",
      contractAddress: pair.address,
      contractAbi: LiquidityPoolPairContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName: "reserve1",
      params: [],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });

    const reserve0 = BigInt(reserve0Res.callOutput.toString());
    const reserve1 = BigInt(reserve1Res.callOutput.toString());

    const isInToken0 =
      tokenIn.address.toLowerCase() === pair.token0.toLowerCase();
    const reserveIn = isInToken0 ? reserve0 : reserve1;
    const reserveOut = isInToken0 ? reserve1 : reserve0;

    const amountIn = BigInt(amount);
    if (reserveIn === 0n || reserveOut === 0n) {
      throw new Error(`No liquidity for pair ${tokenIn.contractName}`);
    }
    const amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    if (amountOut <= 0n) {
      throw new Error(`Computed swap output is zero for amount ${amount}`);
    }
    if (amountOut >= reserveOut) {
      throw new Error(
        `Insufficient liquidity: requested ${amountOut}, reserve ${reserveOut}`,
      );
    }

    return { amountIn, amountOut, reserveIn, reserveOut, isInToken0 };
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

  public getFactoryAddress(): string {
    return this.factoryAddress;
  }

  private requireCurrency(currency: string): BesuTokenInfo {
    const token = this.currencies.get(currency);
    if (!token) {
      throw new Error(`Currency ${currency} is not registered with the AMM`);
    }
    return token;
  }

  private requirePair(
    tokenA: BesuTokenInfo,
    tokenB: BesuTokenInfo,
  ): { address: string; token0: string } {
    const pair = this.pairs.get(this.pairKey(tokenA.address, tokenB.address));
    if (!pair) {
      throw new Error(
        `No pair exists for ${tokenA.address}/${tokenB.address}; call provideLiquidity first`,
      );
    }
    return pair;
  }

  private pairKey(addressA: string, addressB: string): string {
    const a = addressA.toLowerCase();
    const b = addressB.toLowerCase();
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private async getOrCreatePair(
    tokenA: BesuTokenInfo,
    tokenB: BesuTokenInfo,
  ): Promise<{ address: string; token0: string }> {
    const key = this.pairKey(tokenA.address, tokenB.address);
    const cached = this.pairs.get(key);
    if (cached) {
      return cached;
    }

    const existingRes = await this.connector.invokeContract({
      contractName: this.factoryName,
      contractAddress: this.factoryAddress,
      contractAbi: LiquidityPoolFactoryContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName: "getPair",
      params: [tokenA.address, tokenB.address],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });
    let pairAddress = existingRes.callOutput?.toString();

    if (!pairAddress || /^0x0+$/i.test(pairAddress)) {
      await this.connector.invokeContract({
        contractName: this.factoryName,
        contractAddress: this.factoryAddress,
        contractAbi: LiquidityPoolFactoryContract.abi,
        invocationType: BesuContractInvocationType.Send,
        methodName: "createPair",
        params: [tokenA.address, tokenB.address],
        signingCredential: this.ownerSigningCredential,
        gas: 9_000_000,
      });

      const lookupRes = await this.connector.invokeContract({
        contractName: this.factoryName,
        contractAddress: this.factoryAddress,
        contractAbi: LiquidityPoolFactoryContract.abi,
        invocationType: BesuContractInvocationType.Call,
        methodName: "getPair",
        params: [tokenA.address, tokenB.address],
        signingCredential: this.ownerSigningCredential,
        gas: 1_000_000,
      });
      pairAddress = lookupRes.callOutput?.toString();
    }

    if (!pairAddress || /^0x0+$/i.test(pairAddress)) {
      throw new Error(
        `Failed to resolve pair address for ${tokenA.address}/${tokenB.address}`,
      );
    }

    const token0Res = await this.connector.invokeContract({
      contractName: "LiquidityPoolPair",
      contractAddress: pairAddress,
      contractAbi: LiquidityPoolPairContract.abi,
      invocationType: BesuContractInvocationType.Call,
      methodName: "token0",
      params: [],
      signingCredential: this.ownerSigningCredential,
      gas: 1_000_000,
    });
    const token0 = token0Res.callOutput?.toString();
    if (!token0) {
      throw new Error(`Failed to read token0 for pair at ${pairAddress}`);
    }

    const entry = { address: pairAddress, token0 };
    this.pairs.set(key, entry);
    this.log.info(
      `Pair created at ${pairAddress} for ${tokenA.address}/${tokenB.address}`,
    );
    return entry;
  }
}
