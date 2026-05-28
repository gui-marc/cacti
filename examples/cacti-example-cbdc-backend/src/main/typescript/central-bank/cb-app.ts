import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { LoggerProvider } from "@hyperledger/cactus-common";
import {
  PluginCBDCController,
  ILedgerEnvironment,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { ICentralBankConfig } from "../config/types";
import {
  applyCentralBankMigrations,
  openDatabase,
} from "../store/sqlite/db";
import { SqliteTransactionStore } from "../store/sqlite/sqlite-transaction-store";
import { SqlitePartnersStore } from "../store/sqlite/sqlite-partners-store";
import { SqliteComplianceEndpointsStore } from "../store/sqlite/sqlite-compliance-endpoints-store";
import { ConstantFxProvisionStrategy } from "./constant-fx-provision-strategy";
import { startSatpGateway, StartedSatpGateway } from "../infrastructure/satp-gateway";

export interface StartedCentralBank {
  httpServer: http.Server;
  shutdown: () => Promise<void>;
}

export interface CbAppDeps {
  config: ICentralBankConfig;
  buildEnvironments: (
    transact: (req: unknown) => Promise<unknown>,
  ) => Record<string, ILedgerEnvironment>;
  bridgeConfig: unknown[];
  ontologyPath: string;
  /** Skip starting the SATP Hermes gateway. The buildEnvironments callback
   *  must then return ILedgerEnvironments whose transact() does not delegate
   *  to a gateway dispatcher. Used by integration tests. */
  skipSatpGateway?: boolean;
}

export async function startCentralBank(
  deps: CbAppDeps,
): Promise<StartedCentralBank> {
  const { config } = deps;
  const log = LoggerProvider.getOrCreate({
    level: config.logLevel as never,
    label: `cb-${config.ownedChain}`,
  });

  const db = openDatabase(config.sqlitePath);
  applyCentralBankMigrations(db);

  const transactionStore = new SqliteTransactionStore(db);
  const partnersStore = new SqlitePartnersStore(db);
  const complianceEndpointsStore = new SqliteComplianceEndpointsStore(db);

  for (const partner of config.partners) {
    if (!(await partnersStore.get(partner.partnerId))) {
      await partnersStore.save({
        id: partner.partnerId,
        apiKey: partner.apiKey,
      });
    }
    const endpointId = `${partner.partnerId}-compliance`;
    if (!(await complianceEndpointsStore.get(endpointId))) {
      await complianceEndpointsStore.save({
        id: endpointId,
        partnerId: partner.partnerId,
        url: partner.complianceUrl,
      });
    }
  }

  let gatewayHandle: StartedSatpGateway | null = null;
  const transactDelegate = async (req: unknown) => {
    if (!gatewayHandle) {
      throw new Error("SATP gateway not ready yet");
    }
    return gatewayHandle.gateway.BLODispatcherInstance!.Transact(req as never);
  };

  const environments = deps.buildEnvironments(transactDelegate);

  const cbdcPlugin = new PluginCBDCController({
    instanceId: config.instanceId,
    controllerId: config.controllerId,
    partnersStore,
    complianceEndpointsStore,
    transactionStore,
    fxProvisionStrategy: new ConstantFxProvisionStrategy(config.fxRate),
    environments,
    logLevel: config.logLevel as never,
    requireHttps: config.requireHttps,
    requireClientAuth: config.requireClientAuth,
  });

  await cbdcPlugin.onPluginInit();

  if (!deps.skipSatpGateway) {
    gatewayHandle = await startSatpGateway({
      gatewayConfig: config.satpGateway,
      bridgeConfig: deps.bridgeConfig,
      ontologyPath: deps.ontologyPath,
      plugins: [cbdcPlugin],
      logLevel: config.logLevel,
    });
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", chain: config.ownedChain });
  });

  // Mount the plugin's express app at /cbdc
  const pluginApp = (cbdcPlugin as unknown as { webApplication: express.Express })
    .webApplication;
  if (pluginApp) {
    app.use("/cbdc", pluginApp);
  }

  const httpServer = app.listen(config.httpPort);
  await new Promise<void>((resolve) => httpServer.on("listening", resolve));
  log.info(
    `Central bank for chain ${config.ownedChain} listening on :${config.httpPort}`,
  );

  return {
    httpServer,
    shutdown: async () => {
      log.info("Shutting down central bank...");
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      if (gatewayHandle) {
        await gatewayHandle.shutdown();
      }
      db.close();
    },
  };
}

export function generateInstanceId(): string {
  return randomUUID();
}
