import {
  TransactRequest,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LogLevelDesc } from "@hyperledger/cactus-common";
import CBDCController from "./core/cbdc-controller";

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

export type InitiateTransactionResult =
  | { kind: "completed"; transactionId: string }
  | { kind: "marked_for_review"; transactionId: string };

export interface IAcceptTransactionRequest {
  transactionId: string;
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
  COMPLETED,
  FAILED,
}

export interface ITransaction {
  id: string;
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

export interface IComplianceProvider {
  id: string;
  endpoint: string;
  apiKey: string;
}

export interface IFXProvider {
  id: string;
  endpoint: string;
  apiKey: string;
  supportedChains: string[];
}
