import path from "node:path";
import exitHook from "async-exit-hook";
import { loadConfig } from "../config/config-loader";
import { ICentralBankConfig } from "../config/types";
import { startCentralBank } from "../central-bank/cb-app";

async function main() {
  const config = loadConfig() as ICentralBankConfig;
  if (config.role !== "central-bank") {
    throw new Error(
      `Expected role=central-bank but got role=${(config as { role: string }).role}`,
    );
  }

  // Bridge config and chain environments are wired by the operator at boot.
  // For the integration test path, see src/test/typescript/smoke.test.ts
  // which builds the same structures end-to-end.
  const ontologyPath = path.join(__dirname, "../../../json/ontologies");

  const cb = await startCentralBank({
    config,
    bridgeConfig: [],
    ontologyPath,
    buildEnvironments: () => {
      throw new Error(
        "Production environment builder not configured. " +
          "Wire BesuRuntimeEnvironment / EthereumRuntimeEnvironment per the smoke test for now.",
      );
    },
  });

  exitHook((done: any) => {
    cb.shutdown().then(done, done);
  });
}

main().catch((err) => {
  console.error("[central-bank] fatal:", err);
  process.exit(1);
});
