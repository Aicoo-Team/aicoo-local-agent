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
} from "./contracts.js";

export interface MessageTransport {
  registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint>;
  heartbeatEndpoint(endpointId: string): Promise<void>;
  listReachableTargets(personId: string): Promise<ReachableTarget[]>;
  requestCommunicationSession(input: RequestCommunicationSessionInput): Promise<CommunicationSession>;
  acceptCommunicationSession(sessionId: string): Promise<CommunicationGrant>;
  declineCommunicationSession(sessionId: string): Promise<void>;
  revokeCommunicationSession(sessionId: string): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<MessageReceipt>;
  delegateLocalAgentTask(input: LocalAgentDelegationInput): Promise<LocalAgentDelegationResponse>;
  subscribeEvents(cursor?: string, signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
  fetchInbox(afterCursor?: string): Promise<RuntimeEvent[]>;
  validateInjection(input: {
    messageId: string;
    communicationSessionId: string;
    endpointId: string;
    sessionHandle?: string;
  }): Promise<{ valid: true } | { valid: false; reason: string }>;
  acknowledgeDelivery(input: DeliveryAckInput): Promise<void>;
  getMessageStatus(messageId: string): Promise<MessageDelivery>;
}
