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
