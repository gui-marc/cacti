import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { InMemoryTransactionStore } from "../../../main/typescript/store/transaction-store";
import CBDCController from "../../../main/typescript/core/cbdc-controller";
import ConstantFxProvisionStrategy from "../../../test/typescript/fx-provision/constant-fx-provision-strategy";
import { InMemoryComplianceProvidersStore } from "../../../main/typescript/store/compliance-providers-store";
import { DummyComplianceProvider } from "../../../test/typescript/compliance/dummy-compliance-provider";
import {
  ComplianceResult,
  ILedgerEnvironment,
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
  const complianceStoreProvider = new InMemoryComplianceProvidersStore();
  const complianceProvider = new DummyComplianceProvider({
    port: 8081,
    nextCheckResponse: ComplianceResult.APPROVED,
  });

  complianceStoreProvider.save({
    id: "dummy-compliance-provider",
    apiKey: "dummy-api-key",
    endpoint: complianceProvider.getEndpointUrl(),
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
    const controller = new CBDCController(
      transactionStore,
      new ConstantFxProvisionStrategy(0.5),
      complianceStoreProvider,
      {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
    );

    await controller.initiateTransaction({
      amount: 100,
      complianceProviders: ["dummy-compliance-provider"],
      sourceChainCode: "cbdc_a",
      destinationChainCode: "cbdc_b",
      receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
      timeToExpire: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    });
  });

  it("should fail if compliance check fails", async () => {
    complianceProvider.setNextCheckResponse(ComplianceResult.REJECTED);

    const controller = new CBDCController(
      transactionStore,
      new ConstantFxProvisionStrategy(0.5),
      complianceStoreProvider,
      {
        environments: {
          cbdc_a: cbdc_a_environment,
          cbdc_b: cbdc_b_environment,
        },
      },
      logLevel,
    );

    const promise = controller.initiateTransaction({
      amount: 100,
      complianceProviders: ["dummy-compliance-provider"],
      sourceChainCode: "cbdc_a",
      destinationChainCode: "cbdc_b",
      receiverAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      senderAddress: "0x1234567890abcdef1234567890abcdef12345678",
      timeToExpire: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    });

    await expect(promise).rejects.toThrow();
  });
});
