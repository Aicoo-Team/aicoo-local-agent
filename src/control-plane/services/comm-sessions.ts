import type {
  CommunicationGrant,
  CommunicationSession,
  RequestCommunicationSessionInput,
  ServiceResult,
} from "../../shared/contracts.js";
import { id } from "../../shared/ids.js";
import { addMinutes, nowIso } from "../../shared/time.js";
import { audit } from "../audit.js";
import type { AuthContext } from "../auth.js";
import { transaction, type AppDatabase } from "../db.js";
import { EventStore } from "../events.js";
import { EndpointService } from "./endpoints.js";
import { OfferService } from "./offers.js";

export class CommunicationSessionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly endpoints: EndpointService,
    private readonly offers: OfferService,
    private readonly events: EventStore,
  ) {}

  request(auth: AuthContext, input: RequestCommunicationSessionInput): ServiceResult<CommunicationSession> {
    const replySession = this.endpoints.getSessionOwned(auth, input.replyEndpointId, input.replySessionHandle);
    if (!replySession.ok) return replySession;
    if (replySession.value.state === "closed") return failure("session_closed", 409);
    const recipient = this.db.prepare("SELECT 1 FROM principals WHERE principal_id = ?").get(
      input.target.principalId,
    );
    if (!recipient) return failure("not_found", 404);
    if (input.target.kind === "runtime_session") {
      if (!input.target.targetOfferId) return failure("invalid_request", 400);
      const offered = this.offers.resolve(input.target.targetOfferId, input.target.principalId, auth.principalId);
      if (!offered.ok) return offered;
    }
    const requestedAt = nowIso();
    const sessionId = id("comm");
    const requestedTtlMinutes = Math.min(input.requestedTtlMinutes ?? 30, 30);
    const requestExpiresAt = addMinutes(requestedAt, 10);
    const wake: string[] = [];
    transaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO comm_sessions(comm_session_id, requester_principal_id, requester_device_id, requester_reply_endpoint_id,
         requester_reply_session_handle, recipient_principal_id, target_kind, target_offer_id,
         requested_ttl_minutes, status, requested_at, request_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        sessionId,
        auth.principalId,
        auth.deviceId,
        input.replyEndpointId,
        input.replySessionHandle,
        input.target.principalId,
        input.target.kind,
        input.target.targetOfferId ?? null,
        requestedTtlMinutes,
        requestedAt,
        requestExpiresAt,
      );
      for (const endpoint of this.endpoints.listForPrincipal(input.target.principalId)) {
        this.events.append(endpoint.endpointId, "comm.request", {
          communicationSessionId: sessionId,
          requesterPrincipalId: auth.principalId,
          requesterDeviceId: auth.deviceId,
          targetKind: input.target.kind,
          requestedAt,
          requestExpiresAt,
        });
        wake.push(endpoint.endpointId);
      }
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "comm.requested",
        entityType: "communication_session",
        entityId: sessionId,
        metadata: {
          requesterPrincipalId: auth.principalId,
          requesterDeviceId: auth.deviceId,
          recipientPrincipalId: input.target.principalId,
          targetKind: input.target.kind,
          requestExpiresAt,
        },
      });
    });
    this.events.wake(wake);
    return this.getVisible(auth.principalId, sessionId);
  }

  accept(auth: AuthContext, sessionId: string): ServiceResult<CommunicationGrant> {
    const current = this.getVisible(auth.principalId, sessionId);
    if (!current.ok) return current;
    if (current.value.recipient.principalId !== auth.principalId) return failure("wrong_participant", 403);
    if (current.value.status !== "pending") return failure(statusReason(current.value.status), 409);

    let endpointId: string | undefined;
    let sessionHandle: string | undefined;
    if (current.value.recipient.targetKind === "person_default_runtime") {
      const route = this.endpoints.getDefaultRoute(auth.principalId);
      if (!route) return failure("no_default_route", 409);
      endpointId = route.endpointId;
      sessionHandle = route.sessionHandle;
    } else if (current.value.recipient.targetKind === "runtime_session") {
      const offerId = current.value.recipient.targetOfferId;
      if (!offerId) return failure("offer_not_found", 409);
      const route = this.offers.resolve(offerId, auth.principalId, current.value.requester.principalId);
      if (!route.ok) return route;
      endpointId = route.value.endpointId;
      sessionHandle = route.value.sessionHandle;
    } else {
      return failure("invalid_target_kind", 400);
    }
    const targetSession = this.endpoints.getSession(sessionHandle);
    if (!targetSession || targetSession.endpointId !== endpointId || targetSession.principalId !== auth.principalId) {
      return failure("session_not_found", 409);
    }
    if (targetSession.state === "closed") return failure("session_closed", 409);
    if (!targetSession.allowInbound) return failure("inbound_disabled", 409);

    const activatedAt = nowIso();
    const grantExpiresAt = addMinutes(activatedAt, Math.min(rowFor(this.db, sessionId).requested_ttl_minutes, 30));
    const wake: string[] = [];
    const changed = transaction(this.db, () => {
      const result = this.db.prepare(
        `UPDATE comm_sessions SET status = 'active', frozen_endpoint_id = ?, frozen_session_handle = ?,
         activated_at = ?, grant_expires_at = ? WHERE comm_session_id = ? AND status = 'pending'`,
      ).run(endpointId, sessionHandle, activatedAt, grantExpiresAt, sessionId);
      if (Number(result.changes) === 0) return false;
      for (const principalId of [current.value.requester.principalId, current.value.recipient.principalId]) {
        for (const endpoint of this.endpoints.listForPrincipal(principalId)) {
          this.events.append(endpoint.endpointId, "comm.activated", {
            communicationSessionId: sessionId,
            endpointId,
            sessionHandle,
            activatedAt,
            grantExpiresAt,
          });
          wake.push(endpoint.endpointId);
        }
      }
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "comm.activated",
        entityType: "communication_session",
        entityId: sessionId,
        metadata: {
          requesterPrincipalId: current.value.requester.principalId,
          recipientPrincipalId: current.value.recipient.principalId,
          endpointId,
          sessionHandle,
          grantExpiresAt,
        },
      });
      return true;
    });
    if (!changed) return failure("communication_session_not_active", 409);
    this.events.wake(wake);
    const active = this.getVisible(auth.principalId, sessionId);
    return active.ok ? { ok: true, value: active.value as CommunicationGrant } : active;
  }

  decline(auth: AuthContext, sessionId: string): ServiceResult<void> {
    const current = this.getVisible(auth.principalId, sessionId);
    if (!current.ok) return current;
    if (current.value.recipient.principalId !== auth.principalId) return failure("wrong_participant", 403);
    if (current.value.status !== "pending") return failure(statusReason(current.value.status), 409);
    const wake: string[] = [];
    transaction(this.db, () => {
      this.db.prepare("UPDATE comm_sessions SET status = 'declined' WHERE comm_session_id = ? AND status = 'pending'").run(
        sessionId,
      );
      for (const endpoint of this.endpoints.listForPrincipal(current.value.requester.principalId)) {
        this.events.append(endpoint.endpointId, "comm.declined", { communicationSessionId: sessionId });
        wake.push(endpoint.endpointId);
      }
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "comm.declined",
        entityType: "communication_session",
        entityId: sessionId,
        metadata: {
          requesterPrincipalId: current.value.requester.principalId,
          recipientPrincipalId: current.value.recipient.principalId,
        },
      });
    });
    this.events.wake(wake);
    return { ok: true, value: undefined };
  }

  revoke(auth: AuthContext, sessionId: string): ServiceResult<void> {
    const current = this.getVisible(auth.principalId, sessionId);
    if (!current.ok) return current;
    const participants = [current.value.requester.principalId, current.value.recipient.principalId];
    if (!participants.includes(auth.principalId)) return failure("wrong_participant", 403);
    if (current.value.status !== "active") return failure(statusReason(current.value.status), 409);
    const revokedAt = nowIso();
    const wake: string[] = [];
    transaction(this.db, () => {
      this.db.prepare(
        "UPDATE comm_sessions SET status = 'revoked', revoked_at = ? WHERE comm_session_id = ? AND status = 'active'",
      ).run(revokedAt, sessionId);
      this.db.prepare(
        `UPDATE deliveries SET status = 'revoked', terminal_at = ?, result_code = 'communication_session_revoked'
         WHERE message_id IN (SELECT message_id FROM messages WHERE comm_session_id = ?)
         AND status IN ('queued', 'dispatched', 'device_acked', 'runtime_pending')`,
      ).run(revokedAt, sessionId);
      for (const principalId of participants) {
        for (const endpoint of this.endpoints.listForPrincipal(principalId)) {
          this.events.append(endpoint.endpointId, "comm.revoked", {
            communicationSessionId: sessionId,
            revokedAt,
          });
          wake.push(endpoint.endpointId);
        }
      }
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "comm.revoked",
        entityType: "communication_session",
        entityId: sessionId,
        metadata: {
          requesterPrincipalId: current.value.requester.principalId,
          recipientPrincipalId: current.value.recipient.principalId,
          revokedAt,
        },
      });
    });
    this.events.wake(wake);
    return { ok: true, value: undefined };
  }

  getVisible(principalId: string, sessionId: string): ServiceResult<CommunicationSession> {
    this.expireIfNeeded(sessionId);
    const row = this.db.prepare("SELECT * FROM comm_sessions WHERE comm_session_id = ?").get(sessionId) as
      | CommRow
      | undefined;
    if (!row) return failure("not_found", 404);
    if (row.requester_principal_id !== principalId && row.recipient_principal_id !== principalId) {
      return failure("not_found", 404);
    }
    return { ok: true, value: mapCommunication(row) };
  }

  list(principalId: string): CommunicationSession[] {
    const rows = this.db.prepare(
      "SELECT comm_session_id FROM comm_sessions WHERE requester_principal_id = ? OR recipient_principal_id = ? ORDER BY requested_at",
    ).all(principalId, principalId) as Array<{ comm_session_id: string }>;
    return rows.flatMap((row) => {
      const result = this.getVisible(principalId, row.comm_session_id);
      return result.ok ? [result.value] : [];
    });
  }

  requireActive(principalId: string, sessionId: string): ServiceResult<CommunicationSession> {
    const result = this.getVisible(principalId, sessionId);
    if (!result.ok) return result;
    if (result.value.status !== "active") return failure(statusReason(result.value.status), 403);
    return result;
  }

  expireIfNeeded(sessionId: string): void {
    const row = this.db.prepare(
      "SELECT status, request_expires_at, grant_expires_at, requester_principal_id, recipient_principal_id FROM comm_sessions WHERE comm_session_id = ?",
    ).get(sessionId) as
      | {
          status: string;
          request_expires_at: string;
          grant_expires_at: string | null;
          requester_principal_id: string;
          recipient_principal_id: string;
        }
      | undefined;
    if (!row) return;
    const now = nowIso();
    const expired = (row.status === "pending" && row.request_expires_at <= now)
      || (row.status === "active" && row.grant_expires_at !== null && row.grant_expires_at <= now);
    if (!expired) return;
    transaction(this.db, () => {
      const result = this.db.prepare(
        "UPDATE comm_sessions SET status = 'expired' WHERE comm_session_id = ? AND status = ?",
      ).run(sessionId, row.status);
      if (Number(result.changes) === 0) return;
      this.db.prepare(
        `UPDATE deliveries SET status = 'expired', terminal_at = ?, result_code = 'communication_session_expired'
         WHERE message_id IN (SELECT message_id FROM messages WHERE comm_session_id = ?)
         AND status IN ('queued', 'dispatched', 'device_acked', 'runtime_pending')`,
      ).run(now, sessionId);
      audit(this.db, {
        actorPrincipalId: "system",
        action: "comm.expired",
        entityType: "communication_session",
        entityId: sessionId,
        metadata: {
          requesterPrincipalId: row.requester_principal_id,
          recipientPrincipalId: row.recipient_principal_id,
        },
      });
    });
  }
}

