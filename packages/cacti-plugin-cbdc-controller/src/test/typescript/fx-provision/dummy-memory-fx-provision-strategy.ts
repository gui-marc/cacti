import {
  DynamicRange,
  FXProvisionStrategy,
  FXQuote,
} from "../../../main/typescript/core/fx-provision";
import { DummyInMemoryAMM } from "./dummy-memory-amm";

export class DummyMemoryFXProvisionStrategy extends FXProvisionStrategy {
  constructor(private readonly amm: DummyInMemoryAMM = new DummyInMemoryAMM()) {
    super();
  }

  getFXQuoteAndLockLiquidity(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote> {
    const quote = this.amm.getQuote(baseCurrency, destinationCurrency);

    if (priceRange.min !== undefined && quote.rate < priceRange.min) {
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
      );
    }

    if (priceRange.max !== undefined && quote.rate > priceRange.max) {
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
      );
    }

    this.amm.lockQuote(quote.id);
    return Promise.resolve(quote);
  }

  releaseLiquidity(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    const quote = this.amm.getQuote(baseCurrency, destinationCurrency);
    this.amm.releaseLiquidity(quote.id);
    return Promise.resolve();
  }

  confirmSettlement(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    // Noop
    return Promise.resolve();
  }
}
