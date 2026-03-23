import { IPluginFactoryOptions } from "@hyperledger/cactus-core-api";
import { PluginFactoryCBDCController } from "./plugin-factry-cbdc";

export async function createPluginFactory(
  pluginFactoryOptions: IPluginFactoryOptions,
): Promise<PluginFactoryCBDCController> {
  return new PluginFactoryCBDCController(pluginFactoryOptions);
}
