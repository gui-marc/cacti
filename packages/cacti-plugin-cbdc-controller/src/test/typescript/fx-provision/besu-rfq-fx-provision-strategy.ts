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

// Stateless RFQ strategy: the on-chain lock keyed by `keccak256(transactionId)`
// is the single source of truth, so this class keeps no in-memory pending map.
// Every method recomputes the lock from the transaction id alone, which makes
// releaseLiquidity / confirmSettlement idempotent and crash-safe.
export class BesuRFQFXProvisionStrategy extends FXProvisionStrategy {
  private readonly besuRFQ: DummyBesuRFQEnvironment;
  private readonly takerSigningCredential: Web3SigningCredential;
  private readonly takerAccount: string;

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
    const { fxQuote, quote, signature } = await this.besuRFQ.requestQuote(
      transactionId,
      baseCurrency,
      destinationCurrency,
      amount,
      this.takerAccount,
    );

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
      await this.besuRFQ.lock(quote, signature, this.takerSigningCredential, {
        minAmountOut,
        maxAmountOut,
      });
    } catch (error) {
      throw new Error(
        `No quotes available within the specified price range for ${baseCurrency}/${destinationCurrency}`,
        { cause: error },
      );
    }

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
    await this.besuRFQ.release(transactionId, this.takerSigningCredential);
  }

  async confirmSettlement(
    transactionId: string,
    baseCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _destinationCurrency: string,
    amount: number,
  ): Promise<void> {
    await this.besuRFQ.settle(
      transactionId,
      baseCurrency,
      amount,
      this.takerSigningCredential,
    );
  }
}
