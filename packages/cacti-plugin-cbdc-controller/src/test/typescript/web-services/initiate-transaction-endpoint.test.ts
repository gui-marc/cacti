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
import { PartnerSecurityService } from "../../../main/typescript/core/partner-security-service";
import {
  InMemoryPartnersStore,
  PartnersStore,
} from "../../../main/typescript/store/partners-store";
import { InMemoryComplianceEndpointsStore } from "../../../main/typescript/store/compliance-endpoints-store";

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

const buildSecurityService = (
  partnersStore: PartnersStore = new InMemoryPartnersStore(),
): PartnerSecurityService =>
  new PartnerSecurityService({
    controllerId: "test-controller",
    partnersStore,
  });

const buildEndpoint = (initiateResult: InitiateTransactionResult) => {
  const initiateTransaction = jest
    .fn<CBDCController["initiateTransaction"]>()
    .mockResolvedValue(initiateResult);
  const controller = { initiateTransaction } as unknown as CBDCController;
  const infrastructure = { environments: {} } as IInfrastructure;
  const options: IRequestOptions = {
    controller,
    infrastructure,
    partnerSecurityService: buildSecurityService(),
    complianceEndpointsStore: new InMemoryComplianceEndpointsStore(),
    partnersStore: new InMemoryPartnersStore(),
    requireClientAuth: false,
    requireHttps: true,
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
      partnerSecurityService: buildSecurityService(),
      requireClientAuth: false,
      logLevel: "ERROR" as const,
    } as IRequestOptions;
    expect(() => new InitiateTransactionEndpointV1(options)).toThrow(
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
    expect(() => new InitiateTransactionEndpointV1(options)).toThrow(
      /partnerSecurityService/,
    );
  });

  it("returns 200 with the transactionId when the controller completes the transaction (auth disabled)", async () => {
    const { endpoint, initiateTransaction } = buildEndpoint({
      kind: "completed",
      transactionId: "tx-200",
    });
    const body = buildRequest();
    const req = { body, method: "POST", path: "/" } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(initiateTransaction).toHaveBeenCalledWith({
      ...body,
      initiatorId: "test-controller",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ transactionId: "tx-200" });
  });

  it("returns 202 with MARKED_FOR_REVIEW when the controller flags the transaction for review", async () => {
    const { endpoint } = buildEndpoint({
      kind: "marked_for_review",
      transactionId: "tx-202",
    });
    const req = {
      body: buildRequest(),
      method: "POST",
      path: "/",
    } as Request;
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
      partnerSecurityService: buildSecurityService(),
      complianceEndpointsStore: new InMemoryComplianceEndpointsStore(),
      partnersStore: new InMemoryPartnersStore(),
      requireClientAuth: false,
      requireHttps: true,
      logLevel: "ERROR",
    });
    const req = {
      body: buildRequest(),
      method: "POST",
      path: "/",
    } as Request;
    const res = buildRes();

    await expect(endpoint.handleRequest(req, res)).rejects.toThrow("boom");
    expect(res.status).not.toHaveBeenCalled();
  });
});
