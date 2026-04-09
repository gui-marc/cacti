import { IRequestOptions as SATPIRequestOptions } from "@hyperledger/cactus-plugin-satp-hermes/dist/lib/main/typescript/core/types";
import {
  AdminApi,
  TransactionApi,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { LogLevelDesc } from "@hyperledger/cactus-common";
import CBDCController from "./core/cbdc-controller";

export interface IInfrastructure {
  satpGateway: {
    transactionApi: TransactionApi;
    adminApi: AdminApi;
  };
  environments: Record<string, ILedgerEnvironment>;
}

export interface ILedgerEnvironment {
  getAsset(id: string, amount: number): Promise<string>;
}

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
  timeToExpire: number;
}

export enum ComplianceResult {
  APPROVED,
  REJECTED,
  MARKED_FOR_REVIEW,
}

export interface ISetComplianceCheckResultRequest {
  transactionId: string;
  result: ComplianceResult;
}

export interface ISetExchangeRateRequest {
  transactionId: string;
  sourceChainCode: string;
  destinationChainCode: string;
  fxRate: number;
}

export enum TransactionStatus {
  PENDING,
  SETTING_FX_RATE,
  COMPLIANCE_CHECKS,
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
  timeToExpire: number;
  status: TransactionStatus;
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
