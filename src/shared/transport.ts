import type {
  CommunicationGrant,
  CommunicationSession,
  DeliveryAckInput,
  Endpoint,
  LocalAgentDelegationInput,
  LocalAgentDelegationResponse,
  MessageDelivery,
  MessageReceipt,
  ReachableTarget,
  RegisterEndpointInput,
  RequestCommunicationSessionInput,
  RuntimeEvent,
  SendMessageInput,
  TrustedToolPolicyUsageInput,
} from "./contracts.js";

export interface DelegationRequestOptions {
  timeoutMs?: number;
}

export interface MessageTransport {
  registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint>;
  heartbeatEndpoint(endpointId: string): Promise<void>;
  listReachableTargets(personId: string): Promise<ReachableTarget[]>;
  requestCommunicationSession(input: RequestCommunicationSessionInput): Promise<CommunicationSession>;
  acceptCommunicationSession(sessionId: string): Promise<CommunicationGrant>;
  declineCommunicationSession(sessionId: string): Promise<void>;
  revokeCommunicationSession(sessionId: string): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<MessageReceipt>;
  delegateLocalAgentTask(
    input: LocalAgentDelegationInput,
    options?: DelegationRequestOptions,
  ): Promise<LocalAgentDelegationResponse>;
  subscribeEvents(cursor?: string, signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
  fetchInbox(afterCursor?: string): Promise<RuntimeEvent[]>;
  validateInjection(input: {
    messageId: string;
    communicationSessionId: string;
    endpointId: string;
    sessionHandle?: string;
  }): Promise<{ valid: true } | { valid: false; reason: string }>;
  acknowledgeDelivery(input: DeliveryAckInput): Promise<void>;
  reportTrustedToolPolicyUsage(input: TrustedToolPolicyUsageInput): Promise<{
    acceptedThroughSequence: number;
    duplicate: boolean;
  }>;
  getMessageStatus(messageId: string): Promise<MessageDelivery>;
}
