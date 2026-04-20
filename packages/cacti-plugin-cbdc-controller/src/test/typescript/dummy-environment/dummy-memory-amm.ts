import { randomUUID } from "crypto";
import { FXQuote } from "../../../main/typescript/core/fx-provision";

export class DummyInMemoryAMM {
  private liquidity: Record<string, number>;
  private quotes: Record<string, FXQuote>;

  constructor() {
    this.liquidity = {};
    this.quotes = {};
  }

  public addLiquidity(currency: string, amount: number): void {
    if (!this.liquidity[currency]) {
      this.liquidity[currency] = 0;
    }
    this.liquidity[currency] += amount;
  }

  public getLiquidity(currency: string): number {
    return this.liquidity[currency] || 0;
  }

  public getQuote(baseCurrency: string, destinationCurrency: string): FXQuote {
    // Simplified quote calculation - replace with actual AMM logic
    const baseLiquidity = this.getLiquidity(baseCurrency);
    const destinationLiquidity = this.getLiquidity(destinationCurrency);

    if (baseLiquidity === 0 || destinationLiquidity === 0) {
      throw new Error("Insufficient liquidity");
    }

    const rate = destinationLiquidity / baseLiquidity;
    const quote = {
      id: randomUUID(),
      baseCurrency,
      destinationCurrency,
      rate,
      availableLiquidity: destinationLiquidity,
    } satisfies FXQuote;

    this.quotes[quote.id] = quote;

    return quote;
  }

  public lockQuote(quoteId: string): void {
    const quote = this.quotes[quoteId];
    if (!quote) {
      throw new Error("Quote not found");
    }

    const requiredDestinationAmount = quote.availableLiquidity;

    if (
      this.getLiquidity(quote.destinationCurrency) < requiredDestinationAmount
    ) {
      throw new Error("Insufficient liquidity to lock");
    }

    this.liquidity[quote.destinationCurrency] -= requiredDestinationAmount;
  }

  public releaseLiquidity(quoteId: string): void {
    const quote = this.quotes[quoteId];
    if (!quote) {
      throw new Error("Quote not found");
    }

    this.liquidity[quote.destinationCurrency] += quote.availableLiquidity;
  }
}
