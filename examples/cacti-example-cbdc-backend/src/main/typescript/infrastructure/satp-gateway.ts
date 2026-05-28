import path from "node:path";
import { randomUUID } from "node:crypto";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { ICactusPlugin, PluginImportType } from "@hyperledger/cactus-core-api";
import {
  Address,
  GatewayIdentity,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
} from "@hyperledger/cactus-plugin-satp-hermes";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/core/constants";
import { Knex, knex } from "knex";
import { createMigrationSource } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile";
import { knexRemoteInstance } from "@hyperledger/cactus-plugin-satp-hermes/src/main/typescript/database/knexfile-remote";
import { ISatpGatewayRuntimeConfig } from "../config/types";

export interface SatpGatewayBuildOpts {
  gatewayConfig: ISatpGatewayRuntimeConfig;
  bridgeConfig: unknown[];
  ontologyPath: string;
  plugins: ICactusPlugin[];
  logLevel?: string;
}

export interface StartedSatpGateway {
  gateway: SATPGateway;
  knexLocal: Knex;
  knexRemote: Knex;
  shutdown: () => Promise<void>;
}

export async function startSatpGateway(
  opts: SatpGatewayBuildOpts,
): Promise<StartedSatpGateway> {
  const factory = new PluginFactorySATPGateway({
    pluginImportType: PluginImportType.Local,
  });

  const gatewayIdentity: GatewayIdentity = {
    id: opts.gatewayConfig.gatewayId,
    name: opts.gatewayConfig.gatewayId,
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: `${opts.gatewayConfig.gatewayId}-proof`,
    address: opts.gatewayConfig.baseUrl as Address,
  };

  const migrationSource = await createMigrationSource();
  const knexLocal = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  const knexRemote = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  await knexRemote.migrate.latest();

  const monitorService = MonitorService.createOrGetMonitorService({
    enabled: false,
  });

  const config: SATPGatewayConfig = {
    instanceId: randomUUID(),
    logLevel: (opts.logLevel ?? "INFO") as SATPGatewayConfig["logLevel"],
    gid: gatewayIdentity,
    ccConfig: { bridgeConfig: opts.bridgeConfig as never[] },
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    pluginRegistry: new PluginRegistry({ plugins: opts.plugins }),
    ontologyPath: path.resolve(opts.ontologyPath),
    monitorService,
  };

  const gateway = await factory.create(config);
  await gateway.startup();
  await gateway.getOrCreateHttpServer();

  return {
    gateway,
    knexLocal,
    knexRemote,
    shutdown: async () => {
      await gateway.shutdown();
      await knexLocal.destroy();
      await knexRemote.destroy();
    },
  };
}
