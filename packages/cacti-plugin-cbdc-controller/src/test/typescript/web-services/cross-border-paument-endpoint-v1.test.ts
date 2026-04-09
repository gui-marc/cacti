import { PluginCBDCController } from "../../../main/typescript/plugin-cbdc";
import { InMemoryComplianceProvidersStore } from "../../../main/typescript/store/compliance-providers-store";
import { InMemoryFXProvidersStore } from "../../../main/typescript/store/fx-providers-store";
import { InMemoryTransactionStore } from "../../../main/typescript/store/transaction-store";
import { BesuEnvironment } from "../dummy-environment/besu-environment";

describe("CrossBorderPaymentEndpointV1", () => {
  const plugin = new PluginCBDCController({
    instanceId: "test-instance",
    logLevel: "DEBUG",
    complianceProvidersStore: new InMemoryComplianceProvidersStore(),
    fxProvidersStore: new InMemoryFXProvidersStore(),
    transactionStore: new InMemoryTransactionStore(),
    environments: {
      "cbdc-a": new BesuEnvironment(),
      "cbdc-b": new BesuEnvironment(),
    },
    satpConfig: {},
  });
});
