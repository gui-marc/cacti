import { describe, expect, it, jest } from "@jest/globals";
import { Request, Response } from "express";
import { InitiateTransactionEndpointV1 } from "../../../main/typescript/web-services/initiate-transaction-endpoint";
import { AcceptTransactionEndpointV1 } from "../../../main/typescript/web-services/accept-transaction-endpoint";
import {
  IInfrastructure,
  IRequestOptions,
} from "../../../main/typescript/types";
import CBDCController from "../../../main/typescript/core/cbdc-controller";
import { PartnerSecurityService } from "../../../main/typescript/core/partner-security-service";
import { InMemoryPartnersStore } from "../../../main/typescript/store/partners-store";
import {
  ISignedEnvelope,
  generatePartnerSecret,
  signRequest,
  signResponse,
  verifyResponse,
} from "../../../main/typescript/core/partner-signing";

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
  return res as Response;
};

const lastJsonBody = (res: Response): unknown => {
  const calls = (res.json as unknown as jest.Mock).mock.calls;
  return calls[calls.length - 1][0];
};

describe("Endpoint envelope verification (requireClientAuth=true)", () => {
  const controllerId = "test-controller";
  const initiatorId = "test-initiator";
  const initiatorSecret = generatePartnerSecret();
  const otherPartnerId = "test-other-partner";
  const otherSecret = generatePartnerSecret();

  const buildOptions = async () => {
    const partnersStore = new InMemoryPartnersStore();
    await partnersStore.save({ id: initiatorId, apiKey: initiatorSecret });
    await partnersStore.save({ id: otherPartnerId, apiKey: otherSecret });
    const securityService = new PartnerSecurityService({
      controllerId,
      partnersStore,
    });
    return { partnersStore, securityService };
  };

  const buildInitiateEndpoint = async (controller: Partial<CBDCController>) => {
    const { securityService } = await buildOptions();
    const options: IRequestOptions = {
      controller: controller as CBDCController,
      infrastructure: { environments: {} } as IInfrastructure,
      partnerSecurityService: securityService,
      requireClientAuth: true,
      logLevel: "ERROR",
    };
    return {
      endpoint: new InitiateTransactionEndpointV1(options),
      securityService,
    };
  };

  const buildAcceptEndpoint = async (controller: Partial<CBDCController>) => {
    const { securityService } = await buildOptions();
    const options: IRequestOptions = {
      controller: controller as CBDCController,
      infrastructure: { environments: {} } as IInfrastructure,
      partnerSecurityService: securityService,
      requireClientAuth: true,
      logLevel: "ERROR",
    };
    return {
      endpoint: new AcceptTransactionEndpointV1(options),
      securityService,
    };
  };

  it("rejects an unsigned request with 401", async () => {
    const initiate = jest.fn<CBDCController["initiateTransaction"]>();
    const { endpoint } = await buildInitiateEndpoint({
      initiateTransaction: initiate,
    });

    const req = {
      body: {
        sourceChainCode: "a",
        destinationChainCode: "b",
        senderAddress: "0xs",
        receiverAddress: "0xr",
        amount: 1,
        timeToExpire: new Date(),
        complianceProviders: [],
      },
      method: "POST",
      path: "/initiate-transaction",
    } as unknown as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("rejects a request signed by an unknown partner with 401", async () => {
    const initiate = jest.fn<CBDCController["initiateTransaction"]>();
    const { endpoint } = await buildInitiateEndpoint({
      initiateTransaction: initiate,
    });

    const { envelope } = signRequest("unknown-partner", initiatorSecret, {
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xs",
      receiverAddress: "0xr",
      amount: 1,
      timeToExpire: new Date(),
      complianceProviders: [],
    });

    const req = {
      body: envelope,
      method: "POST",
      path: "/initiate-transaction",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature was made with the wrong secret", async () => {
    const initiate = jest.fn<CBDCController["initiateTransaction"]>();
    const { endpoint } = await buildInitiateEndpoint({
      initiateTransaction: initiate,
    });

    // Sign as the initiator but with the *other* partner's secret.
    const { envelope } = signRequest(initiatorId, otherSecret, {
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xs",
      receiverAddress: "0xr",
      amount: 1,
      timeToExpire: new Date(),
      complianceProviders: [],
    });

    const req = {
      body: envelope,
      method: "POST",
      path: "/initiate-transaction",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("accepts a valid envelope, tags the transaction with the verified partnerId, and signs the response", async () => {
    const initiate = jest
      .fn<CBDCController["initiateTransaction"]>()
      .mockResolvedValue({ kind: "completed", transactionId: "tx-1" });
    const { endpoint, securityService } = await buildInitiateEndpoint({
      initiateTransaction: initiate,
    });

    const timeToExpire = new Date();
    const payload = {
      sourceChainCode: "a",
      destinationChainCode: "b",
      senderAddress: "0xs",
      receiverAddress: "0xr",
      amount: 1,
      timeToExpire,
      complianceProviders: [],
    };
    const { envelope, nonce } = signRequest(
      initiatorId,
      initiatorSecret,
      payload,
    );

    const req = {
      body: envelope,
      method: "POST",
      path: "/initiate-transaction",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(initiate).toHaveBeenCalledWith({
      ...payload,
      initiatorId,
      // The endpoint reconstructs Date from the JSON-serialized string.
      timeToExpire,
    });
    expect(res.status).toHaveBeenCalledWith(200);

    // The response should be a signed envelope bound to the request nonce.
    const responseEnvelope = lastJsonBody(res) as ISignedEnvelope;
    expect(responseEnvelope.partnerId).toBe(controllerId);
    const responsePayload = verifyResponse<{ transactionId: string }>(
      controllerId,
      initiatorSecret,
      nonce,
      responseEnvelope,
    );
    expect(responsePayload.transactionId).toBe("tx-1");
    void securityService;
  });

  it("forwards the verified partnerId to acceptTransaction so the controller can enforce ownership", async () => {
    const accept = jest
      .fn<CBDCController["acceptTransaction"]>()
      .mockResolvedValue(undefined);
    const { endpoint } = await buildAcceptEndpoint({
      acceptTransaction: accept,
    });

    const { envelope } = signRequest(otherPartnerId, otherSecret, {
      transactionId: "tx-not-mine",
    });

    const req = {
      body: envelope,
      method: "POST",
      path: "/accept-transaction",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(accept).toHaveBeenCalledWith("tx-not-mine", otherPartnerId);
  });

  it("returns 403 when the controller rejects an accept attempt by a non-initiator", async () => {
    const accept = jest
      .fn<CBDCController["acceptTransaction"]>()
      .mockRejectedValue(
        new Error(
          `Partner ${otherPartnerId} is not the initiator of transaction tx-mine and cannot accept it`,
        ),
      );
    const { endpoint } = await buildAcceptEndpoint({
      acceptTransaction: accept,
    });

    const { envelope } = signRequest(otherPartnerId, otherSecret, {
      transactionId: "tx-mine",
    });

    const req = {
      body: envelope,
      method: "POST",
      path: "/accept-transaction",
    } as Request;
    const res = buildRes();

    await endpoint.handleRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("PartnerSecurityService round-trip", () => {
  it("signs and verifies in both directions using the partner registry", async () => {
    const partnersStore = new InMemoryPartnersStore();
    const partnerId = "round-trip-bank";
    const apiKey = generatePartnerSecret();
    await partnersStore.save({ id: partnerId, apiKey });
    const svc = new PartnerSecurityService({
      controllerId: "ctrl",
      partnersStore,
    });

    const { envelope, nonce } = await svc.signOutgoingRequest(partnerId, {
      hello: "world",
    });

    // Simulate the partner verifying the request and signing a response.
    const responseEnvelope = signResponse(partnerId, apiKey, nonce, {
      answer: 42,
    });

    const verified = await svc.verifyIncomingResponse<{ answer: number }>(
      partnerId,
      nonce,
      responseEnvelope,
    );
    expect(verified.answer).toBe(42);
    void envelope;
  });
});
