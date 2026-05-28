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
  COMPLIANCE_SECRET_MIN_BYTES,
  COMPLIANCE_SIGNING_VERSION,
  COMPLIANCE_TIMESTAMP_WINDOW_MS,
  COMPLIANCE_NONCE_TTL_MS,
  ComplianceSigningError,
  ISignedEnvelope,
  ISignedRequest,
  IVerifiedRequest,
  NonceCache,
  assertSecretStrength,
  generateComplianceProviderSecret,
  generateNonce,
  signRequest,
  signResponse,
  verifyRequest,
  verifyResponse,
} from "./core/compliance-signing";

export { ICBDCControllerOptions } from "./core/cbdc-controller";

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
