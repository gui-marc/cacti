import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import axios from "axios";
import { randomBytes } from "node:crypto";
import {
  ILedgerEnvironment,
  generatePartnerSecret,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { startCentralBank } from "../../main/typescript/central-bank/cb-app";
import { startPartner } from "../../main/typescript/partner/partner-app";
import {
  ICentralBankConfig,
  IPartnerConfig,
  IChainRuntimeConfig,
} from "../../main/typescript/config/types";
import { ChainCode } from "../../main/typescript/types";

const PARTNER_ID = "partner-a";
const PARTNER_PORT = 5901;
const CB_BESU_PORT = 4901;
const CB_ETH_PORT = 4902;

let tmpDir: string;
let stopCbBesu: () => Promise<void>;
let stopCbEth: () => Promise<void>;
let stopPartner: () => Promise<void>;
let secretBesu: string;
let secretEth: string;

function chainCfg(chain: ChainCode): IChainRuntimeConfig {
  return {
    chainCode: chain,
    networkId: `${chain}-test`,
    rpcHttpUrl: "http://unused",
    rpcWsUrl: "ws://unused",
    cbdcContract: {
      contractName: "Stub",
      contractAddress: "0x0",
      ownerAddress: "0x0",
      ownerPrivateKey: "0x0",
    },
    satpWrapperAddress: "0x0",
  };
}

function makeStubEnv(chain: ChainCode): ILedgerEnvironment {
  return {
    getAsset(id: string, amount: number) {
      // Minimal stub — values are pass-through; SATP isn't running.
      return {
        contractName: `stub-${chain}`,
        contractAddress: "0x0",
        ercTokenStandard: "ERC20",
        id,
        networkId: { id: `${chain}-test`, ledgerType: "BESU_2X" as never },
        tokenType: "FUNGIBLE" as never,
        owner: "0x0",
        referenceId: "stub",
        amount: amount.toString(),
      } as never;
    },
    async transact() {
      return { sessionID: "stub-session" } as never;
    },
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbdc-example-test-"));
  secretBesu = generatePartnerSecret();
  secretEth = generatePartnerSecret();

  const chains: Record<ChainCode, IChainRuntimeConfig> = {
    besu: chainCfg("besu"),
    ethereum: chainCfg("ethereum"),
  };

  const cbBesuCfg: ICentralBankConfig = {
    role: "central-bank",
    controllerId: "cb-besu",
    instanceId: "cb-besu",
    httpPort: CB_BESU_PORT,
    ownedChain: "besu",
    chains,
    satpGateway: {
      baseUrl: "http://localhost",
      serverPort: 0,
      clientPort: 0,
      gatewayId: "cb-besu",
    },
    partners: [
      {
        partnerId: PARTNER_ID,
        apiKey: secretBesu,
        complianceUrl: `http://localhost:${PARTNER_PORT}/compliance/check`,
      },
    ],
    fxRate: 1.0,
    sqlitePath: path.join(tmpDir, "cb-besu.sqlite"),
    logLevel: "WARN",
    requireHttps: false,
    requireClientAuth: true,
  };

  const cbEthCfg: ICentralBankConfig = {
    ...cbBesuCfg,
    controllerId: "cb-ethereum",
    instanceId: "cb-eth",
    httpPort: CB_ETH_PORT,
    ownedChain: "ethereum",
    satpGateway: { ...cbBesuCfg.satpGateway, gatewayId: "cb-eth" },
    partners: [
      {
        partnerId: PARTNER_ID,
        apiKey: secretEth,
        complianceUrl: `http://localhost:${PARTNER_PORT}/compliance/check`,
      },
    ],
    sqlitePath: path.join(tmpDir, "cb-eth.sqlite"),
  };

  const cbBesu = await startCentralBank({
    config: cbBesuCfg,
    bridgeConfig: [],
    ontologyPath: __dirname,
    skipSatpGateway: true,
    buildEnvironments: () => ({
      besu: makeStubEnv("besu"),
      ethereum: makeStubEnv("ethereum"),
    }),
  });
  stopCbBesu = cbBesu.shutdown;

  const cbEth = await startCentralBank({
    config: cbEthCfg,
    bridgeConfig: [],
    ontologyPath: __dirname,
    skipSatpGateway: true,
    buildEnvironments: () => ({
      besu: makeStubEnv("besu"),
      ethereum: makeStubEnv("ethereum"),
    }),
  });
  stopCbEth = cbEth.shutdown;

  const partnerCfg: IPartnerConfig = {
    role: "partner",
    partnerId: PARTNER_ID,
    instanceId: PARTNER_ID,
    httpPort: PARTNER_PORT,
    publicBaseUrl: `http://localhost:${PARTNER_PORT}`,
    centralBanks: [
      {
        chainCode: "besu",
        baseUrl: `http://localhost:${CB_BESU_PORT}`,
        apiKey: secretBesu,
      },
      {
        chainCode: "ethereum",
        baseUrl: `http://localhost:${CB_ETH_PORT}`,
        apiKey: secretEth,
      },
    ],
    chains,
    seedUsers: [
      {
        taxId: "999999999",
        password: "demo-password",
        displayName: "Test User",
        ledgerAccounts: { besu: "0xSenderBesu", ethereum: "0xSenderEth" },
      },
    ],
    sessionTtlSeconds: 600,
    sqlitePath: path.join(tmpDir, "partner-a.sqlite"),
    logLevel: "WARN",
    cookieSecret: randomBytes(32).toString("base64"),
  };

  const partner = await startPartner({
    config: partnerCfg,
    balanceReaders: {
      besu: { read: async () => "100" },
      ethereum: { read: async () => "0" },
    },
  });
  stopPartner = partner.shutdown;
}, 30_000);

afterAll(async () => {
  await stopPartner?.();
  await stopCbBesu?.();
  await stopCbEth?.();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("partner <-> central-bank handshake", () => {
  it("logs in, reads /me, /balance, /transactions", async () => {
    const base = `http://localhost:${PARTNER_PORT}`;
    const jar: string[] = [];
    const captureCookies = (res: { headers: Record<string, unknown> }) => {
      const set = res.headers["set-cookie"];
      if (Array.isArray(set)) jar.push(...(set as string[]));
    };
    const cookie = () =>
      jar.map((c) => c.split(";")[0]).join("; ");

    const login = await axios.post(
      `${base}/auth/login`,
      { taxId: "999999999", password: "demo-password" },
      { validateStatus: () => true },
    );
    captureCookies(login);
    expect(login.status).toBe(200);
    expect(login.data.taxId).toBe("999999999");

    const me = await axios.get(`${base}/me`, {
      headers: { cookie: cookie() },
    });
    expect(me.status).toBe(200);
    expect(me.data.id).toBeTruthy();

    const bal = await axios.get(`${base}/balance?chain=besu`, {
      headers: { cookie: cookie() },
    });
    expect(bal.status).toBe(200);
    expect(bal.data.balance).toBe("100");

    const txs = await axios.get(`${base}/transactions`, {
      headers: { cookie: cookie() },
    });
    expect(txs.status).toBe(200);
    expect(txs.data).toEqual([]);
  }, 30_000);

  it("forwards a transaction through the signed envelope to the CB", async () => {
    const base = `http://localhost:${PARTNER_PORT}`;
    const jar: string[] = [];
    const login = await axios.post(
      `${base}/auth/login`,
      { taxId: "999999999", password: "demo-password" },
      { validateStatus: () => true },
    );
    const set = login.headers["set-cookie"];
    if (Array.isArray(set)) jar.push(...(set as string[]));
    const cookie = jar.map((c) => c.split(";")[0]).join("; ");

    const created = await axios.post(
      `${base}/transactions`,
      {
        sourceChain: "besu",
        destinationChain: "ethereum",
        receiverAddress: "0xReceiver",
        amount: 10,
        complianceProviders: [],
      },
      { headers: { cookie }, validateStatus: () => true },
    );

    expect(created.status).toBe(201);
    expect(created.data.controllerTransactionId).toBeTruthy();
    expect(created.data.sourceChain).toBe("besu");
    expect(created.data.destinationChain).toBe("ethereum");
    expect(created.data.amount).toBe(10);

    const list = await axios.get(`${base}/transactions`, {
      headers: { cookie },
    });
    expect(list.data).toHaveLength(1);
  }, 30_000);
});
