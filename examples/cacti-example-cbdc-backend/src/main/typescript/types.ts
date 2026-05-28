export type ChainCode = "besu" | "ethereum";

export interface ICustomer {
  id: string;
  taxId: string;
  passwordHash: string;
  displayName: string;
  ledgerAccounts: Record<ChainCode, string>;
}

export interface ISession {
  id: string;
  customerId: string;
  expiresAt: Date;
}

export interface IPartnerTransactionRecord {
  id: string;
  controllerTransactionId: string;
  customerId: string;
  sourceChainCode: ChainCode;
  destinationChainCode: ChainCode;
  receiverAddress: string;
  amount: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
