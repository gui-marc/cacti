import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import http from "node:http";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { LoggerProvider } from "@hyperledger/cactus-common";
import { IPartnerConfig } from "../config/types";
import {
  applyPartnerMigrations,
  openDatabase,
} from "../store/sqlite/db";
import { SqliteCustomersStore } from "../store/sqlite/sqlite-customers-store";
import { SqliteSessionsStore } from "../store/sqlite/sqlite-sessions-store";
import { SqlitePartnerTransactionsStore } from "../store/sqlite/sqlite-partner-transactions-store";
import { AuthService } from "./services/auth-service";
import { ControllerClient } from "./services/controller-client";
import { BalanceService, BalanceReader } from "./services/balance-service";
import { ComplianceService, CbCallerLookup } from "./services/compliance-service";
import { ChainCode, ICustomer, IPartnerTransactionRecord } from "../types";

const SESSION_COOKIE = "cbdc_session";

export interface PartnerAppDeps {
  config: IPartnerConfig;
  balanceReaders: Record<ChainCode, BalanceReader>;
}

export interface StartedPartner {
  httpServer: http.Server;
  shutdown: () => Promise<void>;
}

export async function startPartner(deps: PartnerAppDeps): Promise<StartedPartner> {
  const { config } = deps;
  const log = LoggerProvider.getOrCreate({
    level: config.logLevel as never,
    label: `partner-${config.partnerId}`,
  });

  const db = openDatabase(config.sqlitePath);
  applyPartnerMigrations(db);

  const customers = new SqliteCustomersStore(db);
  const sessions = new SqliteSessionsStore(db);
  const partnerTxs = new SqlitePartnerTransactionsStore(db);

  for (const seed of config.seedUsers) {
    if (!customers.getByTaxId(seed.taxId)) {
      customers.save({
        id: randomUUID(),
        taxId: seed.taxId,
        passwordHash: await bcrypt.hash(seed.password, 10),
        displayName: seed.displayName,
        ledgerAccounts: seed.ledgerAccounts,
      });
    }
  }

  const auth = new AuthService(
    customers,
    sessions,
    config.sessionTtlSeconds * 1000,
  );
  const controllerClient = new ControllerClient(
    config.partnerId,
    config.centralBanks,
  );
  const balanceService = new BalanceService(deps.balanceReaders, config.chains);

  const callerLookup = new Map<string, CbCallerLookup>();
  for (const cb of config.centralBanks) {
    callerLookup.set(`cb-${cb.chainCode}`, {
      id: `cb-${cb.chainCode}`,
      apiKey: cb.apiKey,
    });
  }
  const compliance = new ComplianceService(config.partnerId, callerLookup);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser(config.cookieSecret));
  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", partnerId: config.partnerId });
  });

  app.post("/auth/login", async (req, res) => {
    const { taxId, password } = req.body ?? {};
    if (!taxId || !password) {
      return res.status(400).json({ error: "taxId and password required" });
    }
    const result = await auth.login(taxId, password);
    if (!result) return res.status(401).json({ error: "Invalid credentials" });
    setSessionCookie(res, result.session.id, config);
    return res.json(toMe(result.customer));
  });

  app.post("/auth/register", async (req, res) => {
    const { taxId, password, displayName } = req.body ?? {};
    if (!taxId || !password || !displayName) {
      return res
        .status(400)
        .json({ error: "taxId, password, displayName required" });
    }
    const ledgerAccounts: Record<ChainCode, string> = {
      besu: req.body?.besuAccount ?? "",
      ethereum: req.body?.ethereumAccount ?? "",
    };
    const result = await auth.register(
      taxId,
      password,
      displayName,
      ledgerAccounts,
    );
    if (!result) return res.status(409).json({ error: "User already exists" });
    setSessionCookie(res, result.session.id, config);
    return res.status(201).json(toMe(result.customer));
  });

  app.post("/auth/logout", (req, res) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) auth.logout(sid);
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    const customer = sid ? auth.resolve(sid) : null;
    if (!customer) return res.status(401).json({ error: "Not authenticated" });
    (req as Request & { customer: ICustomer }).customer = customer;
    next();
  };

  app.get("/me", requireAuth, (req, res) => {
    res.json(toMe((req as Request & { customer: ICustomer }).customer));
  });

  app.get("/balance", requireAuth, async (req, res) => {
    const chain = req.query.chain as ChainCode;
    if (chain !== "besu" && chain !== "ethereum") {
      return res.status(400).json({ error: "chain must be besu or ethereum" });
    }
    const customer = (req as Request & { customer: ICustomer }).customer;
    const account = customer.ledgerAccounts[chain];
    if (!account) return res.json({ chain, account: "", balance: "0" });
    const balance = await balanceService.readBalance(chain, account);
    return res.json({ chain, account, balance });
  });

  app.get("/transactions", requireAuth, (req, res) => {
    const customer = (req as Request & { customer: ICustomer }).customer;
    res.json(partnerTxs.listForCustomer(customer.id).map(toTxDto));
  });

  app.post("/transactions", requireAuth, async (req, res) => {
    const customer = (req as Request & { customer: ICustomer }).customer;
    const {
      sourceChain,
      destinationChain,
      receiverAddress,
      amount,
      complianceProviders = [],
      timeToExpireSeconds = 3600,
    } = req.body ?? {};
    if (!sourceChain || !destinationChain || !receiverAddress || !amount) {
      return res.status(400).json({ error: "missing required fields" });
    }
    const senderAddress = customer.ledgerAccounts[sourceChain as ChainCode];
    if (!senderAddress) {
      return res
        .status(400)
        .json({ error: `Customer has no ledger account on ${sourceChain}` });
    }
    const timeToExpire = new Date(
      Date.now() + timeToExpireSeconds * 1000,
    ).toISOString();

    let controllerResult;
    try {
      controllerResult = await controllerClient.initiateTransaction({
        sourceChainCode: sourceChain,
        destinationChainCode: destinationChain,
        senderAddress,
        receiverAddress,
        amount: Number(amount),
        timeToExpire,
        complianceProviders,
      });
    } catch (e) {
      log.error("Failed to initiate transaction", e);
      return res
        .status(502)
        .json({ error: "Failed to initiate transaction with central bank" });
    }

    const record: IPartnerTransactionRecord = {
      id: randomUUID(),
      controllerTransactionId: controllerResult.transactionId,
      customerId: customer.id,
      sourceChainCode: sourceChain,
      destinationChainCode: destinationChain,
      receiverAddress,
      amount: Number(amount),
      status: controllerResult.status ?? "SUBMITTED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    partnerTxs.create(record);
    return res.status(201).json(toTxDto(record));
  });

  app.post("/transactions/:id/accept", requireAuth, async (req, res) => {
    if (typeof req.params.id !== "string") {
      return res.status(400).json({ error: "invalid transaction id" });
    }

    const record = partnerTxs.get(req.params.id);
    if (!record) return res.status(404).json({ error: "not found" });
    const customer = (req as Request & { customer: ICustomer }).customer;
    if (record.customerId !== customer.id)
      return res.status(403).json({ error: "forbidden" });
    try {
      const result = await controllerClient.acceptTransaction(
        record.sourceChainCode,
        record.controllerTransactionId,
      );
      partnerTxs.updateStatus(record.id, result.status ?? "COMPLETED");
    } catch (e) {
      log.error("accept failed", e);
      return res.status(502).json({ error: "accept failed" });
    }
    const refreshed = partnerTxs.get(record.id)!;
    return res.json(toTxDto(refreshed));
  });

  app.post("/compliance/check", (req, res) => {
    try {
      const response = compliance.handleSignedRequest(req.body);
      res.json(response);
    } catch (e) {
      log.error("compliance check failed", e);
      res.status(400).json({ error: (e as Error).message });
    }
  });

  const httpServer = app.listen(config.httpPort);
  await new Promise<void>((resolve) => httpServer.on("listening", resolve));
  log.info(`Partner ${config.partnerId} listening on :${config.httpPort}`);

  return {
    httpServer,
    shutdown: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      db.close();
    },
  };
}

function setSessionCookie(
  res: Response,
  sessionId: string,
  config: IPartnerConfig,
): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: config.sessionTtlSeconds * 1000,
  });
}

function toMe(customer: ICustomer) {
  return {
    id: customer.id,
    taxId: customer.taxId,
    displayName: customer.displayName,
    ledgerAccounts: customer.ledgerAccounts,
  };
}

function toTxDto(record: IPartnerTransactionRecord) {
  return {
    id: record.id,
    controllerTransactionId: record.controllerTransactionId,
    sourceChain: record.sourceChainCode,
    destinationChain: record.destinationChainCode,
    receiverAddress: record.receiverAddress,
    amount: record.amount,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
