import { describe, expect, it, jest } from "@jest/globals";
import {
  Configuration,
  TransactionsApi,
  InitiateTransactionRequest,
  InitiateTransactionResponseStatusEnum,
  AcceptTransactionResponseStatusEnum,
} from "../../../main/typescript/generated/openapi/typescript-axios";

describe("Generated typescript-axios client", () => {
  it("exposes the TransactionsApi with both operations", () => {
    const api = new TransactionsApi(
      new Configuration({ basePath: "http://localhost:4000" }),
    );
    expect(typeof api.initiateTransactionV1).toBe("function");
    expect(typeof api.acceptTransactionV1).toBe("function");
  });

  it("exposes typed enums matching the OpenAPI spec", () => {
    expect(InitiateTransactionResponseStatusEnum.MarkedForReview).toBe(
      "MARKED_FOR_REVIEW",
    );
    expect(AcceptTransactionResponseStatusEnum.Completed).toBe("COMPLETED");
  });

  it("sends a POST to the spec'd path with the request body", async () => {
    const axiosRequest = jest.fn(async () => ({
      data: { transactionId: "tx-generated" },
      status: 200,
    }));

    const api = new TransactionsApi(
      new Configuration({ basePath: "http://localhost:4000" }),
      undefined,
      // The generated client only invokes `request` on the axios instance.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { request: axiosRequest } as any,
    );

    const body: InitiateTransactionRequest = {
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xsender",
      receiverAddress: "0xreceiver",
      amount: 1,
      timeToExpire: new Date().toISOString(),
      complianceProviders: [],
    };

    const result = await api.initiateTransactionV1(body);

    expect(result.data).toEqual({ transactionId: "tx-generated" });
    expect(axiosRequest).toHaveBeenCalledTimes(1);
    const call = (
      axiosRequest.mock.calls as unknown as Array<
        [{ method: string; url: string; data: string }]
      >
    )[0][0];
    expect(call.method).toBe("POST");
    expect(call.url).toContain(
      "/api/v1/plugins/@hyperledger-cacti/cacti-plugin-cbdc-controller/initiate-transaction",
    );
    expect(JSON.parse(call.data)).toEqual(body);
  });
});
