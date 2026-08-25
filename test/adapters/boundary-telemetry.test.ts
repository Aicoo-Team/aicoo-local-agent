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
      messageId: "msg-1",
      kind: "post_start_rebuild",
      cause: "boundary_change",
      boundaryKey: rawBoundary,
      success: true,
      latencyMs: 125,
    });

    expect(telemetry.snapshot()).toEqual({
      eligibleTasks: 1,
      initialBoundaryBuilds: 0,
      postStartRebuildTasks: 1,
      totalPostStartRebuilds: 1,
      failedBoundaryBuilds: 0,
      rebuildRate: 1,
      rebuildLatencyP50Ms: 125,
      rebuildLatencyP95Ms: 125,
    });
    const stored = db.prepare(
      "SELECT boundary_key FROM boundary_metric_transitions",
    ).get() as { boundary_key: string };
    expect(stored.boundary_key).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.boundary_key).not.toContain("private-project");
    expect(new BoundaryTelemetry(db).snapshot()).toMatchObject({ totalPostStartRebuilds: 1 });
    db.close();
  });
});
