import {
  IPluginFactoryOptions,
  PluginFactory,
} from "@hyperledger/cactus-core-api";
import { IPluginCBDCOptions, PluginCBDCController } from "./plugin-cbdc";

export class PluginFactoryCBDCController extends PluginFactory<
  PluginCBDCController,
  IPluginCBDCOptions,
  IPluginFactoryOptions
> {
  async create(options: IPluginCBDCOptions): Promise<PluginCBDCController> {
    return new PluginCBDCController(options);
  }
}
