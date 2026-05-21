import { IPluginFactoryOptions } from "@hyperledger/cactus-core-api";
import { PluginFactoryCBDCController } from "./plugin-factry-cbdc";

export async function createPluginFactory(
  pluginFactoryOptions: IPluginFactoryOptions,
): Promise<PluginFactoryCBDCController> {
  return new PluginFactoryCBDCController(pluginFactoryOptions);
}

export * from "./generated/openapi/typescript-axios";

export { PluginFactoryCBDCController } from "./plugin-factry-cbdc";

export { PluginCBDCController, IPluginCBDCOptions } from "./plugin-cbdc";

export {
  InMemoryTransactionStore,
  TransactionStore,
} from "./store/transaction-store";

export {
  InMemoryComplianceProvidersStore,
  ComplianceProvidersStore,
} from "./store/compliance-providers-store";

export {
  FXProvisionStrategy,
  FXQuote,
  DynamicRange,
} from "./core/fx-provision";

export {
  ILedgerEnvironment,
  IInfrastructure,
  IRequestOptions,
  IInitiateTransactionRequest,
  IAcceptTransactionRequest,
  InitiateTransactionResult,
  ITransaction,
  TransactionStatus,
  ComplianceResult,
  IComplianceProvider,
  IFXProvider,
  IGetFXRateRequest,
  IGetFXRateResponse,
  IGetComplianceCheckResponse,
} from "./types";
