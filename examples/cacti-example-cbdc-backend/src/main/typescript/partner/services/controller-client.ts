import axios from "axios";
import {
  ISignedEnvelope,
  PartnerSigningError,
  signRequest,
  verifyResponse,
} from "@hyperledger-cacti/cacti-plugin-cbdc-controller";
import { ChainCode } from "../../types";
import { ICentralBankPeerConfig } from "../../config/types";

export interface InitiateTxPayload {
  sourceChainCode: ChainCode;
  destinationChainCode: ChainCode;
  senderAddress: string;
  receiverAddress: string;
  amount: number;
  timeToExpire: string;
  complianceProviders: string[];
}

export interface InitiateTxResponse {
  transactionId: string;
  status?: string;
}

export class ControllerClient {
  constructor(
    private readonly partnerId: string,
    private readonly centralBanks: ICentralBankPeerConfig[],
  ) {}

  private peerForChain(chain: ChainCode): ICentralBankPeerConfig {
    const peer = this.centralBanks.find((cb) => cb.chainCode === chain);
    if (!peer) {
      throw new Error(`No central bank registered for chain ${chain}`);
    }
    return peer;
  }

  async initiateTransaction(payload: InitiateTxPayload): Promise<InitiateTxResponse> {
    const peer = this.peerForChain(payload.sourceChainCode);
    const { envelope, nonce } = signRequest(this.partnerId, peer.apiKey, payload);
    const res = await axios.post<ISignedEnvelope | InitiateTxResponse>(
      `${peer.baseUrl}/cbdc/initiate-transaction`,
      envelope,
      { validateStatus: () => true },
    );
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(
        `central-bank ${peer.chainCode} initiate-transaction returned ${res.status}: ${JSON.stringify(res.data)}`,
      );
    }
    return this.handleEnvelopeOrJson<InitiateTxResponse>(res.data, peer.apiKey, peer.chainCode, nonce);
  }

  async acceptTransaction(
    sourceChain: ChainCode,
    transactionId: string,
  ): Promise<InitiateTxResponse> {
    const peer = this.peerForChain(sourceChain);
    const payload = { transactionId };
    const { envelope, nonce } = signRequest(this.partnerId, peer.apiKey, payload);
    const res = await axios.post<ISignedEnvelope | InitiateTxResponse>(
      `${peer.baseUrl}/cbdc/accept-transaction`,
      envelope,
      { validateStatus: () => true },
    );
    if (res.status !== 200) {
      throw new Error(
        `central-bank ${peer.chainCode} accept-transaction returned ${res.status}: ${JSON.stringify(res.data)}`,
      );
    }
    return this.handleEnvelopeOrJson<InitiateTxResponse>(res.data, peer.apiKey, peer.chainCode, nonce);
  }

  private handleEnvelopeOrJson<T>(
    data: unknown,
    secret: string,
    chain: ChainCode,
    nonce: string,
  ): T {
    if (
      data &&
      typeof data === "object" &&
      "partnerId" in (data as object) &&
      "sig" in (data as object)
    ) {
      try {
        return verifyResponse<T>(
          (data as ISignedEnvelope).partnerId,
          secret,
          nonce,
          data as ISignedEnvelope,
        );
      } catch (e) {
        if (e instanceof PartnerSigningError) {
          throw new Error(`Central bank ${chain} signed response invalid: ${e.code}`);
        }
        throw e;
      }
    }
    return data as T;
  }
}
