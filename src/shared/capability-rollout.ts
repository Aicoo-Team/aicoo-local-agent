import type { BoundaryMetricsSnapshot } from "../adapters/boundary-telemetry.js";

export interface CapabilityRolloutThresholds {
  minimumEligibleTasks: number;
  maximumRebuildRate: number;
  maximumRebuildFailureRate: number;
  maximumRebuildP95Ms: number;
}

export const DEFAULT_CAPABILITY_ROLLOUT_THRESHOLDS: CapabilityRolloutThresholds = {
  minimumEligibleTasks: 20,
  maximumRebuildRate: 0.1,
  maximumRebuildFailureRate: 0.01,
  maximumRebuildP95Ms: 3_000,
};

export type CapabilityRolloutBlocker =
  | "insufficient_sample"
  | "rebuild_rate_too_high"
  | "rebuild_failure_rate_too_high"
  | "rebuild_latency_too_high";

export interface CapabilityRolloutDecision {
  eligible: boolean;
  reasons: CapabilityRolloutBlocker[];
  thresholds: CapabilityRolloutThresholds;
  metrics: BoundaryMetricsSnapshot;
}

export type CapabilitySurface = "restricted" | "full-agent";

export type CapabilitySecurityBlocker =
  | "kernel_boundary_unavailable"
  | "owner_approval_unavailable"
  | "interactive_approval_unavailable"
  | "command_hardening_unavailable"
  | "execution_timeout_unavailable"
  | "credential_isolation_unavailable"
  | "output_redaction_unavailable";

export interface CapabilitySecurityContext {
  runtime: "fake" | "claude-code" | "codex";
  ownerApprovalGateway: boolean;
  codexAppServer?: boolean;
}

export interface CapabilitySecurityDecision {
  eligible: boolean;
  reasons: CapabilitySecurityBlocker[];
  controls: {
    kernelBoundary: boolean;
    ownerApproval: boolean;
    interactiveApproval: boolean;
    commandHardening: boolean;
    executionTimeout: boolean;
    credentialIsolation: boolean;
    outputRedaction: boolean;
  };
}

export interface CapabilitySurfaceActivation {
  requested: CapabilitySurface;
  active: CapabilitySurface;
  rollout: CapabilityRolloutDecision;
  security: CapabilitySecurityDecision;
}

/** Fail-closed evidence gate for enabling the wider C2C capability surface. */
export function evaluateCapabilityRollout(
  metrics: BoundaryMetricsSnapshot,
  thresholds: CapabilityRolloutThresholds = DEFAULT_CAPABILITY_ROLLOUT_THRESHOLDS,
): CapabilityRolloutDecision {
  const reasons: CapabilityRolloutBlocker[] = [];
  if (metrics.eligibleTasks < thresholds.minimumEligibleTasks) reasons.push("insufficient_sample");
  if (metrics.rebuildRate > thresholds.maximumRebuildRate) reasons.push("rebuild_rate_too_high");
  if (metrics.rebuildFailureRate > thresholds.maximumRebuildFailureRate) {
    reasons.push("rebuild_failure_rate_too_high");
  }
  if (
    metrics.rebuildLatencyP95Ms !== null
    && metrics.rebuildLatencyP95Ms > thresholds.maximumRebuildP95Ms
  ) reasons.push("rebuild_latency_too_high");
  return { eligible: reasons.length === 0, reasons, thresholds, metrics };
}

/** Runtime checks that must be true before the wider surface is even constructed. */
export function evaluateCapabilitySecurity(
  context: CapabilitySecurityContext,
): CapabilitySecurityDecision {
  const controls = {
    kernelBoundary: context.runtime !== "fake",
    ownerApproval: context.ownerApprovalGateway,
    interactiveApproval: context.runtime !== "codex" || context.codexAppServer === true,
    commandHardening: context.runtime !== "fake",
    executionTimeout: context.runtime !== "fake",
    credentialIsolation: context.runtime !== "fake",
    outputRedaction: context.runtime !== "fake",
  };
  const reasons: CapabilitySecurityBlocker[] = [];
  if (!controls.kernelBoundary) reasons.push("kernel_boundary_unavailable");
  if (!controls.ownerApproval) reasons.push("owner_approval_unavailable");
  if (!controls.interactiveApproval) reasons.push("interactive_approval_unavailable");
  if (!controls.commandHardening) reasons.push("command_hardening_unavailable");
  if (!controls.executionTimeout) reasons.push("execution_timeout_unavailable");
  if (!controls.credentialIsolation) reasons.push("credential_isolation_unavailable");
  if (!controls.outputRedaction) reasons.push("output_redaction_unavailable");
  return { eligible: reasons.length === 0, reasons, controls };
}

/** An explicit owner request cannot bypass unhealthy or insufficient local evidence. */
export function resolveCapabilitySurface(
  requested: CapabilitySurface,
  metrics: BoundaryMetricsSnapshot,
  securityContext: CapabilitySecurityContext,
): CapabilitySurfaceActivation {
  const rollout = evaluateCapabilityRollout(metrics);
  const security = evaluateCapabilitySecurity(securityContext);
  if (requested === "full-agent" && (!rollout.eligible || !security.eligible)) {
    throw new Error(
      `full-agent capability is not ready: ${[...rollout.reasons, ...security.reasons].join(", ")}`,
    );
  }
  return { requested, active: requested, rollout, security };
}
