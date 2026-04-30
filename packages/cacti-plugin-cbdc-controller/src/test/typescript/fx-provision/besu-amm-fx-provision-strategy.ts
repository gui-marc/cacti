import { Web3SigningCredential } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import {
  DynamicRange,
  FXProvisionStrategy,
  FXQuote,
} from "../../../main/typescript/core/fx-provision";
import { DummyBesuAMMEnvironment } from "./besu-amm";

export interface IBesuAMMFXProvisionStrategyOptions {
  besuAMM: DummyBesuAMMEnvironment;
  signingCredential: Web3SigningCredential;
  recipient: string;
}

export class BesuAMMFXProvisionStrategy extends FXProvisionStrategy {
  private readonly besuAMM: DummyBesuAMMEnvironment;
  private readonly signingCredential: Web3SigningCredential;
  private readonly recipient: string;

  constructor(options: IBesuAMMFXProvisionStrategyOptions) {
    super();
    this.besuAMM = options.besuAMM;
    this.signingCredential = options.signingCredential;
    this.recipient = options.recipient;
  }

  async getFXQuoteAndLockLiquidity(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote> {
    const quote = await this.besuAMM.getQuote(
      baseCurrency,
      destinationCurrency,
      amount,
    );

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

    return quote;
  }

  async releaseLiquidity(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _baseCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _destinationCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _amount: number,
  ): Promise<void> {
    // No-op: the AMM holds no per-quote lock, so there is nothing to release.
    return;
  }

  async confirmSettlement(
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    await this.besuAMM.swap(
      baseCurrency,
      destinationCurrency,
      amount,
      this.signingCredential,
      this.recipient,
    );
  }
}
