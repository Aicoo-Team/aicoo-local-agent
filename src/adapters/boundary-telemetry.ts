import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BoundaryMetricsSnapshot {
  eligibleTasks: number;
  initialBoundaryBuilds: number;
  postStartRebuildTasks: number;
  totalPostStartRebuilds: number;
  postStartRebuildAttempts: number;
  failedPostStartRebuilds: number;
  failedBoundaryBuilds: number;
  rebuildRate: number;
  rebuildFailureRate: number;
  rebuildLatencyP50Ms: number | null;
  rebuildLatencyP95Ms: number | null;
  rebuildsByCause: Record<BoundaryTransitionCause, number>;
  failuresByCode: Record<string, number>;
}

type BoundaryTransitionKind = "initial" | "post_start_rebuild";
export const BOUNDARY_TRANSITION_CAUSES = [
  "initial",
  "sender_change",
  "device_change",
  "boundary_change",
  "approval_boundary_expansion",
] as const;
export type BoundaryTransitionCause = typeof BOUNDARY_TRANSITION_CAUSES[number];

/**
 * Local, path-free evidence for deciding whether immutable session rebuilding is exceptional.
 * Raw boundary paths never enter telemetry; only the already-computed manifest key is hashed.
 */
export class BoundaryTelemetry {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS boundary_metric_tasks (
        message_id TEXT PRIMARY KEY,
        local_handle TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS boundary_metric_transitions (
        transition_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cause TEXT NOT NULL,
        boundary_key TEXT NOT NULL,
        success INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        failure_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_boundary_metric_transitions_message
        ON boundary_metric_transitions(message_id, kind, success);
    `);
    addColumn(db, "failure_code", "TEXT");
  }

  recordEligibleTask(input: {
    messageId: string;
    localHandle: string;
    correlationId: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO boundary_metric_tasks(message_id, local_handle, correlation_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.messageId, input.localHandle, input.correlationId, new Date().toISOString());
  }

  recordTransition(input: {
    transitionId?: string;
    messageId: string;
    kind: BoundaryTransitionKind;
    cause: BoundaryTransitionCause;
    boundaryKey: string;
    success: boolean;
    latencyMs: number;
    failureCode?: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO boundary_metric_transitions(
         transition_id, message_id, kind, cause, boundary_key, success, latency_ms, failure_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.transitionId ?? randomUUID(),
      input.messageId,
      input.kind,
      input.cause,
      stableBoundaryKey(input.boundaryKey),
      input.success ? 1 : 0,
      Math.max(0, Math.round(input.latencyMs)),
      safeFailureCode(input.failureCode),
      new Date().toISOString(),
    );
  }

  snapshot(): BoundaryMetricsSnapshot {
    const taskCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM boundary_metric_tasks",
    ).get() as { count: number };
    const transitions = this.db.prepare(
      `SELECT message_id, kind, cause, success, latency_ms, failure_code
       FROM boundary_metric_transitions ORDER BY created_at, transition_id`,
    ).all() as unknown as Array<{
      message_id: string;
      kind: BoundaryTransitionKind;
      cause: BoundaryTransitionCause;
      success: number;
      latency_ms: number;
      failure_code: string | null;
    }>;
    const successfulInitial = transitions.filter((transition) =>
      transition.kind === "initial" && transition.success === 1);
    const rebuildAttempts = transitions.filter((transition) => transition.kind === "post_start_rebuild");
    const successfulRebuilds = transitions.filter((transition) =>
      transition.kind === "post_start_rebuild" && transition.success === 1);
    const rebuildTasks = new Set(rebuildAttempts.map((transition) => transition.message_id));
    const failedRebuilds = rebuildAttempts.filter((transition) => transition.success !== 1);
    const latencies = rebuildAttempts.map((transition) => transition.latency_ms).sort((a, b) => a - b);
    const eligibleTasks = Number(taskCount.count);
    const rebuildsByCause = Object.fromEntries(
      BOUNDARY_TRANSITION_CAUSES.map((cause) => [
        cause,
        rebuildAttempts.filter((transition) => transition.cause === cause).length,
      ]),
    ) as Record<BoundaryTransitionCause, number>;
    const failuresByCode: Record<string, number> = {};
    for (const transition of failedRebuilds) {
      const code = transition.failure_code ?? "unknown_failure";
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    }
    return {
      eligibleTasks,
      initialBoundaryBuilds: successfulInitial.length,
      postStartRebuildTasks: rebuildTasks.size,
      totalPostStartRebuilds: successfulRebuilds.length,
      postStartRebuildAttempts: rebuildAttempts.length,
      failedPostStartRebuilds: failedRebuilds.length,
      failedBoundaryBuilds: transitions.filter((transition) => transition.success !== 1).length,
      rebuildRate: eligibleTasks === 0 ? 0 : rebuildTasks.size / eligibleTasks,
      rebuildFailureRate: rebuildAttempts.length === 0 ? 0 : failedRebuilds.length / rebuildAttempts.length,
      rebuildLatencyP50Ms: percentile(latencies, 0.5),
      rebuildLatencyP95Ms: percentile(latencies, 0.95),
      rebuildsByCause,
      failuresByCode,
    };
  }
}

function safeFailureCode(value: string | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9_:-]{1,128}$/u.test(value) ? value : "unknown_failure";
}

function addColumn(db: DatabaseSync, name: string, type: "TEXT"): void {
  try {
    db.exec(`ALTER TABLE boundary_metric_transitions ADD COLUMN ${name} ${type};`);
  } catch (error) {
    if (!/duplicate column/i.test(String(error))) throw error;
  }
}

function stableBoundaryKey(value: string): string {
  // A short non-reversible identifier is sufficient for grouping without persisting folder paths.
  return createHash("sha256").update(value).digest("hex");
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}
