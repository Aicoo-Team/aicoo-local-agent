import type {
  CommunicationSession,
  LocalAgentDelegationInput,
  LocalAgentDelegationResponse,
  MessageReceipt,
  ServiceResult,
} from "../../shared/contracts.js";
import { stableHash } from "../../shared/ids.js";
import { nowIso } from "../../shared/time.js";
import type { AuthContext } from "../auth.js";
import type { AppDatabase } from "../db.js";
import { CommunicationSessionService } from "./comm-sessions.js";
import { EndpointService } from "./endpoints.js";
import { MessageService } from "./messages.js";

export class DelegationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly comms: CommunicationSessionService,
    private readonly endpoints: EndpointService,
    private readonly messages: MessageService,
  ) {}

  delegate(auth: AuthContext, input: LocalAgentDelegationInput): ServiceResult<LocalAgentDelegationResponse> {
    const requestHash = stableHash(input);
    const existing = this.find(auth.principalId, input.clientMessageId);
    if (existing) {
      if (existing.request_hash !== requestHash) return failure("client_message_id_conflict", 409);
      return this.resumeExisting(auth, input, existing);
    }

    const replySession = this.resolveOwnedSession(auth, input.sessionHandle);
    if (!replySession.ok) return replySession;

    const active = this.findActiveGrant(auth.principalId, input);
    if (active) {
      return this.sendInvite(auth, input, active, requestHash, false);
    }

    const requested = this.comms.request(auth, {
      target: input.target,
      replyEndpointId: replySession.value.endpointId,
      replySessionHandle: replySession.value.sessionHandle,
      requestedTtlMinutes: input.requestedTtlMinutes,
    });
    if (!requested.ok) return requested;
    this.insert({
      requesterPrincipalId: auth.principalId,
      clientMessageId: input.clientMessageId,
      requestHash,
      commSessionId: requested.value.id,
      correlationId: input.correlationId,
      status: "grant_requested",
    });
    return {
      ok: true,
      value: this.grantRequested(input, requested.value, false),
    };
  }

  private resumeExisting(
    auth: AuthContext,
    input: LocalAgentDelegationInput,
    existing: DelegationRow,
  ): ServiceResult<LocalAgentDelegationResponse> {
    if (existing.message_id) {
      const comm = existing.comm_session_id
        ? this.comms.getVisible(auth.principalId, existing.comm_session_id)
        : undefined;
      if (!comm?.ok) return failure("not_found", 404);
      return {
        ok: true,
        value: this.delegated(input, comm.value, this.receiptFor(existing.message_id, true), true),
      };
    }

    if (!existing.comm_session_id) return failure("invalid_request", 400);
    const comm = this.comms.getVisible(auth.principalId, existing.comm_session_id);
    if (!comm.ok) return comm;
    if (comm.value.status === "active") {
      return this.sendInvite(auth, input, comm.value, existing.request_hash, true);
    }
    if (comm.value.status === "pending") {
      return {
        ok: true,
        value: this.grantRequested(input, comm.value, true),
      };
    }
    return failure(statusReason(comm.value.status), 409);
  }

  private sendInvite(
    auth: AuthContext,
    input: LocalAgentDelegationInput,
    comm: CommunicationSession,
    requestHash: string,
    duplicateDelegation: boolean,
  ): ServiceResult<LocalAgentDelegationResponse> {
    const sent = this.messages.send(auth, {
      communicationSessionId: comm.id,
      clientMessageId: input.clientMessageId,
      kind: "task_invite",
      payload: {
        task: input.task,
        delegation: {
          clientMessageId: input.clientMessageId,
          correlationId: input.correlationId ?? input.clientMessageId,
          requestedSessionHandle: input.sessionHandle,
          untrustedExternalContent: true,
        },
      },
      correlationId: input.correlationId,
    });
    if (!sent.ok) return sent;
    this.upsertDelegated(auth.principalId, input, requestHash, comm.id, sent.value.messageId);
    return {
      ok: true,
      value: this.delegated(input, comm, sent.value, duplicateDelegation || sent.value.duplicate),
    };
  }

  private resolveOwnedSession(auth: AuthContext, sessionHandle: string): ServiceResult<{ endpointId: string; sessionHandle: string }> {
    const session = this.endpoints.getSession(sessionHandle);
    if (!session || session.principalId !== auth.principalId) return failure("session_not_owned", 404);
    const endpoint = this.endpoints.getOwned(auth, session.endpointId);
    if (!endpoint.ok) return endpoint;
    if (session.state === "closed") return failure("session_closed", 409);
    return { ok: true, value: { endpointId: session.endpointId, sessionHandle: session.sessionHandle } };
  }

  private findActiveGrant(principalId: string, input: LocalAgentDelegationInput): CommunicationSession | undefined {
    return this.comms.list(principalId).find((comm) =>
      comm.status === "active"
      && comm.requester.principalId === principalId
      && comm.requester.replySessionHandle === input.sessionHandle
      && comm.recipient.principalId === input.target.principalId
      && comm.recipient.targetKind === input.target.kind
      && (input.target.kind !== "runtime_session" || comm.recipient.targetOfferId === input.target.targetOfferId)
    );
  }

  private find(requesterPrincipalId: string, clientMessageId: string): DelegationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM local_agent_delegations
       WHERE requester_principal_id = ? AND client_message_id = ?`,
    ).get(requesterPrincipalId, clientMessageId) as DelegationRow | undefined;
  }

  private insert(input: {
    requesterPrincipalId: string;
    clientMessageId: string;
    requestHash: string;
    commSessionId: string;
    correlationId?: string;
    status: "grant_requested";
  }): void {
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO local_agent_delegations(requester_principal_id, client_message_id, request_hash,
       comm_session_id, message_id, correlation_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      input.requesterPrincipalId,
      input.clientMessageId,
      input.requestHash,
      input.commSessionId,
      input.correlationId ?? null,
      input.status,
      now,
      now,
    );
  }

  private upsertDelegated(
    requesterPrincipalId: string,
    input: LocalAgentDelegationInput,
    requestHash: string,
    commSessionId: string,
    messageId: string,
  ): void {
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO local_agent_delegations(requester_principal_id, client_message_id, request_hash,
       comm_session_id, message_id, correlation_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'delegated', ?, ?)
       ON CONFLICT(requester_principal_id, client_message_id) DO UPDATE SET
       comm_session_id = excluded.comm_session_id,
       message_id = excluded.message_id,
       status = 'delegated',
       updated_at = excluded.updated_at`,
    ).run(
      requesterPrincipalId,
      input.clientMessageId,
      requestHash,
      commSessionId,
      messageId,
      input.correlationId ?? null,
      now,
      now,
    );
  }

  private receiptFor(messageId: string, duplicate: boolean): MessageReceipt {
    const delivery = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(messageId) as {
      delivery_id: string;
      status: MessageReceipt["status"];
      queued_at: string;
    } | undefined;
    if (!delivery) throw new Error(`Delegation delivery ${messageId} disappeared`);
    return {
      messageId,
      deliveryId: delivery.delivery_id,
      status: delivery.status,
      duplicate,
      queuedAt: delivery.queued_at,
    };
  }

  private grantRequested(
    input: LocalAgentDelegationInput,
    communicationSession: CommunicationSession,
    duplicate: boolean,
  ): LocalAgentDelegationResponse {
    return {
      status: "grant_requested",
      communicationSession,
      clientMessageId: input.clientMessageId,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      duplicate,
    };
  }

  private delegated(
    input: LocalAgentDelegationInput,
    communicationSession: CommunicationSession,
    receipt: MessageReceipt,
    duplicate: boolean,
  ): LocalAgentDelegationResponse {
    return {
      status: "delegated",
      communicationSession,
      receipt,
      clientMessageId: input.clientMessageId,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      duplicate,
    };
  }
}

interface DelegationRow {
  requester_principal_id: string;
  client_message_id: string;
  request_hash: string;
  comm_session_id: string | null;
  message_id: string | null;
  correlation_id: string | null;
  status: "grant_requested" | "delegated";
  created_at: string;
  updated_at: string;
}

function statusReason(status: CommunicationSession["status"]): import("../../shared/reason-codes.js").ReasonCode {
  switch (status) {
    case "expired":
      return "communication_session_expired";
    case "revoked":
      return "communication_session_revoked";
    case "declined":
      return "communication_session_declined";
    default:
      return "communication_session_not_active";
  }
}

function failure<T>(
  code: import("../../shared/reason-codes.js").ReasonCode,
  httpStatus: number,
): ServiceResult<T> {
  return { ok: false, code, httpStatus };
}
