import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BoundaryMetricsSnapshot {
  eligibleTasks: number;
  initialBoundaryBuilds: number;
  postStartRebuildTasks: number;
  totalPostStartRebuilds: number;
  failedBoundaryBuilds: number;
  rebuildRate: number;
  rebuildLatencyP50Ms: number | null;
  rebuildLatencyP95Ms: number | null;
}

type BoundaryTransitionKind = "initial" | "post_start_rebuild";

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
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_boundary_metric_transitions_message
        ON boundary_metric_transitions(message_id, kind, success);
    `);
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
    messageId: string;
    kind: BoundaryTransitionKind;
    cause: "initial" | "sender_change" | "device_change" | "boundary_change";
    boundaryKey: string;
    success: boolean;
    latencyMs: number;
  }): void {
    this.db.prepare(
      `INSERT INTO boundary_metric_transitions(
         transition_id, message_id, kind, cause, boundary_key, success, latency_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.messageId,
      input.kind,
      input.cause,
      stableBoundaryKey(input.boundaryKey),
      input.success ? 1 : 0,
      Math.max(0, Math.round(input.latencyMs)),
      new Date().toISOString(),
    );
  }

  snapshot(): BoundaryMetricsSnapshot {
    const taskCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM boundary_metric_tasks",
    ).get() as { count: number };
    const transitions = this.db.prepare(
      "SELECT message_id, kind, success, latency_ms FROM boundary_metric_transitions ORDER BY created_at, transition_id",
    ).all() as unknown as Array<{
      message_id: string;
      kind: BoundaryTransitionKind;
      success: number;
      latency_ms: number;
    }>;
    const successfulInitial = transitions.filter((transition) =>
      transition.kind === "initial" && transition.success === 1);
    const successfulRebuilds = transitions.filter((transition) =>
      transition.kind === "post_start_rebuild" && transition.success === 1);
    const rebuildTasks = new Set(successfulRebuilds.map((transition) => transition.message_id));
    const latencies = successfulRebuilds.map((transition) => transition.latency_ms).sort((a, b) => a - b);
    const eligibleTasks = Number(taskCount.count);
    return {
      eligibleTasks,
      initialBoundaryBuilds: successfulInitial.length,
      postStartRebuildTasks: rebuildTasks.size,
      totalPostStartRebuilds: successfulRebuilds.length,
      failedBoundaryBuilds: transitions.filter((transition) => transition.success !== 1).length,
      rebuildRate: eligibleTasks === 0 ? 0 : rebuildTasks.size / eligibleTasks,
      rebuildLatencyP50Ms: percentile(latencies, 0.5),
      rebuildLatencyP95Ms: percentile(latencies, 0.95),
    };
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
