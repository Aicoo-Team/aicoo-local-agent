import type {
  DeliveryAckInput,
  DeliveryAttempt,
  DeliveryStatus,
  HumanInboxSendMessageInput,
  MessageDelivery,
  MessageEnvelope,
  MessageReceipt,
  SendMessageInput,
  ServiceResult,
} from "../../shared/contracts.js";
import { id, stableHash } from "../../shared/ids.js";
import { nowIso } from "../../shared/time.js";
import { audit } from "../audit.js";
import type { AuthContext } from "../auth.js";
import { transaction, type AppDatabase } from "../db.js";
import { EventStore } from "../events.js";
import { CommunicationSessionService } from "./comm-sessions.js";
import { EndpointService } from "./endpoints.js";

export class MessageService {
  constructor(
    private readonly db: AppDatabase,
    private readonly comms: CommunicationSessionService,
    private readonly endpoints: EndpointService,
    private readonly events: EventStore,
  ) {}

  send(auth: AuthContext, input: SendMessageInput): ServiceResult<MessageReceipt> {
    const requestHash = stableHash(input);
    const duplicate = this.findDuplicate(auth.principalId, input.clientMessageId);
    if (duplicate) {
      if (duplicate.request_hash !== requestHash) return failure("client_message_id_conflict", 409);
      return { ok: true, value: this.receiptFor(duplicate.message_id, true) };
    }

    const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
    if (payloadBytes > 32 * 1024) return failure("payload_too_large", 400);
    if ("target" in input) return this.sendInbox(auth, input, requestHash);
    return this.sendGrantScoped(auth, input, requestHash);
  }

