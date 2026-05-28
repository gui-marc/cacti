import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { Request, Response } from "express";
import { RemoveComplianceEndpointEndpointV1 } from "../../../main/typescript/web-services/remove-compliance-endpoint-endpoint";
import {
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
  res.send = jest.fn().mockReturnValue(res) as unknown as Response["send"];
  return res as Response;
};

const buildReq = (id: string): Request =>
  ({
    body: {},
    params: { id },
    method: "DELETE",
    path: `/compliance-endpoint/${id}`,
  }) as unknown as Request;

const buildOptions = async (
  overrides: Partial<IRequestOptions> = {},
): Promise<{
  options: IRequestOptions;
  complianceStore: InMemoryComplianceEndpointsStore;
}> => {
  const partnersStore = new InMemoryPartnersStore();
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
  return { options, complianceStore };
};

describe("RemoveComplianceEndpointEndpointV1", () => {
  it("exposes the expected HTTP verb and path", async () => {
    const { options } = await buildOptions();
    const endpoint = new RemoveComplianceEndpointEndpointV1(options);
    expect(endpoint.getVerbLowerCase()).toBe("delete");
    expect(endpoint.getPath()).toBe("/compliance-endpoint/:id");
  });

  it("requires admin role via the authorization options provider", async () => {
    const { options } = await buildOptions();
    const endpoint = new RemoveComplianceEndpointEndpointV1(options);
    const authz = await endpoint.getAuthorizationOptionsProvider().get();
    expect(authz).toEqual({ isProtected: true, requiredRoles: ["admin"] });
  });

  it("rejects construction without complianceEndpointsStore", async () => {
    const { options } = await buildOptions();
    expect(
      () =>
        new RemoveComplianceEndpointEndpointV1({
          ...options,
          complianceEndpointsStore: undefined as never,
        }),
    ).toThrow(/complianceEndpointsStore/);
  });

  describe("handleRequest (auth disabled)", () => {
    let options: IRequestOptions;
    let complianceStore: InMemoryComplianceEndpointsStore;

    beforeEach(async () => {
      ({ options, complianceStore } = await buildOptions());
      await complianceStore.save({
        id: "endpoint-1",
        partnerId: "partner-a",
        url: "https://compliance.example.com",
      });
    });

    it("returns 204 and removes the endpoint when the id exists", async () => {
      const endpoint = new RemoveComplianceEndpointEndpointV1(options);
      const req = buildReq("endpoint-1");
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
      expect(await complianceStore.get("endpoint-1")).toBeNull();
    });

    it("returns 404 when the id does not exist", async () => {
      const endpoint = new RemoveComplianceEndpointEndpointV1(options);
      const req = buildReq("no-such-id");
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      const body = (res.json as unknown as jest.Mock).mock.calls[0][0] as {
        error: string;
      };
      expect(body.error).toBe("NOT_FOUND");
    });

    it("does not remove other endpoints when deleting one", async () => {
      await complianceStore.save({
        id: "endpoint-2",
        partnerId: "partner-b",
        url: "https://other.example.com",
      });
      const endpoint = new RemoveComplianceEndpointEndpointV1(options);
      const req = buildReq("endpoint-1");
      const res = buildRes();

      await endpoint.handleRequest(req, res);

      expect(await complianceStore.get("endpoint-2")).not.toBeNull();
    });

    it("returns 404 after an endpoint has already been deleted", async () => {
      const endpoint = new RemoveComplianceEndpointEndpointV1(options);
      const req = buildReq("endpoint-1");

      await endpoint.handleRequest(req, buildRes());

      const res2 = buildRes();
      await endpoint.handleRequest(req, res2);

      expect(res2.status).toHaveBeenCalledWith(404);
    });
  });
});
