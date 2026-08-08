import type { ReasonCode } from "./reason-codes.js";
import type { CollaborationContext } from "./collaboration-context.js";

export type RuntimeKind = "claude-code" | "codex";
export type TargetKind = "human_inbox" | "person_default_runtime" | "runtime_session";
export type MessageKind = "text" | "task_invite" | "resource_request" | "control";
export type CommunicationStatus = "pending" | "active" | "declined" | "revoked" | "expired";
export type DeliveryStatus =
  | "queued"
  | "dispatched"
  | "device_acked"
  | "runtime_pending"
  | "runtime_acked"
  | "handled"
  | "replied"
  | "inbox_persisted"
  | "rejected"
  | "failed"
  | "expired"
  | "revoked";

export interface RuntimeEndpoint {
  endpointId: string;
  principalId: string;
  deviceId: string;
  runtime: RuntimeKind;
  bridgeVersion: string;
  adapterVersion: string;
  capabilities: string[];
  presence: "online" | "draining" | "offline";
  lastSeenAt: string;
}

export type Endpoint = RuntimeEndpoint;

export interface RuntimeSessionBinding {
  sessionHandle: string;
  targetOfferId?: string;
  endpointId: string;
  principalId: string;
  label: string;
  workspaceBoundary?: string;
  state: "idle" | "busy" | "closed";
  deliveryMode: "managed_stream" | "remote_control" | "resume_only";
  capabilities: {
    liveInject: boolean;
    midTurnSteer: boolean;
    replyEvents: boolean;
  };
  allowInbound: boolean;
  allowMidTurnSteer: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface CommunicationSession {
  id: string;
  requester: {
    principalId: string;
    /** Server-derived identity of the device that requested this relationship. */
    deviceId?: string;
    replyEndpointId: string;
    replySessionHandle: string;
  };
  recipient: {
    principalId: string;
    targetKind: TargetKind;
    targetOfferId?: string;
    endpointId?: string;
    sessionHandle?: string;
  };
  status: CommunicationStatus;
  capabilities: ["message:send", "message:reply"];
  requestedAt: string;
  requestExpiresAt: string;
  activatedAt?: string;
  grantExpiresAt?: string;
  revokedAt?: string;
}

export type CommunicationGrant = CommunicationSession & {
  status: "active";
  activatedAt: string;
  grantExpiresAt: string;
};

export interface MessageTarget {
  kind: TargetKind;
  principalId: string;
  endpointId?: string;
  sessionHandle?: string;
}

export type CollaborationTurnType = "task" | "question" | "response" | "result" | "control";
export type CollaborationTurnOutcome = "respond" | "needs_owner" | "propose_complete" | "failed";

export interface CollaborationTurnInput {
  clientTurnId: string;
  parentTurnId?: string;
  type: CollaborationTurnType;
  expectsReply: boolean;
  outcome?: CollaborationTurnOutcome;
}

export interface CollaborationTurnEnvelope extends CollaborationTurnInput {
  turnId: string;
  sequence: number;
}

export interface MessageEnvelope {
  id: string;
  clientMessageId: string;
  communicationSessionId?: string;
  collaborationId?: string;
  collaborationRole?: "requester" | "recipient";
  collaborationTurn?: CollaborationTurnEnvelope;
  conversationId?: string;
  senderPrincipalId: string;
  /**
   * Device identity derived by the control plane from the authenticated sender.
   * Clients must never be allowed to supply or override this value.
   */
  senderDeviceId?: string;
  target: MessageTarget;
  kind: MessageKind;
  payload: Record<string, unknown>;
  replyTo?: string;
  correlationId?: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
}

export interface DeliveryAttempt {
  attemptId: string;
  phase: "device_ack" | "runtime_pending" | "runtime_ack" | "runtime_failed";
  resultCode?: string;
  retryable: boolean;
  runtimeAckId?: string;
  createdAt: string;
}

export interface MessageDelivery {
  messageId: string;
  deliveryId: string;
  status: DeliveryStatus;
  queuedAt: string;
  dispatchedAt?: string;
  deviceAckReceivedAt?: string;
  runtimePendingAt?: string;
  runtimeAckReceivedAt?: string;
  terminalAt?: string;
  resultCode?: string;
  runtimeAckId?: string;
  adapterLabel?: string;
  attempts: DeliveryAttempt[];
}

export interface MessageReceipt {
  messageId: string;
  deliveryId: string;
  status: DeliveryStatus;
  duplicate: boolean;
  queuedAt: string;
}

export interface RuntimeEvent<T = Record<string, unknown>> {
  cursor: string;
  type:
    | "message.dispatch"
    | "comm.request"
    | "comm.activated"
    | "comm.declined"
    | "comm.revoked"
    | "comm.expired"
    | "collaboration.completed"
    | "collaboration.revoked"
    | "collaboration.expired"
    | "relationship.policy_update"
    | "trusted_tool_policy.upserted"
    | "trusted_tool_policy.revoked";
  endpointId: string;
  createdAt: string;
  data: T;
}

export interface TrustedToolPolicyUsageInput {
  policyId: string;
  revision: number;
  normalizedTool: string;
  canonicalFolder: string;
  uses: Array<{ sequence: number; usedAt: string }>;
}

export interface ReachableTarget {
  kind: "person_default_runtime" | "runtime_session";
  principalId: string;
  label: string;
  targetOfferId?: string;
  expiresAt?: string;
  available: boolean;
}

export interface RegisterEndpointInput {
  runtime: RuntimeKind;
  bridgeVersion: string;
  adapterVersion: string;
  capabilities: string[];
}

export interface RegisterRuntimeSessionInput {
  label: string;
  workspaceBoundary?: string;
  state: "idle" | "busy";
  deliveryMode: "managed_stream";
  capabilities: RuntimeSessionBinding["capabilities"];
  allowInbound: boolean;
  allowMidTurnSteer: boolean;
}

export interface RequestCommunicationSessionInput {
  target: {
    kind: "person_default_runtime" | "runtime_session";
    principalId: string;
    targetOfferId?: string;
  };
  replyEndpointId: string;
  replySessionHandle: string;
  requestedTtlMinutes?: number;
}

export interface LocalAgentDelegationInput {
  target: RequestCommunicationSessionInput["target"];
  task: string | Record<string, unknown>;
  sessionHandle: string;
  clientMessageId: string;
  correlationId?: string;
  requestedTtlMinutes?: number;
  context?: CollaborationContext;
}

export type LocalAgentDelegationResponse =
  | {
      status: "collaboration_requested";
      collaborationId: string;
      clientMessageId: string;
      correlationId?: string;
      duplicate: boolean;
    }
  | {
      status: "grant_requested";
      collaborationId?: string;
      communicationSession: CommunicationSession;
      clientMessageId: string;
      correlationId?: string;
      duplicate: boolean;
      /** A folder approval is parked behind the already-active collaboration grant. */
      approvalKind?: "collaboration" | "folder";
      approvalId?: string;
    }
  | {
      status: "folder_access_requested";
      collaborationId?: string;
      communicationSession: CommunicationSession;
      clientMessageId: string;
      correlationId?: string;
      duplicate: boolean;
      approvalKind: "folder";
      approvalId: string;
    }
  | {
      status: "delegated";
      collaborationId?: string;
      communicationSession: CommunicationSession;
      receipt: MessageReceipt;
      clientMessageId: string;
      correlationId?: string;
      duplicate: boolean;
    };

export interface GrantScopedSendMessageInput {
  communicationSessionId: string;
  clientMessageId: string;
  kind: Exclude<MessageKind, "control">;
  payload: Record<string, unknown>;
  replyTo?: string;
  correlationId?: string;
  collaborationTurn?: CollaborationTurnInput;
}

export interface HumanInboxSendMessageInput {
  target: { kind: "human_inbox"; principalId: string };
  clientMessageId: string;
  kind: Exclude<MessageKind, "control">;
  payload: Record<string, unknown>;
  replyTo?: string;
  correlationId?: string;
}

export type SendMessageInput = GrantScopedSendMessageInput | HumanInboxSendMessageInput;

export interface DeliveryAckInput {
  messageId: string;
  phase: DeliveryAttempt["phase"];
  attemptId: string;
  resultCode?: string;
  retryable?: boolean;
  runtimeAckId?: string;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ReasonCode; httpStatus: number; message?: string };

export interface AuditRecord {
  id: number;
  actorPrincipalId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
