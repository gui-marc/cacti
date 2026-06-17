import {
  TransactRequest,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LogLevelDesc } from "@hyperledger/cactus-common";
import CBDCController from "./core/cbdc-controller";
import { PartnerSecurityService } from "./core/partner-security-service";
import { ComplianceEndpointsStore } from "./store/compliance-endpoints-store";
import { PartnersStore } from "./store/partners-store";

export interface IInfrastructure {
  environments: Record<string, ILedgerEnvironment>;
}

export type ILedgerEnvironment = {
  getAsset(
    id: string,
    amount: number,
  ): Promise<TransactRequestSourceAsset> | TransactRequestSourceAsset;
  transact(request: TransactRequest): Promise<TransactResponse>;
};

export interface IRequestOptions {
  infrastructure: IInfrastructure;
  controller: CBDCController;
  partnerSecurityService: PartnerSecurityService;
  complianceEndpointsStore: ComplianceEndpointsStore;
  partnersStore: PartnersStore;
  requireClientAuth: boolean;
  requireHttps: boolean;
  logLevel?: LogLevelDesc;
}

export interface IInitiateTransactionRequest {
  sourceChainCode: string;
  destinationChainCode: string;
  senderAddress: string;
  receiverAddress: string;
  amount: number;
  timeToExpire: Date;
  complianceProviders: string[];
}

export interface IInitiateTransactionCommand extends IInitiateTransactionRequest {
  initiatorId: string;
}

export type InitiateTransactionResult =
  | { kind: "completed"; transactionId: string }
  | { kind: "marked_for_review"; transactionId: string };

export interface IAcceptTransactionRequest {
  transactionId: string;
}

export interface IAddComplianceEndpointRequest {
  partnerId: string;
  url: string;
}

export enum ComplianceResult {
  APPROVED,
  REJECTED,
  MARKED_FOR_REVIEW,
}

export interface IGetFXRateRequest {
  transactionId: string;
  sourceChain: string;
  destinationChain: string;
}
export interface IGetFXRateResponse {
  transactionId: string;
  fxRate: number;
}

export interface IGetComplianceCheckResponse {
  transactionId: string;
  result: ComplianceResult;
}

export enum TransactionStatus {
  PENDING,
  SETTING_FX_RATE,
  COMPLIANCE_CHECKS,
  MARKED_FOR_REVIEW,
  EXECUTING,
  // The off-ledger transfer succeeded but settling the FX leg has not yet been
  // confirmed after bounded retries; a reconciler must re-drive settle(id).
  SETTLEMENT_PENDING,
  COMPLETED,
  FAILED,
  EXPIRED,
}

export interface ITransaction {
  id: string;
  initiatorId: string;
  sourceChainCode: string;
  destinationChainCode: string;
  senderAddress: string;
  receiverAddress: string;
  amount: number;
  timeToExpire: Date;
  status: TransactionStatus;
  complianceProviders: string[];
  complianceResult?: ComplianceResult;
  fxRate?: number;
}

export interface IPartner {
  id: string;
  apiKey: string;
}

export interface IComplianceEndpoint {
  id: string;
  partnerId: string;
  url: string;
}

export interface IFXProvider {
  id: string;
  endpoint: string;
  apiKey: string;
  supportedChains: string[];
}
