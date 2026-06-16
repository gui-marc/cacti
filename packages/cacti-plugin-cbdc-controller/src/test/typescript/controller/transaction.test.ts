import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { InMemoryTransactionStore } from "../../../main/typescript/store/transaction-store";
import CBDCController from "../../../main/typescript/core/cbdc-controller";
import ConstantFxProvisionStrategy from "../../../test/typescript/fx-provision/constant-fx-provision-strategy";
import { InMemoryPartnersStore } from "../../../main/typescript/store/partners-store";
import { InMemoryComplianceEndpointsStore } from "../../../main/typescript/store/compliance-endpoints-store";
import { DummyComplianceProvider } from "../../../test/typescript/compliance/dummy-compliance-provider";
import { generatePartnerSecret } from "../../../main/typescript/core/partner-signing";
import { PartnerSecurityService } from "../../../main/typescript/core/partner-security-service";
import {
  ComplianceResult,
  ILedgerEnvironment,
  TransactionStatus,
} from "../../../main/typescript/types";
import {
  TokenType,
  Transact200ResponseStatusResponseStageEnum,
  Transact200ResponseStatusResponseStatusEnum,
  Transact200ResponseStatusResponseSubstatusEnum,
  TransactRequestSourceAsset,
  TransactResponse,
} from "@hyperledger/cactus-plugin-satp-hermes";

const logLevel = "DEBUG" as LogLevelDesc;
const log = LoggerProvider.getOrCreate({
  label: "CBDCTransactionControllerTest",
  level: logLevel,
});

