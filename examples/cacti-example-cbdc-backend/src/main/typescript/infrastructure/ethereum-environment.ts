import {
  PluginLedgerConnectorEthereum,
  EthContractInvocationType,
  Web3SigningCredentialType,
  IPluginLedgerConnectorEthereumOptions,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID } from "node:crypto";
import {
  NetworkId,
  TokenType,
  TransactRequest,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { ILedgerEnvironment } from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { IChainRuntimeConfig } from "../config/types";

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
