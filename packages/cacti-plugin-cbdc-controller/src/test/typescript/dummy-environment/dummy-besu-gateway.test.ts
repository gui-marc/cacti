import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { DummyBesuGateway } from "./dummy-besu-gateway";
import { pruneDocker } from "../utils";

const LOG_LEVEL = "DEBUG" as LogLevelDesc;
const TIMEOUT = 1_000_000;

const LOG = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "besu-environment-test",
});

beforeAll(async () => pruneDocker(LOG_LEVEL, LOG));

afterAll(async () => pruneDocker(LOG_LEVEL, LOG));

describe("Dummy Besu Gateway Test", () => {
  const gateway = new DummyBesuGateway({
    logLevel: LOG_LEVEL,
  });

  it(
    "should initialize successfully",
    async () => {
      await gateway.init();
    },
    TIMEOUT,
  );
});
