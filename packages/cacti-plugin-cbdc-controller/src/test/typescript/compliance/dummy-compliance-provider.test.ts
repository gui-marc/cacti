import { describe, expect, it, afterAll } from "@jest/globals";
import axios from "axios";
import { ComplianceResult } from "../../../main/typescript/types";
import {
  ISignedEnvelope,
  generatePartnerSecret,
  signRequest,
  verifyResponse,
} from "../../../main/typescript/core/partner-signing";
import { DummyComplianceProvider } from "./dummy-compliance-provider";

interface IComplianceResponse {
  transactionId: string;
  result: ComplianceResult;
}

describe("Dummy Compliance Provider", () => {
  const controllerId = "test-controller";
  const partnerId = "test-bank";
  const secret = generatePartnerSecret();
  const provider = new DummyComplianceProvider({
    port: 3000,
    partnerId,
    apiKey: secret,
    controllerId,
    nextCheckResponse: ComplianceResult.APPROVED,
  });

  const sendSigned = async (txId: string) => {
    const { envelope, nonce } = signRequest(controllerId, secret, {
      transactionId: txId,
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xa",
      receiverAddress: "0xb",
      amount: 1,
    });
    const http = await axios.post<ISignedEnvelope>(
      provider.getEndpointUrl(),
      envelope,
    );
    return verifyResponse<IComplianceResponse>(
      partnerId,
      secret,
      nonce,
      http.data,
    );
  };

  it("should be able to start", async () => {
    await provider.start();
  });

  it("returns a signed APPROVED response bound to the request nonce", async () => {
    const verified = await sendSigned("tx-1");
    expect(verified.result).toBe(ComplianceResult.APPROVED);
    expect(verified.transactionId).toBe("tx-1");
  });

  it("allows changing the next check response", async () => {
    provider.setNextCheckResponse(ComplianceResult.REJECTED);
    const verified = await sendSigned("tx-2");
    expect(verified.result).toBe(ComplianceResult.REJECTED);
  });

  it("rejects an unsigned request with 401", async () => {
    await expect(
      axios.post(provider.getEndpointUrl(), { transactionId: "tx-3" }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("rejects a request signed with the wrong secret", async () => {
    const wrong = generatePartnerSecret();
    const { envelope } = signRequest(controllerId, wrong, {
      transactionId: "tx-4",
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xa",
      receiverAddress: "0xb",
      amount: 1,
    });
    await expect(
      axios.post(provider.getEndpointUrl(), envelope),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("rejects a request signed by a sender other than the configured controllerId", async () => {
    const { envelope } = signRequest("not-the-controller", secret, {
      transactionId: "tx-5",
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xa",
      receiverAddress: "0xb",
      amount: 1,
    });
    await expect(
      axios.post(provider.getEndpointUrl(), envelope),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  afterAll(async () => {
    await provider.stop();
  });
});
