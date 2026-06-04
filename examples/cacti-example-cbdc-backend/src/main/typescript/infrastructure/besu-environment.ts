import {
  PluginLedgerConnectorBesu,
  Web3SigningCredentialType,
  EthContractInvocationType,
  IPluginLedgerConnectorBesuOptions,
  ReceiptType,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { BesuTestLedger } from "@hyperledger/cactus-test-tooling";
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
import OntologyERC20Besu from "../../../../../../packages/cacti-plugin-cbdc-controller/dist/lib/test/json/ontologies/ontology-satp-erc20-interact-besu.json";

/* ---------------------------------------------------------------- *
 *  Runtime ILedgerEnvironment adapter (config-driven entrypoints)  *
 * ---------------------------------------------------------------- */

export interface BesuEnvironmentDeps {
  config: IChainRuntimeConfig;
  contractAbi: unknown[];
  ontologyReferenceId: string;
  transact: (request: TransactRequest) => Promise<TransactResponse>;
}

export class BesuRuntimeEnvironment implements ILedgerEnvironment {
  private readonly network: NetworkId;
  constructor(private readonly deps: BesuEnvironmentDeps) {
    this.network = {
      id: deps.config.networkId,
      ledgerType: LedgerType.Besu2X,
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

export function createBesuConnector(
  config: IChainRuntimeConfig,
  contractJson: { contractName: string; abi: unknown[]; bytecode: { object: string } },
): {
  connector: PluginLedgerConnectorBesu;
  keychain: PluginKeychainMemory;
  options: IPluginLedgerConnectorBesuOptions;
} {
  const keychainEntryKey = randomUUID();
  const keychain = new PluginKeychainMemory({
    instanceId: randomUUID(),
    keychainId: randomUUID(),
    backend: new Map([[keychainEntryKey, config.cbdcContract.ownerPrivateKey]]),
  });
  keychain.set(contractJson.contractName, JSON.stringify(contractJson));
  const options: IPluginLedgerConnectorBesuOptions = {
    instanceId: randomUUID(),
    rpcApiHttpHost: config.rpcHttpUrl,
    rpcApiWsHost: config.rpcWsUrl,
    pluginRegistry: new PluginRegistry({ plugins: [keychain] }),
  };
  return { connector: new PluginLedgerConnectorBesu(options), keychain, options };
}

export async function readBesuBalance(
  connector: PluginLedgerConnectorBesu,
  keychainId: string,
  config: IChainRuntimeConfig,
  contractAbi: unknown[],
  account: string,
): Promise<string> {
  const response = await connector.invokeContract({
    contractName: config.cbdcContract.contractName,
    contractAddress: config.cbdcContract.contractAddress,
    contractAbi,
    keychainId,
    invocationType: EthContractInvocationType.Call,
    methodName: "balanceOf",
    params: [account],
    signingCredential: {
      ethAccount: config.cbdcContract.ownerAddress,
      secret: config.cbdcContract.ownerPrivateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
    gas: 1_000_000,
  });
  return String(response.callOutput ?? "0");
}

export {
  AssetErcTokenStandardEnum,
  AssetTokenTypeEnum,
};

/* ---------------------------------------------------------------- *
 *  LocalBesuEnvironment — runtime-friendly equivalent of the       *
 *  cacti-plugin-cbdc-controller test BesuTestEnvironment.          *
 *                                                                  *
 *  Starts a BesuTestLedger container, deploys SATPTokenContract,   *
 *  funds a bridge account, and offers a small operational API     *
 *  (createAccount / mint / grantBridgeRole / approve / balance).   *
 *  No @jest/globals dependency.                                    *
 * ---------------------------------------------------------------- */

export interface LocalBesuEnvironmentOptions {
  logLevel?: LogLevelDesc;
  contractName: string;
  claimFormat: ClaimFormat;
  dockerNetwork?: string;
}

export interface LedgerAccount {
  address: string;
  privateKey: string;
}

const BESU_GAS_LIMIT = "999999999999999";
const DEFAULT_ASSET_ID = "BesuLocalEnvAsset";
// Must match a key the SATP gateway's (mock) PriceManager recognizes, since it
// converts transfer amounts to USD by networkId — otherwise it throws
// PriceNotFoundError. See packages/cactus-plugin-satp-hermes price-manager.ts.
const NETWORK_ID = "BesuLedgerTestNetwork";

export class LocalBesuEnvironment {
  public readonly network: NetworkId = {
    id: NETWORK_ID,
    ledgerType: LedgerType.Besu2X,
  };

  private readonly log: Logger;
  private readonly logLevel: LogLevelDesc;
  private readonly claimFormat: ClaimFormat;
  private readonly contractName: string;

  private ledger!: BesuTestLedger;
  private connector!: PluginLedgerConnectorBesu;
  private keychain!: PluginKeychainMemory;
  private connectorOptions!: IPluginLedgerConnectorBesuOptions;

  private ownerAccount!: string;
  private ownerPrivateKey!: string;
  private bridgeAccount!: LedgerAccount;
  private contractAddress: string = "";

  private constructor(opts: LocalBesuEnvironmentOptions) {
    this.logLevel = opts.logLevel ?? "INFO";
    this.claimFormat = opts.claimFormat;
    this.contractName = opts.contractName;
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "LocalBesuEnvironment",
    });
  }

  public static async start(
    opts: LocalBesuEnvironmentOptions,
  ): Promise<LocalBesuEnvironment> {
    const env = new LocalBesuEnvironment(opts);
    await env.bootstrap(opts.dockerNetwork);
    return env;
  }

  private async bootstrap(dockerNetwork?: string): Promise<void> {
    this.log.info(`starting BesuTestLedger`);
    this.ledger = new BesuTestLedger({
      emitContainerLogs: true,
      envVars: ["BESU_NETWORK=dev"],
      containerImageVersion: "v2.2.0-rc.2",
      containerImageName: "ghcr.io/hyperledger-cacti/besu-all-in-one",
      networkName: dockerNetwork,
    });
    await this.ledger.start(false);

    const rpcApiHttpHost = await this.ledger.getRpcApiHttpHost();
    const rpcApiWsHost = await this.ledger.getRpcApiWsHost();

    this.ownerAccount = this.ledger.getGenesisAccountPubKey();
    this.ownerPrivateKey = this.ledger.getGenesisAccountPrivKey();
    this.bridgeAccount = await this.ledger.createEthTestAccount();

    const keychainEntryKey = randomUUID();
    this.keychain = new PluginKeychainMemory({
      instanceId: randomUUID(),
      keychainId: randomUUID(),
      backend: new Map([[keychainEntryKey, this.ownerPrivateKey]]),
      logLevel: this.logLevel,
    });
    await this.keychain.set(this.contractName, JSON.stringify(SATPTokenContract));

    this.connectorOptions = {
      instanceId: randomUUID(),
      rpcApiHttpHost,
      rpcApiWsHost,
      pluginRegistry: new PluginRegistry({ plugins: [this.keychain] }),
      logLevel: this.logLevel,
    };
    this.connector = new PluginLedgerConnectorBesu(this.connectorOptions);

    await this.connector.transact({
      web3SigningCredential: {
        ethAccount: this.ownerAccount,
        secret: this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      consistencyStrategy: {
        blockConfirmations: 0,
        receiptType: ReceiptType.NodeTxPoolAck,
      },
      transactionConfig: {
        from: this.ownerAccount,
        to: this.bridgeAccount.address,
        value: 10e9,
        gas: 1000000,
      },
    });

    await this.deployContract();
  }

  private async deployContract(): Promise<void> {
    const deployOut = await this.connector.deployContract({
      keychainId: this.keychain.getKeychainId(),
      contractName: this.contractName,
      contractAbi: SATPTokenContract.abi,
      constructorArgs: [this.ownerAccount],
      web3SigningCredential: {
        ethAccount: this.ownerAccount,
        secret: this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      bytecode: SATPTokenContract.bytecode.object,
      gas: Number(BESU_GAS_LIMIT),
    });
    const address = deployOut.transactionReceipt?.contractAddress;
    if (!address) {
      throw new Error("Besu SATPTokenContract deployment did not return an address");
    }
    this.contractAddress = address;
    this.log.info(`SATPTokenContract deployed at ${address}`);
  }

  // ---- account management ----

  /**
   * Create a brand-new Besu account funded with `seedMoneyWei` from the
   * genesis account. Useful for per-user wallet provisioning.
   */
  public async createAccount(
    seedMoneyWei: number = 10e9,
  ): Promise<LedgerAccount> {
    const account = await this.ledger.createEthTestAccount(seedMoneyWei);
    this.log.info(`created Besu account ${account.address}`);
    return { address: account.address, privateKey: account.privateKey };
  }

  // ---- contract ops ----

  public async mint(amount: string | number, to?: string): Promise<void> {
    const recipient = to ?? this.ownerAccount;
    const res = await this.connector.invokeContract({
      contractName: this.contractName,
      keychainId: this.keychain.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "mint",
      params: [recipient, amount.toString()],
      signingCredential: {
        ethAccount: this.ownerAccount,
        secret: this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: Number(BESU_GAS_LIMIT),
    });
    if (!res.success) throw new Error(`mint failed for ${recipient}`);
    this.log.info(`minted ${amount} to ${recipient}`);
  }

  public async grantBridgeRole(wrapperAddress: string): Promise<void> {
    const res = await this.connector.invokeContract({
      contractName: this.contractName,
      keychainId: this.keychain.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "grantBridgeRole",
      params: [wrapperAddress],
      signingCredential: {
        ethAccount: this.ownerAccount,
        secret: this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1_000_000,
    });
    if (!res.success) throw new Error(`grantBridgeRole failed for ${wrapperAddress}`);
  }

  /**
   * Approve `spender` to pull `amount` tokens. By default the genesis owner
   * signs; pass `signer` to approve from another wallet (e.g. a per-user
   * account that holds the funds being transferred).
   */
  public async approve(
    spender: string,
    amount: string | number,
    signer?: { ethAccount: string; secret: string },
  ): Promise<void> {
    const res = await this.connector.invokeContract({
      contractName: this.contractName,
      keychainId: this.keychain.getKeychainId(),
      invocationType: EthContractInvocationType.Send,
      methodName: "approve",
      params: [spender, Number(amount)],
      signingCredential: {
        ethAccount: signer?.ethAccount ?? this.ownerAccount,
        secret: signer?.secret ?? this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: Number(BESU_GAS_LIMIT),
    });
    if (!res.success) throw new Error(`approve failed for ${spender}`);
  }

  public async getBalance(account: string): Promise<string> {
    const res = await this.connector.invokeContract({
      contractName: this.contractName,
      contractAddress: this.contractAddress,
      contractAbi: SATPTokenContract.abi,
      invocationType: EthContractInvocationType.Call,
      methodName: "balanceOf",
      params: [account],
      signingCredential: {
        ethAccount: this.ownerAccount,
        secret: this.ownerPrivateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gas: 1_000_000,
    });
    return String(res.callOutput ?? "0");
  }

  // ---- getters / config builders ----

  public getOwnerAccount(): string {
    return this.ownerAccount;
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
      referenceId: OntologyERC20Besu.id,
      owner: this.ownerAccount,
      contractName: this.contractName,
      contractAddress: this.contractAddress,
      networkId: this.network,
      tokenType: AssetTokenTypeEnum.Fungible,
      ercTokenStandard: AssetErcTokenStandardEnum.Erc20,
    };
  }

  /**
   * SATP gateway `bridgeConfig` entry. The gateway deploys its own
   * wrapper contract — leave wrapper fields off.
   */
  public createBesuConfig(): INetworkOptions {
    return {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeAccount.address,
        secret: this.bridgeAccount.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      gasConfig: { gasLimit: BESU_GAS_LIMIT },
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
