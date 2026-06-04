import {
  PluginLedgerConnectorEthereum,
  EthContractInvocationType,
  Web3SigningCredentialType,
  IPluginLedgerConnectorEthereumOptions,
  GasTransactionConfig,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  GethTestLedger,
  WHALE_ACCOUNT_ADDRESS,
} from "@hyperledger/cactus-test-geth-ledger";
import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { randomUUID } from "node:crypto";
import {
  Asset,
  AssetErcTokenStandardEnum,
  AssetTokenTypeEnum,
  ClaimFormat,
  INetworkOptions,
  NetworkId,
  TokenType,
  TransactRequest,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { ILedgerEnvironment } from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { IChainRuntimeConfig } from "../config/types";

import SATPTokenContract from "../../../../../../packages/cacti-plugin-cbdc-controller/dist/lib/test/solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";
import OntologyERC20Eth from "../../../../../../packages/cacti-plugin-cbdc-controller/dist/lib/test/json/ontologies/ontology-satp-erc20-interact-ethereum.json";

/* ---------------------------------------------------------------- *
 *  Runtime ILedgerEnvironment adapter (config-driven entrypoints)  *
 * ---------------------------------------------------------------- */

export interface EthereumEnvironmentDeps {
  config: IChainRuntimeConfig;
  ontologyReferenceId: string;
  transact: (request: TransactRequest) => Promise<TransactResponse>;
}

export class EthereumRuntimeEnvironment implements ILedgerEnvironment {
  private readonly network: NetworkId;
  constructor(private readonly deps: EthereumEnvironmentDeps) {
    this.network = {
      id: deps.config.networkId,
      ledgerType: LedgerType.Ethereum,
    };
  }

  getAsset(id: string, amount: number): TransactRequestSourceAsset {
    return {
      contractName: this.deps.config.cbdcContract.contractName,
      contractAddress: this.deps.config.cbdcContract.contractAddress,
      ercTokenStandard: "ERC20",
      id,
      networkId: this.network,
      tokenType: TokenType.Fungible,
      owner: this.deps.config.cbdcContract.ownerAddress,
      referenceId: this.deps.ontologyReferenceId,
      amount: amount.toString(),
    } satisfies TransactRequestSourceAsset;
  }

  async transact(request: TransactRequest): Promise<TransactResponse> {
    return this.deps.transact(request);
  }
}

export function createEthereumConnector(
  config: IChainRuntimeConfig,
  contractJson: { contractName: string; abi: unknown[]; bytecode: { object: string } },
): {
  connector: PluginLedgerConnectorEthereum;
  keychain: PluginKeychainMemory;
  options: IPluginLedgerConnectorEthereumOptions;
} {
  const keychainEntryKey = config.cbdcContract.ownerAddress;
  const keychain = new PluginKeychainMemory({
    instanceId: randomUUID(),
    keychainId: randomUUID(),
    backend: new Map([[keychainEntryKey, "test"]]),
  });
  keychain.set(contractJson.contractName, JSON.stringify(contractJson));
  const options: IPluginLedgerConnectorEthereumOptions = {
    instanceId: randomUUID(),
    rpcApiWsHost: config.rpcWsUrl,
    pluginRegistry: new PluginRegistry({ plugins: [keychain] }),
  };
  return { connector: new PluginLedgerConnectorEthereum(options), keychain, options };
}

export async function readEthereumBalance(
  connector: PluginLedgerConnectorEthereum,
  keychainId: string,
  config: IChainRuntimeConfig,
  account: string,
): Promise<string> {
  const response = await connector.invokeContract({
    contract: {
      contractName: config.cbdcContract.contractName,
      keychainId,
    },
    invocationType: EthContractInvocationType.Call,
    methodName: "balanceOf",
    params: [account],
    web3SigningCredential: {
      ethAccount: config.cbdcContract.ownerAddress,
      secret: "",
      type: Web3SigningCredentialType.GethKeychainPassword,
    },
  });
  return String(response.callOutput ?? "0");
}

/* ---------------------------------------------------------------- *
 *  LocalEthereumEnvironment — runtime-friendly equivalent of the   *
 *  cacti-plugin-cbdc-controller test EthereumTestEnvironment.      *
 *                                                                  *
 *  Starts a GethTestLedger container, deploys SATPTokenContract,   *
 *  funds a bridge account, and exposes account/contract ops.       *
 * ---------------------------------------------------------------- */

export interface LocalEthereumEnvironmentOptions {
  logLevel?: LogLevelDesc;
  contractName: string;
  claimFormat: ClaimFormat;
  dockerNetwork?: string;
}

export interface EthereumLedgerAccount {
  address: string;
  // Geth personal accounts use a passphrase rather than a raw private key.
  passphrase: string;
}

const DEFAULT_ASSET_ID = "EthereumLocalEnvAsset";
// Must match a key the SATP gateway's (mock) PriceManager recognizes, since it
// converts transfer amounts to USD by networkId — otherwise it throws
// PriceNotFoundError. See packages/cactus-plugin-satp-hermes price-manager.ts.
const NETWORK_ID = "EthereumLedgerTestNetwork";
const DEFAULT_PASSPHRASE = "test";

export class LocalEthereumEnvironment {
  public readonly network: NetworkId = {
    id: NETWORK_ID,
    ledgerType: LedgerType.Ethereum,
  };

  private readonly log: Logger;
  private readonly logLevel: LogLevelDesc;
  private readonly claimFormat: ClaimFormat;
  private readonly contractName: string;

  private ledger!: GethTestLedger;
  private connector!: PluginLedgerConnectorEthereum;
  private keychain!: PluginKeychainMemory;
  private connectorOptions!: IPluginLedgerConnectorEthereumOptions;

  private bridgeAccount!: string;
  private contractAddress: string = "";

  private readonly gasConfig: GasTransactionConfig = {
    gas: "6721975",
    gasPrice: "20000000000",
  };

  private constructor(opts: LocalEthereumEnvironmentOptions) {
    this.logLevel = opts.logLevel ?? "INFO";
    this.claimFormat = opts.claimFormat;
    this.contractName = opts.contractName;
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "LocalEthereumEnvironment",
    });
  }

  public static async start(
    opts: LocalEthereumEnvironmentOptions,
  ): Promise<LocalEthereumEnvironment> {
    const env = new LocalEthereumEnvironment(opts);
    await env.bootstrap(opts.dockerNetwork);
    return env;
  }

  private async bootstrap(dockerNetwork?: string): Promise<void> {
    this.log.info(`starting GethTestLedger`);
    this.ledger = new GethTestLedger({
      containerImageName: "ghcr.io/hyperledger/cacti-geth-all-in-one",
      containerImageVersion: "2023-07-27-2a8c48ed6",
      networkName: dockerNetwork,
    });
    await this.ledger.start(false, []);

    this.bridgeAccount = await this.ledger.newEthPersonalAccount();
    const rpcApiWsHost = await this.ledger.getRpcApiWebSocketHost();

    this.keychain = new PluginKeychainMemory({
      instanceId: randomUUID(),
      keychainId: randomUUID(),
      backend: new Map([[this.bridgeAccount, DEFAULT_PASSPHRASE]]),
      logLevel: this.logLevel,
    });
    await this.keychain.set(
      this.contractName,
      JSON.stringify({
        contractName: this.contractName,
        abi: SATPTokenContract.abi,
        bytecode: SATPTokenContract.bytecode.object,
      }),
    );

    this.connectorOptions = {
      instanceId: randomUUID(),
      rpcApiWsHost,
      pluginRegistry: new PluginRegistry({ plugins: [this.keychain] }),
      logLevel: this.logLevel,
    };
    this.connector = new PluginLedgerConnectorEthereum(this.connectorOptions);

    await this.deployContract();
  }

  private async deployContract(): Promise<void> {
    const deployOut = await this.connector.deployContract({
      contract: {
        keychainId: this.keychain.getKeychainId(),
        contractName: this.contractName,
      },
      constructorArgs: [WHALE_ACCOUNT_ADDRESS],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    const address = deployOut.transactionReceipt?.contractAddress;
    if (!address) {
      throw new Error(
        "Ethereum SATPTokenContract deployment did not return an address",
      );
    }
    this.contractAddress = address;
    this.log.info(`SATPTokenContract deployed at ${address}`);
  }

  // ---- account management ----

  /**
   * Create a brand-new Geth personal account guarded by `passphrase`.
   * The geth dev-net pre-funds new accounts via the whale; if you need
   * an arbitrary balance, transfer from WHALE_ACCOUNT_ADDRESS afterwards.
   */
  public async createAccount(
    passphrase: string = DEFAULT_PASSPHRASE,
  ): Promise<EthereumLedgerAccount> {
    const address = await this.ledger.newEthPersonalAccount();
    this.log.info(`created Ethereum account ${address}`);
    return { address, passphrase };
  }

  // ---- contract ops ----

  public async mint(amount: string | number, to?: string): Promise<void> {
    const recipient = to ?? WHALE_ACCOUNT_ADDRESS;
    const res = await this.connector.invokeContract({
      contract: {
        contractName: this.contractName,
        keychainId: this.keychain.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "mint",
      params: [recipient, amount.toString()],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    if (!res.success) throw new Error(`mint failed for ${recipient}`);
    this.log.info(`minted ${amount} to ${recipient}`);
  }

  public async grantBridgeRole(wrapperAddress: string): Promise<void> {
    const res = await this.connector.invokeContract({
      contract: {
        contractName: this.contractName,
        keychainId: this.keychain.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "grantBridgeRole",
      params: [wrapperAddress],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    if (!res.success) throw new Error(`grantBridgeRole failed for ${wrapperAddress}`);
  }

  /**
   * Approve `spender` to pull `amount` tokens. By default the unlocked whale
   * account signs; pass `signer` to approve from a per-user personal account
   * (identified by its address + passphrase) that holds the funds.
   */
  public async approve(
    spender: string,
    amount: string | number,
    signer?: { ethAccount: string; passphrase: string },
  ): Promise<void> {
    const res = await this.connector.invokeContract({
      contract: {
        contractName: this.contractName,
        keychainId: this.keychain.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "approve",
      params: [spender, Number(amount)],
      web3SigningCredential: {
        ethAccount: signer?.ethAccount ?? WHALE_ACCOUNT_ADDRESS,
        secret: signer?.passphrase ?? "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    if (!res.success) throw new Error(`approve failed for ${spender}`);
  }

  public async getBalance(account: string): Promise<string> {
    const res = await this.connector.invokeContract({
      contract: {
        contractName: this.contractName,
        keychainId: this.keychain.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "balanceOf",
      params: [account],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    return String(res.callOutput ?? "0");
  }

  // ---- getters / config builders ----

  public getOwnerAccount(): string {
    return WHALE_ACCOUNT_ADDRESS;
  }

  public getContractName(): string {
    return this.contractName;
  }

  public getContractAddress(): string {
    return this.contractAddress;
  }

  public get defaultAsset(): Asset {
    return {
      id: DEFAULT_ASSET_ID,
      referenceId: OntologyERC20Eth.id,
      owner: WHALE_ACCOUNT_ADDRESS,
      contractName: this.contractName,
      contractAddress: this.contractAddress,
      networkId: this.network,
      tokenType: AssetTokenTypeEnum.Fungible,
      ercTokenStandard: AssetErcTokenStandardEnum.Erc20,
    };
  }

  public createEthereumConfig(): INetworkOptions {
    return {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeAccount,
        secret: DEFAULT_PASSPHRASE,
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
      gasConfig: this.gasConfig,
      connectorOptions: {
        rpcApiHttpHost: this.connectorOptions.rpcApiHttpHost,
        rpcApiWsHost: this.connectorOptions.rpcApiWsHost,
      },
      claimFormats: [this.claimFormat],
    } as INetworkOptions;
  }

  public async tearDown(): Promise<void> {
    await this.ledger.stop();
    await this.ledger.destroy();
  }
}
