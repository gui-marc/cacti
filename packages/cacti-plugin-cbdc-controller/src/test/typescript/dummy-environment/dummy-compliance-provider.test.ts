import { ComplianceResult } from "../../../main/typescript/types";
import { DummyComplianceProvider } from "./dummy-compliance-provider";

describe("Dummy Compliance Provider", () => {
  const provider = new DummyComplianceProvider({
    port: 3000,
    nextCheckResponse: ComplianceResult.APPROVED,
  });

  it("should be able to start", async () => {
    await provider.start();
  });

  it("should return the correct compliance result", async () => {
    const response = await fetch(provider.getEndpointUrl(), {
      method: "POST",
    });

    const data = await response.json();

    expect(data.result).toBe(ComplianceResult.APPROVED);
  });

  it("should allow changing the next check response", async () => {
    provider.setNextCheckResponse(ComplianceResult.REJECTED);

    const response = await fetch(provider.getEndpointUrl(), {
      method: "POST",
    });

    const data = await response.json();

    expect(data.result).toBe(ComplianceResult.REJECTED);
  });

  afterAll(async () => {
    await provider.stop();
  });
});
