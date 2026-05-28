import { ChainCode } from "../types";

export type ProcessRole = "central-bank" | "partner";

export interface IContractRef {
  contractName: string;
  contractAddress: string;
  ownerAddress: string;
  ownerPrivateKey: string;
}

export interface IChainRuntimeConfig {
  chainCode: ChainCode;
  networkId: string;
  rpcHttpUrl: string;
  rpcWsUrl: string;
  cbdcContract: IContractRef;
  satpWrapperAddress: string;
}

export interface ISatpGatewayRuntimeConfig {
  baseUrl: string;
  serverPort: number;
  clientPort: number;
  gatewayId: string;
}

export interface IPartnerPeerConfig {
  partnerId: string;
  complianceUrl: string;
}

export interface IRegisteredPartner {
  partnerId: string;
  apiKey: string;
  complianceUrl: string;
}

export interface ICentralBankConfig {
  role: "central-bank";
  controllerId: string;
  instanceId: string;
  httpPort: number;
  ownedChain: ChainCode;
  chains: Record<ChainCode, IChainRuntimeConfig>;
  satpGateway: ISatpGatewayRuntimeConfig;
  partners: IRegisteredPartner[];
  fxRate: number;
  sqlitePath: string;
  logLevel: string;
  requireHttps: boolean;
  requireClientAuth: boolean;
}

export interface ISeedUser {
  taxId: string;
  password: string;
  displayName: string;
  ledgerAccounts: Record<ChainCode, string>;
}

export interface ICentralBankPeerConfig {
  chainCode: ChainCode;
  baseUrl: string;
  apiKey: string;
}

export interface IPartnerConfig {
  role: "partner";
  partnerId: string;
  instanceId: string;
  httpPort: number;
  publicBaseUrl: string;
  centralBanks: ICentralBankPeerConfig[];
  chains: Record<ChainCode, IChainRuntimeConfig>;
  seedUsers: ISeedUser[];
  sessionTtlSeconds: number;
  sqlitePath: string;
  logLevel: string;
  cookieSecret: string;
}

export type RuntimeConfig = ICentralBankConfig | IPartnerConfig;