describe("Transaction Controller", () => {
  const transactionStore = new InMemoryTransactionStore();
  const partnersStore = new InMemoryPartnersStore();
  const complianceEndpointsStore = new InMemoryComplianceEndpointsStore();
  const controllerId = "test-controller";
  const initiatorId = "test-initiator";
  const compliancePartnerId = "dummy-compliance-bank";
  const complianceEndpointId = "dummy-compliance-endpoint";
  const initiatorSecret = generatePartnerSecret();
  const complianceProviderSecret = generatePartnerSecret();

  const complianceProvider = new DummyComplianceProvider({
    port: 8081,
    partnerId: compliancePartnerId,
    apiKey: complianceProviderSecret,
    controllerId,
    nextCheckResponse: ComplianceResult.APPROVED,
  });

  partnersStore.save({ id: initiatorId, apiKey: initiatorSecret });
  partnersStore.save({
    id: compliancePartnerId,
    apiKey: complianceProviderSecret,
  });
  complianceEndpointsStore.save({
    id: complianceEndpointId,
    partnerId: compliancePartnerId,
    url: complianceProvider.getEndpointUrl(),
  });

  const partnerSecurityService = new PartnerSecurityService({
    controllerId,
    partnersStore,
  });

  const cbdc_a_environment = {
    getAsset(id, amount) {
      return {
        contractName: "TestFungibleContract",
        contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
        ercTokenStandard: "ERC20",
        id: id,
        networkId: {
          id: "network-a",
          ledgerType: "BESU_2X",
        },
        tokenType: TokenType.Fungible,
        owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        referenceId: "test-transaction-1",
        amount: amount.toString(),
      } satisfies TransactRequestSourceAsset;
    },
    transact(request) {
      log.debug("Received transaction request: %o", request);
      return Promise.resolve({
        sessionID: "test-session-id",
        statusResponse: {
          destinationNetwork: {
            id: "network-b",
          },
          originNetwork: {
            id: "network-a",
          },
          status: Transact200ResponseStatusResponseStatusEnum.Done,
          stage: Transact200ResponseStatusResponseStageEnum._3,
          startTime: new Date().toISOString(),
          step: "transfer-complete-message",
          substatus: Transact200ResponseStatusResponseSubstatusEnum.Completed,
        },
      } satisfies TransactResponse);
    },
  } satisfies ILedgerEnvironment;

  const cbdc_b_environment = {
    getAsset(id, amount) {
      return {
        contractName: "TestFungibleContract",
        contractAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        ercTokenStandard: "ERC20",
        id: id,
        networkId: {
          id: "network-b",
          ledgerType: "BESU_2X",
        },
        tokenType: TokenType.Fungible,
        owner: "0x1234567890abcdef1234567890abcdef12345678",
        referenceId: "test-transaction-1",
        amount: amount.toString(),
      } satisfies TransactRequestSourceAsset;
    },
    transact(request) {
      log.debug("Received transaction request: %o", request);
      return Promise.resolve({
        sessionID: "test-session-id",
        statusResponse: {
          destinationNetwork: {
            id: "network-a",
          },
          originNetwork: {
            id: "network-b",
          },
          status: Transact200ResponseStatusResponseStatusEnum.Done,
          stage: Transact200ResponseStatusResponseStageEnum._3,
          startTime: new Date().toISOString(),
          step: "transfer-complete-message",
          substatus: Transact200ResponseStatusResponseSubstatusEnum.Completed,
        },
      } satisfies TransactResponse);
    },
  } satisfies ILedgerEnvironment;

  it("should start dummy compliance provider", async () => {
    await complianceProvider.start();
  });

  it("should be able to complete a transaction sucessfully", async () => {
    const controller = new CBDCController({
      transactionStore,
      fxProvisionStrategy: new ConstantFxProvisionStrategy(0.5),
      complianceEndpointsStore,
      partnerSecurityService,
      infrastructure: {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
      requireHttps: false,
    });

    await controller.initiateTransaction({
      amount: 100,
      complianceProviders: [complianceEndpointId],
      initiatorId,
      sourceChainCode: "cbdc_a",
      destinationChainCode: "cbdc_b",
      receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
      timeToExpire: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    });
  });

  it("should fail if compliance check fails", async () => {
    complianceProvider.setNextCheckResponse(ComplianceResult.REJECTED);

    const controller = new CBDCController({
      transactionStore,
      fxProvisionStrategy: new ConstantFxProvisionStrategy(0.5),
      complianceEndpointsStore,
      partnerSecurityService,
      infrastructure: {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
      requireHttps: false,
    });

    const promise = controller.initiateTransaction({
      amount: 100,
      complianceProviders: [complianceEndpointId],
      initiatorId,
      sourceChainCode: "cbdc_a",
      destinationChainCode: "cbdc_b",
      receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
      timeToExpire: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    });

    await expect(promise).rejects.toThrow();
  });

  describe("MARKED_FOR_REVIEW handling", () => {
    let markedTransactionId: string;

    const controller = new CBDCController({
      transactionStore,
      fxProvisionStrategy: new ConstantFxProvisionStrategy(0.5),
      complianceEndpointsStore,
      partnerSecurityService,
      infrastructure: {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
      requireHttps: false,
    });

    it("should pause without performing SATP transfer when a provider marks for review", async () => {
      complianceProvider.setNextCheckResponse(
        ComplianceResult.MARKED_FOR_REVIEW,
      );

      const result = await controller.initiateTransaction({
        amount: 100,
        complianceProviders: [complianceEndpointId],
        initiatorId,
        sourceChainCode: "cbdc_a",
        destinationChainCode: "cbdc_b",
        receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
        timeToExpire: new Date(Date.now() + 60 * 60 * 1000),
      });

      expect(result.kind).toBe("marked_for_review");
      markedTransactionId = result.transactionId;

      const persisted = await transactionStore.get(markedTransactionId);
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(TransactionStatus.MARKED_FOR_REVIEW);
      expect(persisted!.complianceResult).toBe(
        ComplianceResult.MARKED_FOR_REVIEW,
      );
      expect(persisted!.fxRate).toBe(0.5);
    });

    it("should reject acceptTransaction for an unknown transaction id", async () => {
      await expect(
        controller.acceptTransaction("non-existent-id", initiatorId),
      ).rejects.toThrow(/not found/);
    });

    it("should reject acceptTransaction by a partner who is not the initiator", async () => {
      await expect(
        controller.acceptTransaction(markedTransactionId, "someone-else"),
      ).rejects.toThrow(/is not the initiator/);
    });

    it("should resume and complete a marked-for-review transaction via acceptTransaction", async () => {
      // The compliance provider's next response is irrelevant on the resume
      // path — acceptTransaction must not re-run compliance checks.
      complianceProvider.setNextCheckResponse(ComplianceResult.REJECTED);

      await controller.acceptTransaction(markedTransactionId, initiatorId);

      const persisted = await transactionStore.get(markedTransactionId);
      expect(persisted!.status).toBe(TransactionStatus.COMPLETED);
    });

    it("should reject acceptTransaction for a transaction not in MARKED_FOR_REVIEW status", async () => {
      // markedTransactionId is now COMPLETED from the previous test.
      await expect(
        controller.acceptTransaction(markedTransactionId, initiatorId),
      ).rejects.toThrow(/Cannot accept transaction/);
    });
  });

  describe("auto-expire on timeToExpire", () => {
    const fxStrategy = new ConstantFxProvisionStrategy(0.5);
    const releaseSpy = jest.spyOn(fxStrategy, "releaseLiquidity");

    const controller = new CBDCController({
      transactionStore,
      fxProvisionStrategy: fxStrategy,
      complianceEndpointsStore,
      partnerSecurityService,
      infrastructure: {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
      requireHttps: false,
    });

    beforeEach(() => {
      releaseSpy.mockClear();
    });

    it("transitions a MARKED_FOR_REVIEW transaction to EXPIRED when the deadline elapses", async () => {
      complianceProvider.setNextCheckResponse(
        ComplianceResult.MARKED_FOR_REVIEW,
      );

      const result = await controller.initiateTransaction({
        amount: 100,
        complianceProviders: [complianceEndpointId],
        initiatorId,
        sourceChainCode: "cbdc_a",
        destinationChainCode: "cbdc_b",
        receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
        timeToExpire: new Date(Date.now() + 300),
      });
      expect(result.kind).toBe("marked_for_review");

      // Sleep for 600 ms
      await new Promise((resolve) => setTimeout(resolve, 600));

      const persisted = await transactionStore.get(result.transactionId);
      expect(persisted!.status).toBe(TransactionStatus.EXPIRED);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(
        result.transactionId,
        "cbdc_a",
        "cbdc_b",
        100,
      );
    });

    it("clears the expiry timer when accepted before the deadline", async () => {
      complianceProvider.setNextCheckResponse(
        ComplianceResult.MARKED_FOR_REVIEW,
      );

      const result = await controller.initiateTransaction({
        amount: 100,
        complianceProviders: [complianceEndpointId],
        initiatorId,
        sourceChainCode: "cbdc_a",
        destinationChainCode: "cbdc_b",
        receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
        timeToExpire: new Date(Date.now() + 300),
      });

      await controller.acceptTransaction(result.transactionId, initiatorId);

      // Wait past the original deadline; the cleared timer must not fire.
      await new Promise((resolve) => setTimeout(resolve, 600));

      const persisted = await transactionStore.get(result.transactionId);
      expect(persisted!.status).toBe(TransactionStatus.COMPLETED);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it("rejects acceptTransaction when the deadline has already passed", async () => {
      const transactionId = "manually-staged-expired-tx";
      await transactionStore.save({
        id: transactionId,
        sourceChainCode: "cbdc_a",
        destinationChainCode: "cbdc_b",
        senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
        receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        amount: 100,
        timeToExpire: new Date(Date.now() - 1000),
        status: TransactionStatus.MARKED_FOR_REVIEW,
        complianceProviders: [complianceEndpointId],
        initiatorId,
        complianceResult: ComplianceResult.MARKED_FOR_REVIEW,
        fxRate: 0.5,
      });

      await expect(
        controller.acceptTransaction(transactionId, initiatorId),
      ).rejects.toThrow(/has expired/);

      const persisted = await transactionStore.get(transactionId);
      expect(persisted!.status).toBe(TransactionStatus.EXPIRED);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
  });
});
