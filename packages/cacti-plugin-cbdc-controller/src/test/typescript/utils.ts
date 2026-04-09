import { Logger, LogLevelDesc } from "@hyperledger/cactus-common";
import {
  Containers,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import { fail } from "assert";

export abstract class MockedServer {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
}

export function getUserFromPseudonim(user: string): string {
  switch (user) {
    case "Alice":
      return "userA";
    case "Charlie":
      return "userB";
    case "Bridge":
      return "bridge";
    default:
      throw new Error(`User pseudonym not found for user: ${user}`);
  }
}

export async function pruneDocker(logLevel: LogLevelDesc, log: Logger) {
  try {
    await pruneDockerAllIfGithubAction({ logLevel });
    log.info("Pruning docker containers successful");
  } catch (err) {
    await Containers.logDiagnostics({ logLevel });
    fail(`Failed to prune docker containers: ${err}`);
  }
}
