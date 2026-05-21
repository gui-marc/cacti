import { describe, expect, it, jest } from "@jest/globals";
import { Request, Response } from "express";
import { InitiateTransactionEndpointV1 } from "../../../main/typescript/web-services/initiate-transaction-endpoint";
import {
  IInfrastructure,
  IInitiateTransactionRequest,
  IRequestOptions,
  InitiateTransactionResult,
} from "../../../main/typescript/types";
import CBDCController from "../../../main/typescript/core/cbdc-controller";

const buildRequest = (
  overrides: Partial<IInitiateTransactionRequest> = {},
): IInitiateTransactionRequest => ({
  sourceChainCode: "network-a",
  destinationChainCode: "network-b",
  senderAddress: "0xsender",
  receiverAddress: "0xreceiver",
  amount: 100,
  timeToExpire: new Date("2099-01-01T00:00:00Z"),
  complianceProviders: ["dummy"],
  ...overrides,
});

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
  return res as Response;
};

const buildEndpoint = (initiateResult: InitiateTransactionResult) => {
  const initiateTransaction = jest
    .fn<CBDCController["initiateTransaction"]>()
    .mockResolvedValue(initiateResult);
  const controller = { initiateTransaction } as unknown as CBDCController;
  const infrastructure = { environments: {} } as IInfrastructure;
  const options: IRequestOptions = {
    controller,
    infrastructure,
    logLevel: "ERROR",
  };
  return {
    endpoint: new InitiateTransactionEndpointV1(options),
    initiateTransaction,
  };
};

describe("InitiateTransactionEndpointV1", () => {
  it("exposes the expected HTTP verb and path", () => {
    const { endpoint } = buildEndpoint({
      kind: "completed",
      transactionId: "tx-1",
    });
    expect(endpoint.getVerbLowerCase()).toBe("post");
    expect(endpoint.getPath()).toBe("/initiate-transaction");
  });

  it("requires admin role via the authorization options provider", async () => {
    const { endpoint } = buildEndpoint({
      kind: "completed",
      transactionId: "tx-1",
    });
    const authz = await endpoint.getAuthorizationOptionsProvider().get();
    expect(authz).toEqual({ isProtected: true, requiredRoles: ["admin"] });
  });

  it("rejects construction without infrastructure", () => {
    const options = {
      controller: {} as CBDCController,
      logLevel: "ERROR" as const,
    } as IRequestOptions;
    expect(() => new InitiateTransactionEndpointV1(options)).toThrow(
      /options.infrastructure/,
    );
  });

  it("returns 200 with the transactionId when the controller completes the transaction", async () => {
    const { endpoint, initiateTransaction } = buildEndpoint({
      kind: "completed",
      transactionId: "tx-200",
    });
    const body = buildRequest();
    const req = { body } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(initiateTransaction).toHaveBeenCalledWith(body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ transactionId: "tx-200" });
  });

  it("returns 202 with MARKED_FOR_REVIEW when the controller flags the transaction for review", async () => {
    const { endpoint } = buildEndpoint({
      kind: "marked_for_review",
      transactionId: "tx-202",
    });
    const req = { body: buildRequest() } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      transactionId: "tx-202",
      status: "MARKED_FOR_REVIEW",
    });
  });

  it("propagates errors raised by the controller", async () => {
    const initiateTransaction = jest
      .fn<CBDCController["initiateTransaction"]>()
      .mockRejectedValue(new Error("boom"));
    const controller = { initiateTransaction } as unknown as CBDCController;
    const endpoint = new InitiateTransactionEndpointV1({
      controller,
      infrastructure: { environments: {} } as IInfrastructure,
      logLevel: "ERROR",
    });
    const req = { body: buildRequest() } as Request;
    const res = buildRes();

    await expect(endpoint.handleRequest(req, res)).rejects.toThrow("boom");
    expect(res.status).not.toHaveBeenCalled();
  });
});
