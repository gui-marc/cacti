import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { BesuEnvironment } from "./besu-environment";
import { pruneDocker } from "../utils";

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

  const besuEnv = new BesuEnvironment(LOG_LEVEL);

  it(
    "should create a Besu environment",
    async () => {
      expect(besuEnv).toBeDefined();
      await besuEnv.init();
    },
    TIMEOUT,
  );

  it(
    "should deploy Besu contracts and setup environment",
    async () => {
      await besuEnv.deployAndSetupContracts();
    },
    TIMEOUT,
  );

  it(
    "should shutdown everything sucessfully",
    async () => {
      await besuEnv.tearDown();
    },
    TIMEOUT,
  );
});
