import { ChainCode } from "../../types";
import { IChainRuntimeConfig } from "../../config/types";

export interface BalanceReader {
  read(account: string): Promise<string>;
}

export class BalanceService {
  constructor(
    private readonly readers: Record<ChainCode, BalanceReader>,
    public readonly chainConfigs: Record<ChainCode, IChainRuntimeConfig>,
  ) {}

  async readBalance(chain: ChainCode, account: string): Promise<string> {
    const reader = this.readers[chain];
    if (!reader) throw new Error(`No balance reader for chain ${chain}`);
    return reader.read(account);
  }
}
