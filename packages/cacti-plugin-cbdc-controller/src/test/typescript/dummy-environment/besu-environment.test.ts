import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import {
  Containers,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import { BesuEnvironment } from "./besu-environment";

const LOG_LEVEL = "DEBUG" as LogLevelDesc;
const TIMEOUT = 1_000_000;

const LOG = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "besu-environment-test",
});

async function pruneDocker() {
  try {
    await pruneDockerAllIfGithubAction({ logLevel: LOG_LEVEL });
    LOG.info("Pruning throw OK");
  } catch (err) {
    await Containers.logDiagnostics({ logLevel: LOG_LEVEL });
    fail(`Failed to prune docker containers: ${err}`);
  }
}

beforeAll(pruneDocker);

afterAll(pruneDocker);

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
    "should shutdown everything sucessfully",
    async () => {
      await besuEnv.tearDown();
    },
    TIMEOUT,
  );
});
