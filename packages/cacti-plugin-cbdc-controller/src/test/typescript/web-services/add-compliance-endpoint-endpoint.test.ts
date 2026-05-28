import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { Request, Response } from "express";
import { AddComplianceEndpointEndpointV1 } from "../../../main/typescript/web-services/add-compliance-endpoint-endpoint";
import {
  IAddComplianceEndpointRequest,
  IInfrastructure,
  IRequestOptions,
} from "../../../main/typescript/types";
import CBDCController from "../../../main/typescript/core/cbdc-controller";
import { PartnerSecurityService } from "../../../main/typescript/core/partner-security-service";
import { InMemoryPartnersStore } from "../../../main/typescript/store/partners-store";
import { InMemoryComplianceEndpointsStore } from "../../../main/typescript/store/compliance-endpoints-store";

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response["json"];
  return res as Response;
};

const buildReq = (body: Partial<IAddComplianceEndpointRequest> = {}): Request =>
  ({
    body: {
      partnerId: "partner-a",
      url: "https://compliance.example.com",
      ...body,
    },
    method: "POST",
    path: "/compliance-endpoint",
  }) as Request;

const buildOptions = async (
  overrides: Partial<IRequestOptions> = {},
): Promise<{
  options: IRequestOptions;
  partnersStore: InMemoryPartnersStore;
  complianceStore: InMemoryComplianceEndpointsStore;
}> => {
  const partnersStore = new InMemoryPartnersStore();
  await partnersStore.save({ id: "partner-a", apiKey: "a".repeat(32) });
  const complianceStore = new InMemoryComplianceEndpointsStore();
  const securityService = new PartnerSecurityService({
    controllerId: "test-controller",
    partnersStore,
  });
  const options: IRequestOptions = {
    controller: {} as CBDCController,
    infrastructure: { environments: {} } as IInfrastructure,
    partnerSecurityService: securityService,
    complianceEndpointsStore: complianceStore,
    partnersStore,
    requireClientAuth: false,
    requireHttps: true,
    logLevel: "ERROR",
    ...overrides,
  };
  return { options, partnersStore, complianceStore };
};

describe("AddComplianceEndpointEndpointV1", () => {
  it("exposes the expected HTTP verb and path", async () => {
    const { options } = await buildOptions();
    const endpoint = new AddComplianceEndpointEndpointV1(options);
    expect(endpoint.getVerbLowerCase()).toBe("post");
    expect(endpoint.getPath()).toBe("/compliance-endpoint");
  });

  it("requires admin role via the authorization options provider", async () => {
    const { options } = await buildOptions();
    const endpoint = new AddComplianceEndpointEndpointV1(options);
    const authz = await endpoint.getAuthorizationOptionsProvider().get();
    expect(authz).toEqual({ isProtected: true, requiredRoles: ["admin"] });
  });

  it("rejects construction without complianceEndpointsStore", async () => {
    const { options } = await buildOptions();
    expect(
      () =>
        new AddComplianceEndpointEndpointV1({
          ...options,
          complianceEndpointsStore: undefined as never,
        }),
    ).toThrow(/complianceEndpointsStore/);
  });

  it("rejects construction without partnersStore", async () => {
    const { options } = await buildOptions();
    expect(
      () =>
        new AddComplianceEndpointEndpointV1({
          ...options,
          partnersStore: undefined as never,
        }),
    ).toThrow(/partnersStore/);
  });

  describe("handleRequest (auth disabled)", () => {
    let options: IRequestOptions;
    let complianceStore: InMemoryComplianceEndpointsStore;

    beforeEach(async () => {
      ({ options, complianceStore } = await buildOptions());
    });

    it("returns 201 with the full endpoint object and stores it", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = buildReq();
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        id: string;
        partnerId: string;
        url: string;
      };
      expect(body.partnerId).toBe("partner-a");
      expect(body.url).toBe("https://compliance.example.com");
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);

      const stored = await complianceStore.get(body.id);
      expect(stored).toEqual({
        id: body.id,
        partnerId: "partner-a",
        url: "https://compliance.example.com",
      });
    });

    it("generates a unique id for each registered endpoint", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);

      const res1 = buildRes();
      await endpoint.handleRequest(buildReq(), res1);
      const body1 = (res1.json as unknown as jest.Mock).mock.calls[0][0] as {
        id: string;
      };

      const res2 = buildRes();
      await endpoint.handleRequest(buildReq(), res2);
      const body2 = (res2.json as unknown as jest.Mock).mock.calls[0][0] as {
        id: string;
      };

      expect(body1.id).not.toBe(body2.id);
    });

    it("returns 400 when partnerId is missing", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = {
        body: { url: "https://compliance.example.com" },
        method: "POST",
        path: "/",
      } as Request;
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        error: string;
      };
      expect(body.error).toBe("MISSING_FIELDS");
    });

    it("returns 400 when url is missing", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = {
        body: { partnerId: "partner-a" },
        method: "POST",
        path: "/",
      } as Request;
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        error: string;
      };
      expect(body.error).toBe("MISSING_FIELDS");
    });

    it("returns 400 when url is not HTTPS and requireHttps is true", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = buildReq({ url: "http://compliance.example.com" });
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        error: string;
      };
      expect(body.error).toBe("NON_HTTPS_URL");
    });

    it("allows non-HTTPS url when requireHttps is false", async () => {
      const { options: httpOptions } = await buildOptions({
        requireHttps: false,
      });
      const endpoint = new AddComplianceEndpointEndpointV1(httpOptions);
      const req = buildReq({ url: "http://compliance.example.com" });
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("returns 404 when partnerId does not exist in the partners store", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = buildReq({ partnerId: "unknown-partner" });
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        error: string;
      };
      expect(body.error).toBe("UNKNOWN_PARTNER");
    });

    it("does not store the endpoint when validation fails", async () => {
      const endpoint = new AddComplianceEndpointEndpointV1(options);
      const req = buildReq({ partnerId: "unknown-partner" });
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      const all = await complianceStore.getAll();
      expect(all).toHaveLength(0);
    });
  });
});
