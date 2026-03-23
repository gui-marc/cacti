import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";

import {
  ICactusPlugin,
  ICactusPluginOptions,
} from "@hyperledger/cactus-core-api";

export interface IPluginCBDCOptions extends ICactusPluginOptions {
  logLevel?: LogLevelDesc;
}

export class PluginCBDCController implements ICactusPlugin {
  public static readonly CLASS_NAME = "PluginCBDCController";

  private readonly instanceId: string;
  private readonly logLevel: LogLevelDesc;
  private readonly log: Logger;
  private readonly options: IPluginCBDCOptions;

  constructor(options: IPluginCBDCOptions) {
    this.logLevel = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.logLevel,
      label: "CBDCController",
    });
    this.options = options;
    this.instanceId = this.options.instanceId;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getPackageName(): string {
    return `@hyperledger-cacti/cacti-plugin-cbdc-controller`;
  }

  async onPluginInit(): Promise<unknown> {
    return;
  }
}