interface CommRow {
  comm_session_id: string;
  requester_principal_id: string;
  requester_device_id: string | null;
  requester_reply_endpoint_id: string;
  requester_reply_session_handle: string;
  recipient_principal_id: string;
  target_kind: CommunicationSession["recipient"]["targetKind"];
  target_offer_id: string | null;
  frozen_endpoint_id: string | null;
  frozen_session_handle: string | null;
  requested_ttl_minutes: number;
  status: CommunicationSession["status"];
  requested_at: string;
  request_expires_at: string;
  activated_at: string | null;
  grant_expires_at: string | null;
  revoked_at: string | null;
}

function rowFor(db: AppDatabase, sessionId: string): CommRow {
  const row = db.prepare("SELECT * FROM comm_sessions WHERE comm_session_id = ?").get(sessionId) as
    | CommRow
    | undefined;
  if (!row) throw new Error(`Missing communication session ${sessionId}`);
  return row;
}

function mapCommunication(row: CommRow): CommunicationSession {
  return {
    id: row.comm_session_id,
    requester: {
      principalId: row.requester_principal_id,
      ...(row.requester_device_id ? { deviceId: row.requester_device_id } : {}),
      replyEndpointId: row.requester_reply_endpoint_id,
      replySessionHandle: row.requester_reply_session_handle,
    },
    recipient: {
      principalId: row.recipient_principal_id,
      targetKind: row.target_kind,
      ...(row.target_offer_id ? { targetOfferId: row.target_offer_id } : {}),
      ...(row.frozen_endpoint_id ? { endpointId: row.frozen_endpoint_id } : {}),
      ...(row.frozen_session_handle ? { sessionHandle: row.frozen_session_handle } : {}),
    },
    status: row.status,
    capabilities: ["message:send", "message:reply"],
    requestedAt: row.requested_at,
    requestExpiresAt: row.request_expires_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.grant_expires_at ? { grantExpiresAt: row.grant_expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
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
