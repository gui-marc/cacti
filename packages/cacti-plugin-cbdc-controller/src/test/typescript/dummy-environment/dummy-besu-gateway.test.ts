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
  const gateway1 = new DummyBesuGateway({
    logLevel: LOG_LEVEL,
  });
  const gateway2 = new DummyBesuGateway({
    logLevel: LOG_LEVEL,
    portModifier: 100, // This will make the second gateway use ports 3110, 3111, and 4110
  });

  it(
    "should initialize both gateways successfully",
    async () => {
      await Promise.all([gateway1.init(), gateway2.init()]);
    },
    TIMEOUT,
  );

  afterAll(async () => {
    await Promise.all([gateway1.stop(), gateway2.stop()]);
  });
});
