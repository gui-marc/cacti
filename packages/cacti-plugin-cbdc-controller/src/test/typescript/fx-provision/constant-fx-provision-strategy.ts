/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  DynamicRange,
  FXProvisionStrategy,
  FXQuote,
} from "../../../main/typescript/core/fx-provision";

export default class ConstantFxProvisionStrategy extends FXProvisionStrategy {
  constructor(private readonly rate: number) {
    super();
  }

  requestFXQuote(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote> {
    return Promise.resolve({
      id: "constant-quote",
      availableLiquidity: Number.POSITIVE_INFINITY,
      baseCurrency,
      destinationCurrency,
      rate: this.rate,
    } satisfies FXQuote);
  }

  releaseLiquidity(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    return Promise.resolve(); // noop
  }

  confirmSettlement(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    return Promise.resolve(); // noop
  }
}
