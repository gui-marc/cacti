import {
  DynamicRange,
  FXProvisionStrategy,
  FXQuote,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";

export class ConstantFxProvisionStrategy extends FXProvisionStrategy {
  constructor(private readonly rate: number) {
    super();
  }

  requestFXQuote(
    baseCurrency: string,
    destinationCurrency: string,
    _amount: number,
    _priceRange: DynamicRange,
  ): Promise<FXQuote> {
    return Promise.resolve({
      id: "constant-quote",
      availableLiquidity: Number.POSITIVE_INFINITY,
      baseCurrency,
      destinationCurrency,
      rate: this.rate,
    });
  }

  releaseLiquidity(): Promise<void> {
    return Promise.resolve();
  }

  confirmSettlement(): Promise<void> {
    return Promise.resolve();
  }
}
