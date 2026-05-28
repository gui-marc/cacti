import {
  PluginLedgerConnectorBesu,
  Web3SigningCredentialType,
  EthContractInvocationType,
  IPluginLedgerConnectorBesuOptions,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID } from "node:crypto";
import {
  AssetErcTokenStandardEnum,
  AssetTokenTypeEnum,
  NetworkId,
  TokenType,
  TransactRequest,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { ILedgerEnvironment } from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { IChainRuntimeConfig } from "../config/types";

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
