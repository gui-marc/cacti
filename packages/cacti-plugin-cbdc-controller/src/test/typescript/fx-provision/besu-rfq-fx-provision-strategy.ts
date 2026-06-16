import { Web3SigningCredential } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import {
  DynamicRange,
  FXProvisionStrategy,
  FXQuote,
} from "../../../main/typescript/core/fx-provision";
import { DummyBesuRFQEnvironment } from "./besu-rfq";

export interface IBesuRFQFXProvisionStrategyOptions {
  besuRFQ: DummyBesuRFQEnvironment;
  takerSigningCredential: Web3SigningCredential;
  takerAccount: string;
}

export class BesuRFQFXProvisionStrategy extends FXProvisionStrategy {
  private readonly besuRFQ: DummyBesuRFQEnvironment;
  private readonly takerSigningCredential: Web3SigningCredential;
  private readonly takerAccount: string;
  private readonly pending: Map<string, string> = new Map();

  constructor(options: IBesuRFQFXProvisionStrategyOptions) {
    super();
    this.besuRFQ = options.besuRFQ;
    this.takerSigningCredential = options.takerSigningCredential;
    this.takerAccount = options.takerAccount;
  }

  async requestFXQuote(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote> {
    const result = await this.besuRFQ.requestQuote(
      baseCurrency,
      destinationCurrency,
      amount,
      this.takerAccount,
    );

    const { fxQuote } = result;

    if (priceRange.min !== undefined && fxQuote.rate < priceRange.min) {
      await this.besuRFQ.releaseQuote(result.quoteId);
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
      );
    }

    if (priceRange.max !== undefined && fxQuote.rate > priceRange.max) {
      await this.besuRFQ.releaseQuote(result.quoteId);
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
      );
    }

    this.pending.set(transactionId, result.quoteId);

    return fxQuote;
  }

  async releaseLiquidity(
    transactionId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _baseCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _destinationCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _amount: number,
  ): Promise<void> {
    const quoteId = this.pending.get(transactionId);
    if (!quoteId) {
      return;
    }
    await this.besuRFQ.releaseQuote(quoteId);
    this.pending.delete(transactionId);
  }

  async confirmSettlement(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    const quoteId = this.pending.get(transactionId);
    if (!quoteId) {
      throw new Error(
        `No pending RFQ quote for tx=${transactionId} (${baseCurrency}->${destinationCurrency} amount=${amount})`,
      );
    }
    await this.besuRFQ.settleQuote(quoteId, this.takerSigningCredential);
    this.pending.delete(transactionId);
  }
}
