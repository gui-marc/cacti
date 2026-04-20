export interface FXQuote {
  id: string;
  baseCurrency: string;
  destinationCurrency: string;
  rate: number;
  availableLiquidity: number;
}

type DynamicRange =
  | { min?: number; max: number }
  | { min: number; max?: number }
  | { min: number; max: number };

export abstract class FXProvision {
  abstract getFXQuoteAndLockLiquidity(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote>;

  abstract releaseLiquidity(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void>;

  abstract confirmSettlement(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void>;
}
