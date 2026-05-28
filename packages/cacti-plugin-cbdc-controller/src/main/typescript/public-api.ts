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

export { InMemoryPartnersStore, PartnersStore } from "./store/partners-store";

export {
  InMemoryComplianceEndpointsStore,
  ComplianceEndpointsStore,
} from "./store/compliance-endpoints-store";

export {
  FXProvisionStrategy,
  FXQuote,
  DynamicRange,
} from "./core/fx-provision";

export {
  PARTNER_SECRET_MIN_BYTES,
  PARTNER_SIGNING_VERSION,
  PARTNER_TIMESTAMP_WINDOW_MS,
  PARTNER_NONCE_TTL_MS,
  PartnerSigningError,
  ISignedEnvelope,
  ISignedRequest,
  IVerifiedRequest,
  IPartnerLookup,
  NonceCache,
  assertSecretStrength,
  generatePartnerSecret,
  generateNonce,
  parseEnvelope,
  signRequest,
  signResponse,
  verifyRequest,
  verifyResponse,
} from "./core/partner-signing";

export {
  PartnerSecurityService,
  IPartnerSecurityServiceOptions,
} from "./core/partner-security-service";

export { ICBDCControllerOptions } from "./core/cbdc-controller";

export {
  ILedgerEnvironment,
  IInfrastructure,
  IRequestOptions,
  IInitiateTransactionRequest,
  IInitiateTransactionCommand,
  IAcceptTransactionRequest,
  InitiateTransactionResult,
  ITransaction,
  TransactionStatus,
  ComplianceResult,
  IPartner,
  IComplianceEndpoint,
  IFXProvider,
  IGetFXRateRequest,
  IGetFXRateResponse,
  IGetComplianceCheckResponse,
} from "./types";
