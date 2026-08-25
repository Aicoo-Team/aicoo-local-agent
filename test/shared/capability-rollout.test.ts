import { describe, expect, it } from "vitest";
import type { BoundaryMetricsSnapshot } from "../../src/adapters/boundary-telemetry.js";
import {
  evaluateCapabilityRollout,
  resolveCapabilitySurface,
} from "../../src/shared/capability-rollout.js";

function metrics(overrides: Partial<BoundaryMetricsSnapshot> = {}): BoundaryMetricsSnapshot {
  return {
    eligibleTasks: 100,
    initialBoundaryBuilds: 90,
    postStartRebuildTasks: 5,
    totalPostStartRebuilds: 5,
    postStartRebuildAttempts: 5,
    failedPostStartRebuilds: 0,
    failedBoundaryBuilds: 0,
    rebuildRate: 0.05,
    rebuildFailureRate: 0,
    rebuildLatencyP50Ms: 400,
    rebuildLatencyP95Ms: 1_200,
    rebuildsByCause: {
      initial: 0,
      sender_change: 0,
      device_change: 0,
      boundary_change: 0,
      approval_boundary_expansion: 5,
    },
    failuresByCode: {},
    ...overrides,
  };
}

describe("full capability rollout gate", () => {
  it("opens only after enough low-rebuild, low-failure evidence", () => {
    expect(evaluateCapabilityRollout(metrics())).toMatchObject({ eligible: true, reasons: [] });
  });

  it("stays closed for insufficient evidence or unhealthy rebuild behavior", () => {
    expect(evaluateCapabilityRollout(metrics({ eligibleTasks: 3 }))).toMatchObject({
      eligible: false,
      reasons: ["insufficient_sample"],
    });
    expect(evaluateCapabilityRollout(metrics({
      rebuildRate: 0.25,
      rebuildFailureRate: 0.2,
      rebuildLatencyP95Ms: 8_000,
    }))).toMatchObject({
      eligible: false,
      reasons: ["rebuild_rate_too_high", "rebuild_failure_rate_too_high", "rebuild_latency_too_high"],
    });
  });

  it("requires explicit owner activation as well as healthy evidence", () => {
    expect(resolveCapabilitySurface("restricted", metrics())).toEqual({
      requested: "restricted",
      active: "restricted",
      rollout: expect.objectContaining({ eligible: true }),
    });
    expect(resolveCapabilitySurface("full-agent", metrics())).toEqual({
      requested: "full-agent",
      active: "full-agent",
      rollout: expect.objectContaining({ eligible: true }),
    });
    expect(() => resolveCapabilitySurface("full-agent", metrics({ eligibleTasks: 3 })))
      .toThrow(/insufficient_sample/u);
  });
});
