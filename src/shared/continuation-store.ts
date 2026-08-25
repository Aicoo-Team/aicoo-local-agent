import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableHash } from "./ids.js";

export type ContinuationState =
  | "awaiting_approval"
  | "approved_pending_activation"
  | "rebuilding_session"
  | "resuming"
  | "completed"
  | "denied"
  | "approval_expired"
  | "approval_delivery_failed"
  | "activation_failed"
  | "resume_failed";

export interface ContinuationCheckpoint {
  continuationId: string;
  idempotencyKey: string;
  correlationId: string;
  communicationSessionId: string;
  messageId: string;
  sessionHandle: string;
  runtimeTurnId: string;
  originalMessage: Record<string, unknown>;
  requestedCapability: {
    toolName: string;
    canonicalResource: string;
    summary: string;
  };
  state: ContinuationState;
  grantId?: string;
  grantRevision?: number;
  expectedBoundaryManifestHash?: string;
  boundaryManifestHash?: string;
  errorCode?: string;
}

export type CreateContinuationInput = Omit<
  ContinuationCheckpoint,
  "continuationId" | "state" | "grantId" | "grantRevision" | "expectedBoundaryManifestHash"
  | "boundaryManifestHash" | "errorCode"
>;

/** Durable, idempotent state for a paused C2C tool call that requires a new kernel boundary. */
export class ContinuationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS c2c_continuations (
        continuation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        communication_session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_handle TEXT NOT NULL,
        runtime_turn_id TEXT NOT NULL,
        original_message_json TEXT NOT NULL,
        requested_capability_json TEXT NOT NULL,
        state TEXT NOT NULL,
        grant_id TEXT,
        grant_revision INTEGER,
        expected_boundary_manifest_hash TEXT,
        boundary_manifest_hash TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_c2c_continuations_state
        ON c2c_continuations(state, updated_at);
    `);
  }

  create(input: CreateContinuationInput): ContinuationCheckpoint {
    validateInput(input);
    const requestHash = stableHash(input);
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const row = this.rowForIdempotencyKey(input.idempotencyKey)!;
      if (row.request_hash !== requestHash) throw new Error("continuation idempotency conflict");
      return existing;
    }
    const continuationId = `cont_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO c2c_continuations(
         continuation_id, idempotency_key, request_hash, correlation_id,
         communication_session_id, message_id, session_handle, runtime_turn_id,
         original_message_json, requested_capability_json, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)`,
    ).run(
      continuationId,
      input.idempotencyKey,
      requestHash,
      input.correlationId,
      input.communicationSessionId,
      input.messageId,
      input.sessionHandle,
      input.runtimeTurnId,
      JSON.stringify(input.originalMessage),
      JSON.stringify(input.requestedCapability),
      now,
      now,
    );
    return this.require(continuationId);
  }

  find(continuationId: string): ContinuationCheckpoint | undefined {
    const row = this.db.prepare(
      "SELECT * FROM c2c_continuations WHERE continuation_id = ?",
    ).get(continuationId) as ContinuationRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): ContinuationCheckpoint[] {
    const rows = this.db.prepare(
      "SELECT * FROM c2c_continuations ORDER BY created_at, continuation_id",
    ).all() as unknown as ContinuationRow[];
    return rows.map(fromRow);
  }

  listRecoverable(): ContinuationCheckpoint[] {
    const rows = this.db.prepare(
      `SELECT * FROM c2c_continuations
       WHERE state IN ('approved_pending_activation', 'rebuilding_session', 'resuming')
       ORDER BY updated_at, continuation_id`,
    ).all() as unknown as ContinuationRow[];
    return rows.map(fromRow);
  }

  markApproved(
    continuationId: string,
    approval: { grantId: string; grantRevision: number; expectedBoundaryManifestHash: string },
  ): ContinuationCheckpoint {
    const current = this.require(continuationId);
    if (current.state === "approved_pending_activation") {
      if (
        current.grantId === approval.grantId
        && current.grantRevision === approval.grantRevision
        && current.expectedBoundaryManifestHash === approval.expectedBoundaryManifestHash
      ) return current;
      throw new Error("continuation approval conflict");
    }
    this.requireState(current, "awaiting_approval");
    this.db.prepare(
      `UPDATE c2c_continuations
       SET state = 'approved_pending_activation', grant_id = ?, grant_revision = ?,
           expected_boundary_manifest_hash = ?, updated_at = ?
       WHERE continuation_id = ?`,
    ).run(
      approval.grantId,
      approval.grantRevision,
      approval.expectedBoundaryManifestHash,
      new Date().toISOString(),
      continuationId,
    );
    return this.require(continuationId);
  }

  markRebuilding(continuationId: string): ContinuationCheckpoint {
    return this.transition(continuationId, "approved_pending_activation", "rebuilding_session");
  }

  markAttested(continuationId: string, boundaryManifestHash: string): ContinuationCheckpoint {
    const current = this.require(continuationId);
    if (current.state === "resuming" && current.boundaryManifestHash === boundaryManifestHash) return current;
    this.requireState(current, "rebuilding_session");
    if (!current.expectedBoundaryManifestHash || current.expectedBoundaryManifestHash !== boundaryManifestHash) {
      this.db.prepare(
        `UPDATE c2c_continuations
         SET state = 'activation_failed', boundary_manifest_hash = ?,
             error_code = 'boundary_attestation_mismatch', updated_at = ?
         WHERE continuation_id = ?`,
      ).run(boundaryManifestHash, new Date().toISOString(), continuationId);
      return this.require(continuationId);
    }
    this.db.prepare(
      `UPDATE c2c_continuations
       SET state = 'resuming', boundary_manifest_hash = ?, error_code = NULL, updated_at = ?
       WHERE continuation_id = ?`,
    ).run(boundaryManifestHash, new Date().toISOString(), continuationId);
    return this.require(continuationId);
  }

  markResuming(continuationId: string): ContinuationCheckpoint {
    const current = this.require(continuationId);
    if (current.state === "resuming") return current;
    throw invalidTransition(current.state, "resuming");
  }

  markCompleted(continuationId: string): ContinuationCheckpoint {
    return this.transition(continuationId, "resuming", "completed");
  }

  markApprovalExpired(continuationId: string): ContinuationCheckpoint {
    return this.transition(continuationId, "awaiting_approval", "approval_expired");
  }

  markDenied(continuationId: string): ContinuationCheckpoint {
    return this.transition(continuationId, "awaiting_approval", "denied");
  }

  markApprovalDeliveryFailed(continuationId: string): ContinuationCheckpoint {
    return this.transition(continuationId, "awaiting_approval", "approval_delivery_failed");
  }

  markActivationFailed(continuationId: string, errorCode: string): ContinuationCheckpoint {
    return this.failTransition(
      continuationId,
      ["approved_pending_activation", "rebuilding_session"],
      "activation_failed",
      errorCode,
    );
  }

  markResumeFailed(continuationId: string, errorCode: string): ContinuationCheckpoint {
    return this.failTransition(continuationId, ["resuming"], "resume_failed", errorCode);
  }

  private transition(
    continuationId: string,
    from: ContinuationState,
    to: ContinuationState,
  ): ContinuationCheckpoint {
    const current = this.require(continuationId);
    if (current.state === to) return current;
    this.requireState(current, from);
    this.db.prepare(
      "UPDATE c2c_continuations SET state = ?, updated_at = ? WHERE continuation_id = ?",
    ).run(to, new Date().toISOString(), continuationId);
    return this.require(continuationId);
  }

  private failTransition(
    continuationId: string,
    from: readonly ContinuationState[],
    to: ContinuationState,
    errorCode: string,
  ): ContinuationCheckpoint {
    if (!errorCode.trim() || errorCode.length > 256) throw new Error("invalid continuation errorCode");
    const current = this.require(continuationId);
    if (current.state === to && current.errorCode === errorCode) return current;
    if (!from.includes(current.state)) throw invalidTransition(current.state, to);
    this.db.prepare(
      `UPDATE c2c_continuations
       SET state = ?, error_code = ?, updated_at = ? WHERE continuation_id = ?`,
    ).run(to, errorCode, new Date().toISOString(), continuationId);
    return this.require(continuationId);
  }

  private requireState(current: ContinuationCheckpoint, expected: ContinuationState): void {
    if (current.state !== expected) throw invalidTransition(current.state, expected);
  }

  private require(continuationId: string): ContinuationCheckpoint {
    const checkpoint = this.find(continuationId);
    if (!checkpoint) throw new Error(`unknown continuation: ${continuationId}`);
    return checkpoint;
  }

  private findByIdempotencyKey(idempotencyKey: string): ContinuationCheckpoint | undefined {
    const row = this.rowForIdempotencyKey(idempotencyKey);
    return row ? fromRow(row) : undefined;
  }

  private rowForIdempotencyKey(idempotencyKey: string): ContinuationRow | undefined {
    return this.db.prepare(
      "SELECT * FROM c2c_continuations WHERE idempotency_key = ?",
    ).get(idempotencyKey) as ContinuationRow | undefined;
  }
}

interface ContinuationRow {
  continuation_id: string;
  idempotency_key: string;
  request_hash: string;
  correlation_id: string;
  communication_session_id: string;
  message_id: string;
  session_handle: string;
  runtime_turn_id: string;
  original_message_json: string;
  requested_capability_json: string;
  state: ContinuationState;
  grant_id: string | null;
  grant_revision: number | null;
  expected_boundary_manifest_hash: string | null;
  boundary_manifest_hash: string | null;
  error_code: string | null;
}

function fromRow(row: ContinuationRow): ContinuationCheckpoint {
  return {
    continuationId: row.continuation_id,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    communicationSessionId: row.communication_session_id,
    messageId: row.message_id,
    sessionHandle: row.session_handle,
    runtimeTurnId: row.runtime_turn_id,
    originalMessage: JSON.parse(row.original_message_json) as Record<string, unknown>,
    requestedCapability: JSON.parse(row.requested_capability_json) as ContinuationCheckpoint["requestedCapability"],
    state: row.state,
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.grant_revision !== null ? { grantRevision: row.grant_revision } : {}),
    ...(row.expected_boundary_manifest_hash
      ? { expectedBoundaryManifestHash: row.expected_boundary_manifest_hash }
      : {}),
    ...(row.boundary_manifest_hash ? { boundaryManifestHash: row.boundary_manifest_hash } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function validateInput(input: CreateContinuationInput): void {
  for (const [name, value, limit] of [
    ["idempotencyKey", input.idempotencyKey, 512],
    ["correlationId", input.correlationId, 512],
    ["communicationSessionId", input.communicationSessionId, 512],
    ["messageId", input.messageId, 512],
    ["sessionHandle", input.sessionHandle, 512],
    ["runtimeTurnId", input.runtimeTurnId, 512],
    ["toolName", input.requestedCapability.toolName, 128],
    ["canonicalResource", input.requestedCapability.canonicalResource, 4_096],
    ["summary", input.requestedCapability.summary, 2_048],
  ] as const) {
    if (!value.trim() || value.length > limit) throw new Error(`invalid continuation ${name}`);
  }
  if (JSON.stringify(input.originalMessage).length > 64 * 1024) {
    throw new Error("continuation original message is too large");
  }
}

function invalidTransition(from: ContinuationState, to: ContinuationState): Error {
  return new Error(`invalid continuation transition: ${from} -> ${to}`);
}