  private sendInbox(
    auth: AuthContext,
    input: HumanInboxSendMessageInput,
    requestHash: string,
  ): ServiceResult<MessageReceipt> {
    if (input.target.kind !== "human_inbox") return failure("invalid_target_kind", 400);
    const target = this.db.prepare("SELECT 1 FROM principals WHERE principal_id = ?").get(input.target.principalId);
    if (!target) return failure("not_found", 404);
    const messageId = id("msg");
    const deliveryId = id("del");
    const createdAt = nowIso();
    transaction(this.db, () => {
      this.insertMessage({
        messageId,
        clientMessageId: input.clientMessageId,
        requestHash,
        senderPrincipalId: auth.principalId,
        targetKind: "human_inbox",
        targetPrincipalId: input.target.principalId,
        kind: input.kind,
        payload: input.payload,
        replyTo: input.replyTo,
        correlationId: input.correlationId,
        sequence: 1,
        createdAt,
        expiresAt: "9999-12-31T23:59:59.999Z",
      });
      this.db.prepare(
        `INSERT INTO deliveries(delivery_id, message_id, status, queued_at)
         VALUES (?, ?, 'inbox_persisted', ?)`,
      ).run(deliveryId, messageId, createdAt);
      this.db.prepare(
        "INSERT INTO inbox_items(inbox_item_id, principal_id, message_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(id("inbox"), input.target.principalId, messageId, createdAt);
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "message.inbox_persisted",
        entityType: "message",
        entityId: messageId,
        metadata: { recipientPrincipalId: input.target.principalId, deliveryId },
      });
    });
    return { ok: true, value: this.receiptFor(messageId, false) };
  }

  private sendGrantScoped(
    auth: AuthContext,
    input: Exclude<SendMessageInput, HumanInboxSendMessageInput>,
    requestHash: string,
  ): ServiceResult<MessageReceipt> {
    const active = this.comms.requireActive(auth.principalId, input.communicationSessionId);
    if (!active.ok) return active;
    const comm = active.value;
    if (input.replyTo) {
      const repliedTo = this.db.prepare(
        "SELECT comm_session_id FROM messages WHERE message_id = ?",
      ).get(input.replyTo) as { comm_session_id: string | null } | undefined;
      if (!repliedTo || repliedTo.comm_session_id !== comm.id) return failure("wrong_target", 409);
    }
    const forward = auth.principalId === comm.requester.principalId;
    const reverse = auth.principalId === comm.recipient.principalId;
    if (!forward && !reverse) return failure("wrong_participant", 403);
    const target = forward
      ? {
          kind: comm.recipient.targetKind,
          principalId: comm.recipient.principalId,
          endpointId: comm.recipient.endpointId,
          sessionHandle: comm.recipient.sessionHandle,
        }
      : {
          kind: "runtime_session" as const,
          principalId: comm.requester.principalId,
          endpointId: comm.requester.replyEndpointId,
          sessionHandle: comm.requester.replySessionHandle,
        };
    if (!target.endpointId || !target.sessionHandle) return failure("wrong_target", 409);
    const targetEndpointId = target.endpointId;
    const targetSessionHandle = target.sessionHandle;
    const messageId = id("msg");
    const deliveryId = id("del");
    const createdAt = nowIso();
    const sequenceRow = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE comm_session_id = ?",
    ).get(comm.id) as { sequence: number };
    const sequence = Number(sequenceRow.sequence) + 1;
    const envelope: MessageEnvelope = {
      id: messageId,
      clientMessageId: input.clientMessageId,
      communicationSessionId: comm.id,
      senderPrincipalId: auth.principalId,
      target: {
        kind: target.kind,
        principalId: target.principalId,
        endpointId: targetEndpointId,
        sessionHandle: targetSessionHandle,
      },
      kind: input.kind,
      payload: input.payload,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      sequence,
      createdAt,
      expiresAt: comm.grantExpiresAt as string,
    };
    transaction(this.db, () => {
      this.insertMessage({
        messageId,
        clientMessageId: input.clientMessageId,
        requestHash,
        commSessionId: comm.id,
        senderPrincipalId: auth.principalId,
        targetKind: target.kind,
        targetPrincipalId: target.principalId,
        targetEndpointId,
        targetSessionHandle,
        kind: input.kind,
        payload: input.payload,
        replyTo: input.replyTo,
        correlationId: input.correlationId,
        sequence,
        createdAt,
        expiresAt: comm.grantExpiresAt as string,
      });
      this.db.prepare(
        `INSERT INTO deliveries(delivery_id, message_id, endpoint_id, status, queued_at)
         VALUES (?, ?, ?, 'queued', ?)`,
      ).run(deliveryId, messageId, targetEndpointId, createdAt);
      this.events.append(targetEndpointId, "message.dispatch", { envelope, deliveryId });
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: "message.queued",
        entityType: "message",
        entityId: messageId,
        metadata: {
          communicationSessionId: comm.id,
          recipientPrincipalId: target.principalId,
          endpointId: targetEndpointId,
          sessionHandle: targetSessionHandle,
          deliveryId,
          sequence,
        },
      });
    });
    this.events.wake([targetEndpointId]);
    return { ok: true, value: this.receiptFor(messageId, false) };
  }

  acknowledge(
    auth: AuthContext,
    messageId: string,
    input: Omit<DeliveryAckInput, "messageId">,
  ): ServiceResult<{ recorded: "state" | "audit_only" }> {
    const row = this.db.prepare(
      `SELECT d.*, e.principal_id, e.device_id, e.adapter_version, m.comm_session_id
       FROM deliveries d LEFT JOIN endpoints e ON e.endpoint_id = d.endpoint_id
       JOIN messages m ON m.message_id = d.message_id WHERE d.message_id = ?`,
    ).get(messageId) as AckRow | undefined;
    if (!row) return failure("not_found", 404);
    if (!row.endpoint_id) return failure("ack_not_applicable", 409);
    if (row.principal_id !== auth.principalId || row.device_id !== auth.deviceId) {
      return failure("endpoint_not_owned", 403);
    }
    const now = nowIso();
    let recorded: "state" | "audit_only" = "state";
    transaction(this.db, () => {
      this.db.prepare(
        `INSERT OR IGNORE INTO delivery_attempts(attempt_id, delivery_id, phase, result_code, retryable,
         runtime_ack_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.attemptId,
        row.delivery_id,
        input.phase,
        input.resultCode ?? null,
        input.retryable ? 1 : 0,
        input.runtimeAckId ?? null,
        now,
      );
      if (["expired", "revoked", "rejected", "failed"].includes(row.status)) {
        recorded = "audit_only";
      } else if (input.phase === "device_ack") {
        this.db.prepare(
          `UPDATE deliveries SET status = 'device_acked', device_ack_received_at = ?
           WHERE delivery_id = ? AND status IN ('queued', 'dispatched')`,
        ).run(now, row.delivery_id);
      } else if (input.phase === "runtime_pending") {
        this.db.prepare(
          `UPDATE deliveries SET status = 'runtime_pending', runtime_pending_at = ?, result_code = ?
           WHERE delivery_id = ? AND status IN ('device_acked', 'runtime_pending')`,
        ).run(now, input.resultCode ?? "queued_busy", row.delivery_id);
      } else if (input.phase === "runtime_ack") {
        const adapterLabel = row.adapter_version.startsWith("fake-") ? "[MOCK: FakeRuntimeAdapter]" : null;
        this.db.prepare(
          `UPDATE deliveries SET status = 'runtime_acked', runtime_ack_received_at = ?, runtime_ack_id = ?,
           result_code = NULL, adapter_label = ? WHERE delivery_id = ?
           AND status IN ('device_acked', 'runtime_pending')`,
        ).run(now, input.runtimeAckId ?? null, adapterLabel, row.delivery_id);
      } else {
        this.db.prepare(
          `UPDATE deliveries SET status = 'failed', terminal_at = ?, result_code = ?
           WHERE delivery_id = ? AND status IN ('queued', 'dispatched', 'device_acked', 'runtime_pending')`,
        ).run(now, input.resultCode ?? "runtime_unavailable", row.delivery_id);
      }
      audit(this.db, {
        actorPrincipalId: auth.principalId,
        action: recorded === "audit_only" ? "delivery.late_ack" : `delivery.${input.phase}`,
        entityType: "message",
        entityId: messageId,
        metadata: {
          deliveryId: row.delivery_id,
          attemptId: input.attemptId,
          resultCode: input.resultCode ?? null,
          recorded,
        },
      });
    });
    return { ok: true, value: { recorded } };
  }

  validateInjection(
    auth: AuthContext,
    input: { messageId: string; communicationSessionId: string; endpointId: string; sessionHandle?: string },
  ): { valid: true } | { valid: false; reason: string } {
    let result: { valid: true } | { valid: false; reason: string };
    const message = this.db.prepare(
      `SELECT m.*, d.status AS delivery_status, d.endpoint_id AS delivery_endpoint_id
       FROM messages m JOIN deliveries d ON d.message_id = m.message_id WHERE m.message_id = ?`,
    ).get(input.messageId) as ValidationRow | undefined;
    if (!message || message.comm_session_id !== input.communicationSessionId) {
      result = { valid: false, reason: "wrong_target" };
    } else {
      const ownedEndpoint = this.endpoints.getOwned(auth, input.endpointId);
      if (!ownedEndpoint.ok || message.delivery_endpoint_id !== input.endpointId) {
        result = { valid: false, reason: "endpoint_not_owned" };
      } else {
        const active = this.comms.requireActive(auth.principalId, input.communicationSessionId);
        if (!active.ok) {
          result = { valid: false, reason: active.code };
        } else if (["expired", "revoked", "rejected", "failed"].includes(message.delivery_status)) {
          result = { valid: false, reason: "delivery_terminal" };
        } else if (message.expires_at <= nowIso()) {
          result = { valid: false, reason: "message_expired" };
        } else if (!input.sessionHandle || message.target_session_handle !== input.sessionHandle) {
          result = { valid: false, reason: "wrong_target" };
        } else {
          const session = this.endpoints.getSession(input.sessionHandle);
          if (!session || session.endpointId !== input.endpointId) result = { valid: false, reason: "session_not_found" };
          else if (session.state === "closed") result = { valid: false, reason: "session_closed" };
          else if (!session.allowInbound) result = { valid: false, reason: "inbound_disabled" };
          else result = { valid: true };
        }
      }
    }
    audit(this.db, {
      actorPrincipalId: auth.principalId,
      action: result.valid ? "injection.validated" : "injection.rejected",
      entityType: "message",
      entityId: input.messageId,
      metadata: { endpointId: input.endpointId, sessionHandle: input.sessionHandle ?? null, ...result },
    });
    return result;
  }

  markDispatched(messageId: string): void {
    const now = nowIso();
    const result = this.db.prepare(
      "UPDATE deliveries SET status = 'dispatched', dispatched_at = ? WHERE message_id = ? AND status = 'queued'",
    ).run(now, messageId);
    if (Number(result.changes) > 0) {
      const message = this.db.prepare("SELECT sender_principal_id FROM messages WHERE message_id = ?").get(messageId) as {
        sender_principal_id: string;
      };
      audit(this.db, {
        actorPrincipalId: "system",
        action: "delivery.dispatched",
        entityType: "message",
        entityId: messageId,
        metadata: { senderPrincipalId: message.sender_principal_id },
      });
    }
  }

  getStatus(principalId: string, messageId: string): ServiceResult<MessageDelivery> {
    const owner = this.db.prepare("SELECT sender_principal_id FROM messages WHERE message_id = ?").get(messageId) as
      | { sender_principal_id: string }
      | undefined;
    if (!owner || owner.sender_principal_id !== principalId) return failure("not_found", 404);
    return { ok: true, value: this.mapDelivery(messageId) };
  }

  listInbox(principalId: string): Array<{ envelope: MessageEnvelope; delivery: MessageDelivery }> {
    const rows = this.db.prepare(
      `SELECT m.message_id FROM inbox_items i JOIN messages m ON m.message_id = i.message_id
       WHERE i.principal_id = ? ORDER BY i.created_at`,
    ).all(principalId) as Array<{ message_id: string }>;
    return rows.map((row) => ({ envelope: this.envelopeFor(row.message_id), delivery: this.mapDelivery(row.message_id) }));
  }

  envelopeFor(messageId: string): MessageEnvelope {
    const row = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as unknown as MessageRow;
    return {
      id: row.message_id,
      clientMessageId: row.client_message_id,
      ...(row.comm_session_id ? { communicationSessionId: row.comm_session_id } : {}),
      senderPrincipalId: row.sender_principal_id,
      target: {
        kind: row.target_kind,
        principalId: row.target_principal_id,
        ...(row.target_endpoint_id ? { endpointId: row.target_endpoint_id } : {}),
        ...(row.target_session_handle ? { sessionHandle: row.target_session_handle } : {}),
      },
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      sequence: row.sequence,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private insertMessage(input: InsertMessage): void {
    this.db.prepare(
      `INSERT INTO messages(message_id, client_message_id, request_hash, comm_session_id,
       sender_principal_id, target_kind, target_principal_id, target_endpoint_id, target_session_handle,
       kind, payload_json, reply_to, correlation_id, sequence, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.messageId,
      input.clientMessageId,
      input.requestHash,
      input.commSessionId ?? null,
      input.senderPrincipalId,
      input.targetKind,
      input.targetPrincipalId,
      input.targetEndpointId ?? null,
      input.targetSessionHandle ?? null,
      input.kind,
      JSON.stringify(input.payload),
      input.replyTo ?? null,
      input.correlationId ?? null,
      input.sequence,
      input.createdAt,
      input.expiresAt,
    );
  }

  private findDuplicate(principalId: string, clientMessageId: string): { message_id: string; request_hash: string } | undefined {
    return this.db.prepare(
      "SELECT message_id, request_hash FROM messages WHERE sender_principal_id = ? AND client_message_id = ?",
    ).get(principalId, clientMessageId) as { message_id: string; request_hash: string } | undefined;
  }

  private receiptFor(messageId: string, duplicate: boolean): MessageReceipt {
    const delivery = this.mapDelivery(messageId);
    return {
      messageId,
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      duplicate,
      queuedAt: delivery.queuedAt,
    };
  }

  private mapDelivery(messageId: string): MessageDelivery {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(messageId) as unknown as DeliveryRow;
    const attempts = this.db.prepare(
      "SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY created_at, attempt_id",
    ).all(row.delivery_id) as unknown as AttemptRow[];
    return {
      messageId,
      deliveryId: row.delivery_id,
      status: row.status,
      queuedAt: row.queued_at,
      ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
      ...(row.device_ack_received_at ? { deviceAckReceivedAt: row.device_ack_received_at } : {}),
      ...(row.runtime_pending_at ? { runtimePendingAt: row.runtime_pending_at } : {}),
      ...(row.runtime_ack_received_at ? { runtimeAckReceivedAt: row.runtime_ack_received_at } : {}),
      ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
      ...(row.result_code ? { resultCode: row.result_code } : {}),
      ...(row.runtime_ack_id ? { runtimeAckId: row.runtime_ack_id } : {}),
      ...(row.adapter_label ? { adapterLabel: row.adapter_label } : {}),
      attempts: attempts.map(mapAttempt),
    };
  }
}

interface InsertMessage {
  messageId: string;
  clientMessageId: string;
  requestHash: string;
  commSessionId?: string;
  senderPrincipalId: string;
  targetKind: MessageEnvelope["target"]["kind"];
  targetPrincipalId: string;
  targetEndpointId?: string;
  targetSessionHandle?: string;
  kind: MessageEnvelope["kind"];
  payload: Record<string, unknown>;
  replyTo?: string;
  correlationId?: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
}

interface MessageRow {
  message_id: string;
  client_message_id: string;
  comm_session_id: string | null;
  sender_principal_id: string;
  target_kind: MessageEnvelope["target"]["kind"];
  target_principal_id: string;
  target_endpoint_id: string | null;
  target_session_handle: string | null;
  kind: MessageEnvelope["kind"];
  payload_json: string;
  reply_to: string | null;
  correlation_id: string | null;
  sequence: number;
  created_at: string;
  expires_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  status: DeliveryStatus;
  queued_at: string;
  dispatched_at: string | null;
  device_ack_received_at: string | null;
  runtime_pending_at: string | null;
  runtime_ack_received_at: string | null;
  terminal_at: string | null;
  result_code: string | null;
  runtime_ack_id: string | null;
  adapter_label: string | null;
}

interface AttemptRow {
  attempt_id: string;
  phase: DeliveryAttempt["phase"];
  result_code: string | null;
  retryable: number;
  runtime_ack_id: string | null;
  created_at: string;
}

interface AckRow extends DeliveryRow {
  delivery_id: string;
  endpoint_id: string | null;
  principal_id: string | null;
  device_id: string | null;
  adapter_version: string;
  comm_session_id: string | null;
}

interface ValidationRow {
  comm_session_id: string | null;
  delivery_status: DeliveryStatus;
  delivery_endpoint_id: string | null;
  target_session_handle: string | null;
  expires_at: string;
}

function mapAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    attemptId: row.attempt_id,
    phase: row.phase,
    ...(row.result_code ? { resultCode: row.result_code } : {}),
    retryable: Boolean(row.retryable),
    ...(row.runtime_ack_id ? { runtimeAckId: row.runtime_ack_id } : {}),
    createdAt: row.created_at,
  };
}

function failure<T>(
  code: import("../../shared/reason-codes.js").ReasonCode,
  httpStatus: number,
): ServiceResult<T> {
  return { ok: false, code, httpStatus };
}
