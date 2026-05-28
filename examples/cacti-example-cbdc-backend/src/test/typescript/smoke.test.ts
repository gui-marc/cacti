import { describe, it, expect } from "@jest/globals";

/**
 * End-to-end smoke test scaffold for the CBDC example backend.
 *
 * The full E2E test boots:
 *   1. Besu + Geth test ledgers (BesuTestLedger / GethTestLedger)
 *   2. Deploys SATPTokenContract + SATPWrapperContract on each chain
 *   3. Starts two SATP Hermes gateways (one per central bank)
 *   4. Starts two CB processes (PluginCBDCController) and two partner Express apps
 *   5. Logs in as a seeded user, initiates a Besu -> Ethereum transfer via the
 *      partner's HTTP API, polls /transactions, asserts the destination balance
 *      moves and the source balance drops.
 *
 * The integration plumbing follows the pattern in
 * packages/cacti-plugin-cbdc-controller/src/test/typescript/integration/constant-fx-provision.test.ts.
 *
 * This file is intentionally a scaffold so the package builds and CI doesn't
 * spin up two ledger containers on every PR. To run the full flow locally:
 *   - docker-compose up -d   (or use the test envs to spin up in-process)
 *   - yarn setup
 *   - fill in contract addresses in runtime/*.json
 *   - yarn dev (or implement the full setup inside this test as in the
 *     constant-fx-provision integration test)
 */

describe("CBDC example backend (smoke)", () => {
  it("module surface is wired", async () => {
    const mod = await import("../../main/typescript");
    expect(typeof mod.loadConfig).toBe("function");
    expect(typeof mod.startCentralBank).toBe("function");
    expect(typeof mod.startPartner).toBe("function");
    expect(typeof mod.startSatpGateway).toBe("function");
    expect(typeof mod.ConstantFxProvisionStrategy).toBe("function");
  });
});
