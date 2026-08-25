import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BoundaryTelemetry } from "../../src/adapters/boundary-telemetry.js";

describe("BoundaryTelemetry", () => {
  it("persists rebuild measurements without storing raw boundary paths", () => {
    const db = new DatabaseSync(":memory:");
    const telemetry = new BoundaryTelemetry(db);
    const rawBoundary = JSON.stringify({ folders: ["/Users/owner/private-project"] });
    telemetry.recordEligibleTask({
      messageId: "msg-1",
      localHandle: "claude-managed-1",
      correlationId: "corr-1",
    });
    telemetry.recordTransition({
      transitionId: "continuation:cont-1",
      messageId: "msg-1",
      kind: "post_start_rebuild",
      cause: "boundary_change",
      boundaryKey: rawBoundary,
      success: true,
      latencyMs: 125,
    });
    telemetry.recordTransition({
      transitionId: "continuation:cont-1",
      messageId: "msg-1",
      kind: "post_start_rebuild",
      cause: "boundary_change",
      boundaryKey: rawBoundary,
      success: true,
      latencyMs: 999,
    });

    expect(telemetry.snapshot()).toEqual({
      eligibleTasks: 1,
      initialBoundaryBuilds: 0,
      postStartRebuildTasks: 1,
      totalPostStartRebuilds: 1,
      postStartRebuildAttempts: 1,
      failedPostStartRebuilds: 0,
      failedBoundaryBuilds: 0,
      rebuildRate: 1,
      rebuildFailureRate: 0,
      rebuildLatencyP50Ms: 125,
      rebuildLatencyP95Ms: 125,
      rebuildsByCause: {
        initial: 0,
        sender_change: 0,
        device_change: 0,
        boundary_change: 1,
        approval_boundary_expansion: 0,
      },
      failuresByCode: {},
    });
    const stored = db.prepare(
      "SELECT boundary_key FROM boundary_metric_transitions",
    ).get() as { boundary_key: string };
    expect(stored.boundary_key).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.boundary_key).not.toContain("private-project");
    expect(new BoundaryTelemetry(db).snapshot()).toMatchObject({ totalPostStartRebuilds: 1 });
    db.close();
  });

  it("counts failed continuation rebuilds by safe error code", () => {
    const db = new DatabaseSync(":memory:");
    const telemetry = new BoundaryTelemetry(db);
    telemetry.recordEligibleTask({ messageId: "msg-2", localHandle: "codex-1", correlationId: "corr-2" });
    telemetry.recordTransition({
      transitionId: "continuation:cont-2",
      messageId: "msg-2",
      kind: "post_start_rebuild",
      cause: "approval_boundary_expansion",
      boundaryKey: "manifest-hash",
      success: false,
      latencyMs: 50,
      failureCode: "session_launch_failed",
    });

    expect(telemetry.snapshot()).toMatchObject({
      postStartRebuildTasks: 1,
      postStartRebuildAttempts: 1,
      failedPostStartRebuilds: 1,
      rebuildRate: 1,
      rebuildFailureRate: 1,
      rebuildLatencyP95Ms: 50,
      rebuildsByCause: { approval_boundary_expansion: 1 },
      failuresByCode: { session_launch_failed: 1 },
    });
    db.close();
  });
});
