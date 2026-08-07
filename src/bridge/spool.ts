import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationTurnInput,
  LocalAgentDelegationInput,
  MessageEnvelope,
  RuntimeEvent,
} from "../shared/contracts.js";

export type SpoolStatus =
  | "received"
  | "device_acked"
  | "runtime_pending"
  | "injecting"
  | "injected_unreported"
  | "injected"
  | "failed"
  | "blocked"
  | "blocked_offline";

export interface SpoolMessage {
  messageId: string;
  deliveryId: string;
  communicationSessionId: string;
  sessionHandle: string;
  sequence: number;
  envelope: MessageEnvelope;
  status: SpoolStatus;
  attemptCount: number;
  lastResultCode?: string;
  runtimeAckId?: string;
}

export interface PendingInjectionReport {
  attemptId: string;
  messageId: string;
  phase: "runtime_pending" | "runtime_ack" | "runtime_failed";
  resultCode?: string;
  retryable: boolean;
  runtimeAckId?: string;
}

export interface OutboundReply {
  eventId: string;
  communicationSessionId: string;
  clientMessageId: string;
  payload: Record<string, unknown>;
  replyTo: string;
  correlationId: string;
  collaborationTurn?: CollaborationTurnInput;
  status: "pending" | "sent" | "failed";
  attemptCount: number;
  lastError?: string;
}

export type PendingDelegationStatus = "grant_requested" | "delegated" | "failed";

