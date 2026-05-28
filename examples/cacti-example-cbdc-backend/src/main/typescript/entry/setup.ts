import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ICentralBankConfig,
  IChainRuntimeConfig,
  IPartnerConfig,
  ISeedUser,
} from "../config/types";
import { ChainCode } from "../types";

const RUNTIME_DIR =
  process.env.CBDC_RUNTIME_DIR ?? path.resolve(__dirname, "../../../runtime");

// Hostnames each process is reachable at. Defaults to localhost for host-mode
// dev; in docker-compose these are set to the service names (cb-besu, etc).
const HOST_CB_BESU = process.env.HOST_CB_BESU ?? "localhost";
const HOST_CB_ETH = process.env.HOST_CB_ETH ?? "localhost";
const HOST_PARTNER_A = process.env.HOST_PARTNER_A ?? "localhost";
const HOST_PARTNER_B = process.env.HOST_PARTNER_B ?? "localhost";
const HOST_BESU = process.env.HOST_BESU ?? "localhost";
const HOST_GETH = process.env.HOST_GETH ?? "localhost";

function generateSecret(): string {
  return randomBytes(48).toString("base64");
}

function makeChainConfig(
  chainCode: ChainCode,
  networkId: string,
  rpcHttpUrl: string,
  rpcWsUrl: string,
): IChainRuntimeConfig {
  return {
    chainCode,
    networkId,
    rpcHttpUrl,
    rpcWsUrl,
    cbdcContract: {
      contractName: "SATPTokenContract",
      contractAddress: "TO_BE_FILLED_BY_DEPLOY",
      ownerAddress: "TO_BE_FILLED_BY_DEPLOY",
      ownerPrivateKey: "TO_BE_FILLED_BY_DEPLOY",
    },
    satpWrapperAddress: "TO_BE_FILLED_BY_DEPLOY",
  };
}

const seedUsersA: ISeedUser[] = [
  {
    taxId: "111111111",
    password: "demo-password",
    displayName: "Alice (Bank A)",
    ledgerAccounts: { besu: "0xAlice", ethereum: "0xAlice" },
  },
  {
    taxId: "222222222",
    password: "demo-password",
    displayName: "Bob (Bank A)",
    ledgerAccounts: { besu: "0xBob", ethereum: "0xBob" },
  },
];

const seedUsersB: ISeedUser[] = [
  {
    taxId: "333333333",
    password: "demo-password",
    displayName: "Carol (Bank B)",
    ledgerAccounts: { besu: "0xCarol", ethereum: "0xCarol" },
  },
];

function main() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  const besuChain = makeChainConfig(
    "besu",
    "BesuExampleNetwork",
    `http://${HOST_BESU}:8545`,
    `ws://${HOST_BESU}:8546`,
  );
  const ethChain = makeChainConfig(
    "ethereum",
    "EthereumExampleNetwork",
    `http://${HOST_GETH}:8554`,
    `ws://${HOST_GETH}:8555`,
  );
  const chains: Record<ChainCode, IChainRuntimeConfig> = {
    besu: besuChain,
    ethereum: ethChain,
  };

  // Per-(partner, CB) HMAC secrets
  const secrets: Record<string, string> = {};
  for (const partner of ["partner-a", "partner-b"]) {
    for (const cb of ["besu", "ethereum"] as const) {
      secrets[`${partner}@${cb}`] = generateSecret();
    }
  }

  const cbBesu: ICentralBankConfig = {
    role: "central-bank",
    controllerId: "cb-besu",
    instanceId: "cb-besu-instance",
    httpPort: 4100,
    ownedChain: "besu",
    chains,
    satpGateway: {
      baseUrl: "http://localhost",
      serverPort: 3010,
      clientPort: 3011,
      gatewayId: "cb-besu-gateway",
    },
    partners: [
      {
        partnerId: "partner-a",
        apiKey: secrets["partner-a@besu"],
        complianceUrl: `http://${HOST_PARTNER_A}:5100/compliance/check`,
      },
      {
        partnerId: "partner-b",
        apiKey: secrets["partner-b@besu"],
        complianceUrl: `http://${HOST_PARTNER_B}:5200/compliance/check`,
      },
    ],
    fxRate: 1.0,
    sqlitePath: path.join(RUNTIME_DIR, "cb-besu.sqlite"),
    logLevel: "INFO",
    requireHttps: false,
    requireClientAuth: true,
  };

  const cbEth: ICentralBankConfig = {
    ...cbBesu,
    controllerId: "cb-ethereum",
    instanceId: "cb-eth-instance",
    httpPort: 4200,
    ownedChain: "ethereum",
    satpGateway: {
      baseUrl: "http://localhost",
      serverPort: 3020,
      clientPort: 3021,
      gatewayId: "cb-ethereum-gateway",
    },
    partners: [
      {
        partnerId: "partner-a",
        apiKey: secrets["partner-a@ethereum"],
        complianceUrl: `http://${HOST_PARTNER_A}:5100/compliance/check`,
      },
      {
        partnerId: "partner-b",
        apiKey: secrets["partner-b@ethereum"],
        complianceUrl: `http://${HOST_PARTNER_B}:5200/compliance/check`,
      },
    ],
    sqlitePath: path.join(RUNTIME_DIR, "cb-eth.sqlite"),
  };

  const partnerA: IPartnerConfig = {
    role: "partner",
    partnerId: "partner-a",
    instanceId: "partner-a-instance",
    httpPort: 5100,
    publicBaseUrl: `http://${HOST_PARTNER_A}:5100`,
    centralBanks: [
      {
        chainCode: "besu",
        baseUrl: `http://${HOST_CB_BESU}:4100`,
        apiKey: secrets["partner-a@besu"],
      },
      {
        chainCode: "ethereum",
        baseUrl: `http://${HOST_CB_ETH}:4200`,
        apiKey: secrets["partner-a@ethereum"],
      },
    ],
    chains,
    seedUsers: seedUsersA,
    sessionTtlSeconds: 60 * 60,
    sqlitePath: path.join(RUNTIME_DIR, "partner-a.sqlite"),
    logLevel: "INFO",
    cookieSecret: generateSecret(),
  };

  const partnerB: IPartnerConfig = {
    ...partnerA,
    partnerId: "partner-b",
    instanceId: "partner-b-instance",
    httpPort: 5200,
    publicBaseUrl: `http://${HOST_PARTNER_B}:5200`,
    centralBanks: [
      {
        chainCode: "besu",
        baseUrl: `http://${HOST_CB_BESU}:4100`,
        apiKey: secrets["partner-b@besu"],
      },
      {
        chainCode: "ethereum",
        baseUrl: `http://${HOST_CB_ETH}:4200`,
        apiKey: secrets["partner-b@ethereum"],
      },
    ],
    seedUsers: seedUsersB,
    sqlitePath: path.join(RUNTIME_DIR, "partner-b.sqlite"),
    cookieSecret: generateSecret(),
  };

  for (const [name, cfg] of [
    ["cb-besu.json", cbBesu],
    ["cb-eth.json", cbEth],
    ["partner-a.json", partnerA],
    ["partner-b.json", partnerB],
  ] as const) {
    const filePath = path.join(RUNTIME_DIR, name);
    fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
    console.log(`wrote ${filePath}`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. docker-compose up -d   # start Besu + Geth`);
  console.log(
    `  2. Fill in cbdcContract / satpWrapperAddress fields in the JSON configs`,
  );
  console.log(`     (deploy contracts and mint supply against the running chains)`);
  console.log(`  3. yarn dev               # start CBs + partners`);
}

main();
