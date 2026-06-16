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

  async requestFXQuote(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
    priceRange: DynamicRange,
  ): Promise<FXQuote> {
    // Translate the rate range into on-chain output bounds enforced atomically
    // inside `lock()`. Non-finite / sentinel bounds collapse to "unbounded"
    // (0 means no max; a negative lower bound clamps to 0).
    const minAmountOut =
      priceRange.min !== undefined && Number.isFinite(priceRange.min)
        ? Math.max(0, Math.floor(amount * priceRange.min))
        : 0;
    const maxRaw = priceRange.max !== undefined ? amount * priceRange.max : 0;
    const maxAmountOut =
      Number.isFinite(maxRaw) && maxRaw > 0 && maxRaw < Number.MAX_SAFE_INTEGER
        ? Math.floor(maxRaw)
        : 0;

    try {
      return await this.besuAMM.lock(
        transactionId,
        baseCurrency,
        destinationCurrency,
        amount,
        this.recipient,
        this.signingCredential,
        { minAmountOut, maxAmountOut },
      );
    } catch (error) {
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
        { cause: error },
      );
    }
  }

  async releaseLiquidity(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _amount: number,
  ): Promise<void> {
    await this.besuAMM.release(
      transactionId,
      baseCurrency,
      destinationCurrency,
      this.signingCredential,
    );
  }

  async confirmSettlement(
    transactionId: string,
    baseCurrency: string,
    destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    await this.besuAMM.settle(
      transactionId,
      baseCurrency,
      destinationCurrency,
      amount,
      this.signingCredential,
    );
  }
}
