import { describe, expect, it } from "vitest";
import type { BoundaryMetricsSnapshot } from "../../src/adapters/boundary-telemetry.js";
import {
  describeCapabilityDegradation,
  evaluateCapabilitySecurity,
  evaluateCapabilityRollout,
  isLoopbackControlPlane,
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
  it("waives sample count only for literal loopback control planes", () => {
    expect(isLoopbackControlPlane("http://localhost:3000")).toBe(true);
    expect(isLoopbackControlPlane("http://127.0.0.1:7790")).toBe(true);
    expect(isLoopbackControlPlane("http://[::1]:3000")).toBe(true);
    expect(isLoopbackControlPlane("https://www.aicoo.io")).toBe(false);
    expect(isLoopbackControlPlane("https://localhost.example.com")).toBe(false);
    expect(isLoopbackControlPlane("not-a-url")).toBe(false);
  });

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

  it("allows a zero-sample localhost threshold without waiving health failures", () => {
    const localThresholds = {
      minimumEligibleTasks: 0,
      maximumRebuildRate: 0.1,
      maximumRebuildFailureRate: 0.01,
      maximumRebuildP95Ms: 3_000,
    };
    expect(evaluateCapabilityRollout(metrics({ eligibleTasks: 0 }), localThresholds)).toMatchObject({
      eligible: true,
      reasons: [],
    });
    expect(evaluateCapabilityRollout(metrics({
      eligibleTasks: 0,
      rebuildFailureRate: 0.5,
    }), localThresholds)).toMatchObject({
      eligible: false,
      reasons: ["rebuild_failure_rate_too_high"],
    });
  });

  it("requires explicit owner activation as well as healthy evidence", () => {
    const security = {
      runtime: "codex" as const,
      ownerApprovalGateway: true,
      codexAppServer: true,
    };
    expect(resolveCapabilitySurface("restricted", metrics(), security)).toEqual({
      requested: "restricted",
      active: "restricted",
      rollout: expect.objectContaining({ eligible: true }),
      security: expect.objectContaining({ eligible: true }),
    });
    expect(resolveCapabilitySurface("full-agent", metrics(), security)).toEqual({
      requested: "full-agent",
      active: "full-agent",
      rollout: expect.objectContaining({ eligible: true }),
      security: expect.objectContaining({ eligible: true }),
    });
  });

  it("degrades to restricted instead of refusing to start when evidence is short", () => {
    const security = {
      runtime: "codex" as const,
      ownerApprovalGateway: true,
      codexAppServer: true,
    };
    // The first run of a hosted bridge is exactly this case: zero eligible tasks against a
    // 20-task threshold. Refusing here made `ccd onboard --capability-surface full-agent` fail
    // for every new owner, and because the bridge is launched detached the reason never reached
    // them — they saw a readiness timeout instead.
    const activation = resolveCapabilitySurface("full-agent", metrics({ eligibleTasks: 0 }), security);
    expect(activation).toMatchObject({ requested: "full-agent", active: "restricted" });
    expect(activation.rollout.reasons).toEqual(["insufficient_sample"]);
    expect(describeCapabilityDegradation(activation)).toContain("20 more");

    const unhealthy = resolveCapabilitySurface("full-agent", metrics({ rebuildFailureRate: 0.5 }), security);
    expect(unhealthy.active).toBe("restricted");
    expect(describeCapabilityDegradation(unhealthy)).toContain("rebuild_failure_rate_too_high");

    // A surface that came up as asked has nothing to explain.
    expect(describeCapabilityDegradation(
      resolveCapabilitySurface("full-agent", metrics(), security),
    )).toBeUndefined();
  });

  it("still refuses to start when full-agent could not be operated safely", () => {
    // A missing approval gateway has no narrower-but-honest fallback: the owner asked for a
    // surface whose whole safety story is being asked. That must stay a hard failure.
    expect(() => resolveCapabilitySurface("full-agent", metrics(), {
      runtime: "codex",
      ownerApprovalGateway: false,
      codexAppServer: true,
    })).toThrow(/owner_approval_unavailable/u);
    // Security failures are not silently downgraded by short evidence either.
    expect(() => resolveCapabilitySurface("full-agent", metrics({ eligibleTasks: 0 }), {
      runtime: "fake",
      ownerApprovalGateway: true,
    })).toThrow(/kernel_boundary_unavailable/u);
  });

  it("keeps the full surface closed until the runtime has an enforceable approval gate", () => {
    expect(evaluateCapabilitySecurity({
      runtime: "codex",
      ownerApprovalGateway: false,
      codexAppServer: false,
    })).toMatchObject({
      eligible: false,
      reasons: ["owner_approval_unavailable", "interactive_approval_unavailable"],
    });
    expect(evaluateCapabilitySecurity({
      runtime: "fake",
      ownerApprovalGateway: true,
      codexAppServer: true,
    })).toMatchObject({
      eligible: false,
      reasons: [
        "kernel_boundary_unavailable",
        "command_hardening_unavailable",
        "execution_timeout_unavailable",
        "credential_isolation_unavailable",
        "output_redaction_unavailable",
      ],
    });
    expect(evaluateCapabilitySecurity({
      runtime: "claude-code",
      ownerApprovalGateway: true,
    })).toMatchObject({
      eligible: true,
      reasons: [],
      controls: {
        kernelBoundary: true,
        ownerApproval: true,
        interactiveApproval: true,
        commandHardening: true,
        executionTimeout: true,
        credentialIsolation: true,
        outputRedaction: true,
      },
    });
  });

  it("reports security blockers separately from rebuild-health blockers", () => {
    expect(() => resolveCapabilitySurface("full-agent", metrics(), {
      runtime: "codex",
      ownerApprovalGateway: true,
      codexAppServer: false,
    })).toThrow(/interactive_approval_unavailable/u);
  });
});