export interface PendingDelegation {
  clientMessageId: string;
  target: LocalAgentDelegationInput["target"];
  task: LocalAgentDelegationInput["task"];
  context?: LocalAgentDelegationInput["context"];
  sessionHandle: string;
  correlationId?: string;
  requestedTtlMinutes?: number;
  communicationSessionId?: string;
  messageId?: string;
  status: PendingDelegationStatus;
  attemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export class BridgeSpool {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        server_key TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_mappings (
        native_handle TEXT PRIMARY KEY,
        server_handle TEXT NOT NULL,
        label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spool_messages (
        message_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL,
        comm_session_id TEXT NOT NULL,
        session_handle TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_result_code TEXT,
        runtime_ack_id TEXT
      );
      CREATE TABLE IF NOT EXISTS grant_cache (
        comm_session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        grant_expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS injection_attempts (
        attempt_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        result_code TEXT,
        retryable INTEGER NOT NULL,
        runtime_ack_id TEXT,
        reported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adapter_cursors (
        native_handle TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_replies (
        event_id TEXT PRIMARY KEY,
        comm_session_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        reply_to TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_delegations (
        client_message_id TEXT PRIMARY KEY,
        target_json TEXT NOT NULL,
        task_json TEXT NOT NULL,
        context_json TEXT,
        session_handle TEXT NOT NULL,
        correlation_id TEXT,
        requested_ttl_minutes INTEGER,
        comm_session_id TEXT,
        message_id TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spool_injectable
        ON spool_messages(status, comm_session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_pending_delegations_status
        ON pending_delegations(status, comm_session_id, expires_at);
    `);
    const pendingColumns = this.db.prepare("PRAGMA table_info(pending_delegations)").all() as unknown as Array<{
      name: string;
    }>;
    if (!pendingColumns.some((column) => column.name === "context_json")) {
      this.db.exec("ALTER TABLE pending_delegations ADD COLUMN context_json TEXT");
    }
    const outboundColumns = this.db.prepare("PRAGMA table_info(outbound_replies)").all() as unknown as Array<{
      name: string;
    }>;
    if (!outboundColumns.some((column) => column.name === "collaboration_turn_json")) {
      this.db.exec("ALTER TABLE outbound_replies ADD COLUMN collaboration_turn_json TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  setIdentity(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO bridge_identity(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  getIdentity(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM bridge_identity WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  saveSessionMapping(nativeHandle: string, serverHandle: string, label: string): void {
    this.db.prepare(
      `INSERT INTO session_mappings(native_handle, server_handle, label) VALUES (?, ?, ?)
       ON CONFLICT(native_handle) DO UPDATE SET server_handle = excluded.server_handle, label = excluded.label`,
    ).run(nativeHandle, serverHandle, label);
  }

  getSessionMapping(nativeHandle: string): { serverHandle: string; label: string } | undefined {
    const row = this.db.prepare(
      "SELECT server_handle, label FROM session_mappings WHERE native_handle = ?",
    ).get(nativeHandle) as { server_handle: string; label: string } | undefined;
    return row ? { serverHandle: row.server_handle, label: row.label } : undefined;
  }

  listSessionMappings(): Array<{ nativeHandle: string; serverHandle: string; label: string }> {
    const rows = this.db.prepare("SELECT * FROM session_mappings ORDER BY native_handle").all() as unknown as Array<{
      native_handle: string;
      server_handle: string;
      label: string;
    }>;
    return rows.map((row) => ({ nativeHandle: row.native_handle, serverHandle: row.server_handle, label: row.label }));
  }

  cursor(serverKey: string): string {
    const row = this.db.prepare("SELECT last_seq FROM cursors WHERE server_key = ?").get(serverKey) as
      | { last_seq: number }
      | undefined;
    return String(row?.last_seq ?? 0);
  }

  saveCursor(serverKey: string, cursor: string): void {
    const sequence = Number.parseInt(cursor, 10);
    this.db.prepare(
      `INSERT INTO cursors(server_key, last_seq) VALUES (?, ?)
       ON CONFLICT(server_key) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
    ).run(serverKey, Number.isFinite(sequence) ? sequence : 0);
  }

  adapterCursor(nativeHandle: string): string {
    const row = this.db.prepare("SELECT last_seq FROM adapter_cursors WHERE native_handle = ?").get(nativeHandle) as
      | { last_seq: number }
      | undefined;
    return String(row?.last_seq ?? 0);
  }

  saveAdapterCursor(nativeHandle: string, cursor: string): void {
    const sequence = Number.parseInt(cursor, 10);
    this.db.prepare(
      `INSERT INTO adapter_cursors(native_handle, last_seq) VALUES (?, ?)
       ON CONFLICT(native_handle) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
    ).run(nativeHandle, Number.isFinite(sequence) ? sequence : 0);
  }

  storeDispatch(event: RuntimeEvent): { inserted: boolean; message: SpoolMessage } {
    const data = event.data as { envelope?: MessageEnvelope; deliveryId?: string };
    if (!data.envelope?.communicationSessionId || !data.envelope.target.sessionHandle || !data.deliveryId) {
      throw new Error("Invalid message.dispatch event");
    }
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO spool_messages(message_id, delivery_id, comm_session_id, session_handle,
       sequence, envelope_json, status) VALUES (?, ?, ?, ?, ?, ?, 'received')`,
    ).run(
      data.envelope.id,
      data.deliveryId,
      data.envelope.communicationSessionId,
      data.envelope.target.sessionHandle,
      data.envelope.sequence,
      JSON.stringify(data.envelope),
    );
    const message = this.getMessage(data.envelope.id);
    if (!message) throw new Error("Spool insert could not be read back");
    return { inserted: Number(result.changes) > 0, message };
  }

  markDeviceAcked(messageId: string): void {
    this.db.prepare(
      "UPDATE spool_messages SET status = 'device_acked' WHERE message_id = ? AND status = 'received'",
    ).run(messageId);
  }

  markInjecting(messageId: string): void {
    this.db.prepare(
      `UPDATE spool_messages SET status = 'injecting', attempt_count = attempt_count + 1
       WHERE message_id = ? AND status IN ('device_acked', 'runtime_pending', 'blocked_offline')`,
    ).run(messageId);
  }

  markResult(messageId: string, status: SpoolStatus, resultCode?: string, runtimeAckId?: string): void {
    this.db.prepare(
      `UPDATE spool_messages SET status = ?, last_result_code = ?, runtime_ack_id = ? WHERE message_id = ?`,
    ).run(status, resultCode ?? null, runtimeAckId ?? null, messageId);
  }

  listInjectable(): SpoolMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM spool_messages m
       WHERE m.status IN ('device_acked', 'runtime_pending', 'blocked_offline')
       AND NOT EXISTS (
         SELECT 1 FROM spool_messages earlier
         WHERE earlier.comm_session_id = m.comm_session_id AND earlier.sequence < m.sequence
         AND earlier.status NOT IN ('injected', 'failed', 'blocked')
       )
       ORDER BY m.comm_session_id, m.sequence`,
    ).all() as unknown as SpoolRow[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.comm_session_id)) return [];
      seen.add(row.comm_session_id);
      return [mapSpool(row)];
    });
  }

  /** Messages recorded from a dispatch event but not yet device-acked. The injector retries
   *  the device-ack for these (and drops expired ones), so ack never runs on the SSE path. */
  listReceived(): SpoolMessage[] {
    const rows = this.db.prepare(
      "SELECT * FROM spool_messages WHERE status = 'received' ORDER BY sequence",
    ).all() as unknown as SpoolRow[];
    return rows.map(mapSpool);
  }

  blockCommunicationSession(commSessionId: string, reason: string, grantStatus = "revoked"): void {
    this.db.prepare(
      `UPDATE spool_messages SET status = 'blocked', last_result_code = ?
       WHERE comm_session_id = ? AND status NOT IN ('injected', 'failed', 'blocked')`,
    ).run(reason, commSessionId);
    this.setGrant(commSessionId, grantStatus);
  }

  blockCollaboration(collaborationId: string, reason: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT comm_session_id FROM spool_messages
       WHERE json_extract(envelope_json, '$.collaborationId') = ?`,
    ).all(collaborationId) as unknown as Array<{ comm_session_id: string }>;
    const communicationSessionIds = rows.map((row) => row.comm_session_id);
    for (const commSessionId of communicationSessionIds) {
      this.blockCommunicationSession(commSessionId, reason);
      this.db.prepare(
        `UPDATE outbound_replies SET status = 'failed', last_error = ?
         WHERE comm_session_id = ? AND status = 'pending'`,
      ).run(reason, commSessionId);
    }
    return communicationSessionIds;
  }

  setGrant(commSessionId: string, status: string, expiresAt?: string): void {
    this.db.prepare(
      `INSERT INTO grant_cache(comm_session_id, status, grant_expires_at) VALUES (?, ?, ?)
       ON CONFLICT(comm_session_id) DO UPDATE SET status = excluded.status,
       grant_expires_at = excluded.grant_expires_at`,
    ).run(commSessionId, status, expiresAt ?? null);
  }

  recordAttempt(input: {
    attemptId: string;
    messageId: string;
    phase: string;
    resultCode?: string;
    retryable: boolean;
    runtimeAckId?: string;
    createdAt: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO injection_attempts(attempt_id, message_id, phase, result_code,
       retryable, runtime_ack_id, reported, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      input.attemptId,
      input.messageId,
      input.phase,
      input.resultCode ?? null,
      input.retryable ? 1 : 0,
      input.runtimeAckId ?? null,
      input.createdAt,
    );
  }

  markAttemptReported(attemptId: string): void {
    this.db.prepare("UPDATE injection_attempts SET reported = 1 WHERE attempt_id = ?").run(attemptId);
  }

  listPendingReports(): PendingInjectionReport[] {
    const rows = this.db.prepare(
      `SELECT attempt_id, message_id, phase, result_code, retryable, runtime_ack_id
       FROM injection_attempts WHERE reported = 0 ORDER BY created_at, attempt_id`,
    ).all() as unknown as Array<{
      attempt_id: string;
      message_id: string;
      phase: PendingInjectionReport["phase"];
      result_code: string | null;
      retryable: number;
      runtime_ack_id: string | null;
    }>;
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      messageId: row.message_id,
      phase: row.phase,
      ...(row.result_code ? { resultCode: row.result_code } : {}),
      retryable: Boolean(row.retryable),
      ...(row.runtime_ack_id ? { runtimeAckId: row.runtime_ack_id } : {}),
    }));
  }

  storeOutboundReply(input: {
    eventId: string;
    communicationSessionId: string;
    clientMessageId: string;
    payload: Record<string, unknown>;
    replyTo: string;
    correlationId: string;
    collaborationTurn?: CollaborationTurnInput;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO outbound_replies(event_id, comm_session_id, client_message_id,
       payload_json, reply_to, correlation_id, collaboration_turn_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      input.eventId,
      input.communicationSessionId,
      input.clientMessageId,
      JSON.stringify(input.payload),
      input.replyTo,
      input.correlationId,
      input.collaborationTurn ? JSON.stringify(input.collaborationTurn) : null,
    );
  }

  listPendingOutboundReplies(): OutboundReply[] {
    const rows = this.db.prepare(
      "SELECT * FROM outbound_replies WHERE status = 'pending' ORDER BY rowid",
    ).all() as unknown as OutboundRow[];
    return rows.map(mapOutbound);
  }

  markOutboundSent(eventId: string): void {
    this.db.prepare(
      "UPDATE outbound_replies SET status = 'sent', attempt_count = attempt_count + 1, last_error = NULL WHERE event_id = ?",
    ).run(eventId);
  }

  markOutboundAttempt(eventId: string, error: string, terminal: boolean): void {
    this.db.prepare(
      "UPDATE outbound_replies SET status = ?, attempt_count = attempt_count + 1, last_error = ? WHERE event_id = ?",
    ).run(terminal ? "failed" : "pending", error, eventId);
  }

  getOutboundReply(eventId: string): OutboundReply | undefined {
    const row = this.db.prepare("SELECT * FROM outbound_replies WHERE event_id = ?").get(eventId) as unknown as
      | OutboundRow
      | undefined;
    return row ? mapOutbound(row) : undefined;
  }

  storePendingDelegation(input: {
    clientMessageId: string;
    target: LocalAgentDelegationInput["target"];
    task: LocalAgentDelegationInput["task"];
    context?: LocalAgentDelegationInput["context"];
    sessionHandle: string;
    correlationId?: string;
    requestedTtlMinutes?: number;
    communicationSessionId?: string;
    messageId?: string;
    status: PendingDelegationStatus;
    expiresAt: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO pending_delegations(client_message_id, target_json, task_json, context_json, session_handle,
       correlation_id, requested_ttl_minutes, comm_session_id, message_id, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_message_id) DO UPDATE SET
       context_json = COALESCE(excluded.context_json, pending_delegations.context_json),
       comm_session_id = COALESCE(excluded.comm_session_id, pending_delegations.comm_session_id),
       message_id = COALESCE(excluded.message_id, pending_delegations.message_id),
       status = excluded.status,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
    ).run(
      input.clientMessageId,
      JSON.stringify(input.target),
      JSON.stringify(input.task),
      input.context ? JSON.stringify(input.context) : null,
      input.sessionHandle,
      input.correlationId ?? null,
      input.requestedTtlMinutes ?? null,
      input.communicationSessionId ?? null,
      input.messageId ?? null,
      input.status,
      now,
      now,
      input.expiresAt,
    );
  }

  listPendingDelegations(commSessionId?: string): PendingDelegation[] {
    const rows = commSessionId
      ? this.db.prepare(
        `SELECT * FROM pending_delegations
         WHERE status = 'grant_requested' AND comm_session_id = ?
         ORDER BY created_at`,
      ).all(commSessionId)
      : this.db.prepare(
        `SELECT * FROM pending_delegations
         WHERE status = 'grant_requested'
         ORDER BY created_at`,
      ).all();
    return (rows as unknown as PendingDelegationRow[]).map(mapPendingDelegation);
  }

  markDelegationAttempt(clientMessageId: string, error?: string): void {
    this.db.prepare(
      `UPDATE pending_delegations
       SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
       WHERE client_message_id = ?`,
    ).run(error ?? null, new Date().toISOString(), clientMessageId);
  }

  markDelegationDelegated(clientMessageId: string, messageId: string, commSessionId: string): void {
    this.db.prepare(
      `UPDATE pending_delegations
       SET status = 'delegated', message_id = ?, comm_session_id = ?, last_error = NULL, updated_at = ?
       WHERE client_message_id = ?`,
    ).run(messageId, commSessionId, new Date().toISOString(), clientMessageId);
  }

  markDelegationsFailed(commSessionId: string, error: string): void {
    this.db.prepare(
      `UPDATE pending_delegations
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE comm_session_id = ? AND status = 'grant_requested'`,
    ).run(error, new Date().toISOString(), commSessionId);
  }

  getMessage(messageId: string): SpoolMessage | undefined {
    const row = this.db.prepare("SELECT * FROM spool_messages WHERE message_id = ?").get(messageId) as unknown as
      | SpoolRow
      | undefined;
    return row ? mapSpool(row) : undefined;
  }

  findReplyByCorrelation(correlationId: string): SpoolMessage | undefined {
    const row = this.db.prepare(
      `SELECT * FROM spool_messages
       WHERE json_extract(envelope_json, '$.correlationId') = ?
       AND json_extract(envelope_json, '$.replyTo') IS NOT NULL
       ORDER BY sequence DESC LIMIT 1`,
    ).get(correlationId) as unknown as SpoolRow | undefined;
    return row ? mapSpool(row) : undefined;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM spool_messages").get() as { count: number };
    return Number(row.count);
  }
}

interface SpoolRow {
  message_id: string;
  delivery_id: string;
  comm_session_id: string;
  session_handle: string;
  sequence: number;
  envelope_json: string;
  status: SpoolStatus;
  attempt_count: number;
  last_result_code: string | null;
  runtime_ack_id: string | null;
}

interface OutboundRow {
  event_id: string;
  comm_session_id: string;
  client_message_id: string;
  payload_json: string;
  reply_to: string;
  correlation_id: string;
  status: OutboundReply["status"];
  attempt_count: number;
  last_error: string | null;
  collaboration_turn_json: string | null;
}

interface PendingDelegationRow {
  client_message_id: string;
  target_json: string;
  task_json: string;
  context_json: string | null;
  session_handle: string;
  correlation_id: string | null;
  requested_ttl_minutes: number | null;
  comm_session_id: string | null;
  message_id: string | null;
  status: PendingDelegationStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

function mapSpool(row: SpoolRow): SpoolMessage {
  return {
    messageId: row.message_id,
    deliveryId: row.delivery_id,
    communicationSessionId: row.comm_session_id,
    sessionHandle: row.session_handle,
    sequence: row.sequence,
    envelope: JSON.parse(row.envelope_json) as MessageEnvelope,
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_result_code ? { lastResultCode: row.last_result_code } : {}),
    ...(row.runtime_ack_id ? { runtimeAckId: row.runtime_ack_id } : {}),
  };
}

function mapOutbound(row: OutboundRow): OutboundReply {
  return {
    eventId: row.event_id,
    communicationSessionId: row.comm_session_id,
    clientMessageId: row.client_message_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    replyTo: row.reply_to,
    correlationId: row.correlation_id,
    ...(row.collaboration_turn_json
      ? { collaborationTurn: JSON.parse(row.collaboration_turn_json) as CollaborationTurnInput }
      : {}),
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function mapPendingDelegation(row: PendingDelegationRow): PendingDelegation {
  return {
    clientMessageId: row.client_message_id,
    target: JSON.parse(row.target_json) as LocalAgentDelegationInput["target"],
    task: JSON.parse(row.task_json) as LocalAgentDelegationInput["task"],
    ...(row.context_json
      ? { context: JSON.parse(row.context_json) as NonNullable<LocalAgentDelegationInput["context"]> }
      : {}),
    sessionHandle: row.session_handle,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.requested_ttl_minutes ? { requestedTtlMinutes: row.requested_ttl_minutes } : {}),
    ...(row.comm_session_id ? { communicationSessionId: row.comm_session_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
