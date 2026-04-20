import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { pruneDocker } from "../utils";
import {
  EthereumTestEnvironment,
  SupportedContractTypes,
} from "./ethereum-environment";
import { ClaimFormat } from "@hyperledger/cactus-plugin-satp-hermes";

const LOG_LEVEL = "DEBUG" as LogLevelDesc;
const TIMEOUT = 1_000_000;

const LOG = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "besu-environment-test",
});

beforeAll(async () => pruneDocker(LOG_LEVEL, LOG));

afterAll(async () => pruneDocker(LOG_LEVEL, LOG));

describe("Besu Dummy Environment", () => {
  jest.setTimeout(TIMEOUT);

  let ethereumEnv: EthereumTestEnvironment;
  it(
    "should create a Besu environment",
    async () => {
      const erc20TokenContract = "SATPContract";
      const erc721TokenContract = "SATPNonFungibleContract";
      ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
        {
          logLevel: LOG_LEVEL,
        },
        [
          {
            assetType: SupportedContractTypes.FUNGIBLE,
            contractName: erc20TokenContract,
          },
          {
            assetType: SupportedContractTypes.NONFUNGIBLE,
            contractName: erc721TokenContract,
          },
        ],
      );

      expect(ethereumEnv).toBeDefined();
    },
    TIMEOUT,
  );

  it(
    "should deploy Besu contracts and setup environment",
    async () => {
      await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
    },
    TIMEOUT,
  );

  it(
    "should shutdown everything sucessfully",
    async () => {
      await ethereumEnv.tearDown();
    },
    TIMEOUT,
  );
});
