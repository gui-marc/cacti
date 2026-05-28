import exitHook from "async-exit-hook";
import { loadConfig } from "../config/config-loader";
import { IPartnerConfig } from "../config/types";
import { startPartner } from "../partner/partner-app";
import { BalanceReader } from "../partner/services/balance-service";
import { ChainCode } from "../types";

async function main() {
  const config = loadConfig() as IPartnerConfig;
  if (config.role !== "partner") {
    throw new Error(`Expected role=partner but got role=${config.role}`);
  }

  // For runtime balance lookups, wire BesuRuntimeEnvironment /
  // EthereumRuntimeEnvironment connectors per the smoke test. The stub below
  // returns "0" so the partner boots even before chain wiring is finished.
  const balanceReaders: Record<ChainCode, BalanceReader> = {
    besu: { read: async () => "0" },
    ethereum: { read: async () => "0" },
  };

  const partner = await startPartner({ config, balanceReaders });

  exitHook((done: any) => {
    partner.shutdown().then(done, done);
  });
}

main().catch((err) => {
  console.error("[partner] fatal:", err);
  process.exit(1);
});
