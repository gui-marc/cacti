import { describe, expect, it, jest } from "@jest/globals";
import { Request, Response } from "express";
import { AcceptTransactionEndpointV1 } from "../../../main/typescript/web-services/accept-transaction-endpoint";
import {
  IInfrastructure,
  IRequestOptions,
} from "../../../main/typescript/types";
import CBDCController from "../../../main/typescript/core/cbdc-controller";
import { PartnerSecurityService } from "../../../main/typescript/core/partner-security-service";
import { InMemoryPartnersStore } from "../../../main/typescript/store/partners-store";

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
  return res as Response;
};

const buildSecurityService = () =>
  new PartnerSecurityService({
    controllerId: "test-controller",
    partnersStore: new InMemoryPartnersStore(),
  });

const buildEndpoint = () => {
  const acceptTransaction = jest
    .fn<CBDCController["acceptTransaction"]>()
    .mockResolvedValue(undefined);
  const controller = { acceptTransaction } as unknown as CBDCController;
  const options: IRequestOptions = {
    controller,
    infrastructure: { environments: {} } as IInfrastructure,
    partnerSecurityService: buildSecurityService(),
    requireClientAuth: false,
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
      partnerSecurityService: buildSecurityService(),
      requireClientAuth: false,
      logLevel: "ERROR" as const,
    } as IRequestOptions;
    expect(() => new AcceptTransactionEndpointV1(options)).toThrow(
      /options.infrastructure/,
    );
  });

  it("rejects construction without partnerSecurityService", () => {
    const options = {
      controller: {} as CBDCController,
      infrastructure: { environments: {} } as IInfrastructure,
      requireClientAuth: false,
      logLevel: "ERROR" as const,
    } as unknown as IRequestOptions;
    expect(() => new AcceptTransactionEndpointV1(options)).toThrow(
      /partnerSecurityService/,
    );
  });

  it("accepts the transaction and returns 200 with COMPLETED status (auth disabled)", async () => {
    const { endpoint, acceptTransaction } = buildEndpoint();
    const req = {
      body: { transactionId: "tx-accept-1" },
      method: "POST",
      path: "/",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(acceptTransaction).toHaveBeenCalledWith(
      "tx-accept-1",
      "test-controller",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      transactionId: "tx-accept-1",
      status: "COMPLETED",
    });
  });

  it("returns 403 when the controller rejects with an ownership error", async () => {
    const acceptTransaction = jest
      .fn<CBDCController["acceptTransaction"]>()
      .mockRejectedValue(
        new Error("Partner X is not the initiator of transaction Y"),
      );
    const controller = { acceptTransaction } as unknown as CBDCController;
    const endpoint = new AcceptTransactionEndpointV1({
      controller,
      infrastructure: { environments: {} } as IInfrastructure,
      partnerSecurityService: buildSecurityService(),
      requireClientAuth: false,
      logLevel: "ERROR",
    });
    const req = {
      body: { transactionId: "tx-1" },
      method: "POST",
      path: "/",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("propagates non-ownership errors raised by the controller", async () => {
    const acceptTransaction = jest
      .fn<CBDCController["acceptTransaction"]>()
      .mockRejectedValue(new Error("not found"));
    const controller = { acceptTransaction } as unknown as CBDCController;
    const endpoint = new AcceptTransactionEndpointV1({
      controller,
      infrastructure: { environments: {} } as IInfrastructure,
      partnerSecurityService: buildSecurityService(),
      requireClientAuth: false,
      logLevel: "ERROR",
    });
    const req = {
      body: { transactionId: "missing" },
      method: "POST",
      path: "/",
    } as Request;
    const res = buildRes();

    await expect(endpoint.handleRequest(req, res)).rejects.toThrow("not found");
  });
});
