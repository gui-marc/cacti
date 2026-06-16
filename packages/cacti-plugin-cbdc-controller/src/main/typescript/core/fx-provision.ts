export interface FXQuote {
  id: string;
  baseCurrency: string;
  destinationCurrency: string;
  rate: number;
  availableLiquidity: number;
}

export type DynamicRange =
  | { min?: number; max: number }
  | { min: number; max?: number }
  | { min: number; max: number };

export abstract class FXProvisionStrategy {
  // `transactionId` correlates the on-chain lock created by `requestFXQuote`
  // with the later `releaseLiquidity`/`confirmSettlement` calls. Callers must
  // pass the same id (e.g. the transaction id) across all three methods.
  abstract requestFXQuote(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote>;

  abstract releaseLiquidity(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void>;

  abstract confirmSettlement(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void>;
}
