import { describe, expect, it, jest } from "@jest/globals";
import { Request, Response } from "express";
import { AcceptTransactionEndpointV1 } from "../../../main/typescript/web-services/accept-transaction-endpoint";
import {
  IInfrastructure,
  IRequestOptions,
} from "../../../main/typescript/types";
import CBDCController from "../../../main/typescript/core/cbdc-controller";

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
  return res as Response;
};

const buildEndpoint = () => {
  const acceptTransaction = jest
    .fn<CBDCController["acceptTransaction"]>()
    .mockResolvedValue(undefined);
  const controller = { acceptTransaction } as unknown as CBDCController;
  const options: IRequestOptions = {
    controller,
    infrastructure: { environments: {} } as IInfrastructure,
    logLevel: "ERROR",
  };
  return {
    endpoint: new AcceptTransactionEndpointV1(options),
    acceptTransaction,
  };
};

describe("AcceptTransactionEndpointV1", () => {
  it("exposes the expected HTTP verb and path", () => {
    const { endpoint } = buildEndpoint();
    expect(endpoint.getVerbLowerCase()).toBe("post");
    expect(endpoint.getPath()).toBe("/accept-transaction");
  });

  it("requires admin role via the authorization options provider", async () => {
    const { endpoint } = buildEndpoint();
    const authz = await endpoint.getAuthorizationOptionsProvider().get();
    expect(authz).toEqual({ isProtected: true, requiredRoles: ["admin"] });
  });

  it("rejects construction without infrastructure", () => {
    const options = {
      controller: {} as CBDCController,
      logLevel: "ERROR" as const,
    } as IRequestOptions;
    expect(() => new AcceptTransactionEndpointV1(options)).toThrow(
      /options.infrastructure/,
    );
  });

  it("accepts the transaction and returns 200 with COMPLETED status", async () => {
    const { endpoint, acceptTransaction } = buildEndpoint();
    const req = { body: { transactionId: "tx-accept-1" } } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(acceptTransaction).toHaveBeenCalledWith("tx-accept-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      transactionId: "tx-accept-1",
      status: "COMPLETED",
    });
  });

  it("propagates errors raised by the controller", async () => {
    const acceptTransaction = jest
      .fn<CBDCController["acceptTransaction"]>()
      .mockRejectedValue(new Error("not found"));
    const controller = { acceptTransaction } as unknown as CBDCController;
    const endpoint = new AcceptTransactionEndpointV1({
      controller,
      infrastructure: { environments: {} } as IInfrastructure,
      logLevel: "ERROR",
    });
    const req = { body: { transactionId: "missing" } } as Request;
    const res = buildRes();

    await expect(endpoint.handleRequest(req, res)).rejects.toThrow("not found");
    expect(res.status).not.toHaveBeenCalled();
  });
});
