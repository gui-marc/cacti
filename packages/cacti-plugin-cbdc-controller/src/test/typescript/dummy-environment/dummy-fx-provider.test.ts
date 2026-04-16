import { DummyFXProvider } from "./dummy-fx-provider";

describe("Dummy FX Provider", () => {
  const provider = new DummyFXProvider({
    port: 3001,
  });

  it("should be able to start", async () => {
    await provider.start();
  });

  it("should return the correct FX rate", async () => {
    const response = await fetch(provider.getEndpoint(), {
      method: "POST",
      body: JSON.stringify({
        transactionId: "tx123",
        sourceChainId: "chainA",
        destinationChainId: "chainB",
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    expect(data.fxRate).toBe(1.5);
    expect(data.transactionId).toBe("tx123");
  });

  it("should allow changing the next FX rate", async () => {
    provider.setNextRate(2.0);

    const response = await fetch(provider.getEndpoint(), {
      method: "POST",
      body: JSON.stringify({
        transactionId: "tx456",
        sourceChainId: "chainA",
        destinationChainId: "chainB",
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    expect(data.fxRate).toBe(2.0);
    expect(data.transactionId).toBe("tx456");
  });

  afterAll(async () => {
    await provider.stop();
  });
});
