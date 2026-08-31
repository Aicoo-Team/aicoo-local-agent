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

/** Only a control plane bound to this machine may skip the production sample-count gate. */
export function isLoopbackControlPlane(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]";
  } catch {
    return false;
  }
}

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

/**
 * Resolve the surface a bridge may actually run, given what the owner asked for.
 *
 * The two gates fail differently, because they answer different questions.
 *
 * `evaluateCapabilitySecurity` asks whether full-agent can be *operated* at all: is there an
 * owner to approve tool calls, is the runtime real, can Codex be interrupted mid-turn. A "no"
 * there has no safe fallback that still honours the request, so it throws and the bridge
 * refuses to start.
 *
 * `evaluateCapabilityRollout` asks a quality question: has this machine shown that boundary
 * rebuilding is rare, reliable and fast? A "no" there — and `insufficient_sample`, meaning the
 * machine has not shown anything yet, is the answer every new bridge gives — is not a reason to
 * refuse to start. It is a reason to come up on the narrower surface. Throwing made the first
 * ever run of `--capability-surface full-agent` fail against a hosted control plane, and because
 * `ccd onboard` launches the bridge detached, the reason only ever reached a log file while the
 * owner watched a bidirectional-readiness timeout.
 *
 * So a rollout blocker degrades instead. `active` is the surface the caller must use; the wider
 * capability set is simply never advertised while it is `restricted`, which is the same posture
 * the owner would have had by asking for `restricted` in the first place. Evidence accrues from
 * ordinary folder-scoped tasks, so a later restart activates full-agent without the owner having
 * to know this gate exists.
 */
export function resolveCapabilitySurface(
  requested: CapabilitySurface,
  metrics: BoundaryMetricsSnapshot,
  securityContext: CapabilitySecurityContext,
  thresholds: CapabilityRolloutThresholds = DEFAULT_CAPABILITY_ROLLOUT_THRESHOLDS,
): CapabilitySurfaceActivation {
  const rollout = evaluateCapabilityRollout(metrics, thresholds);
  const security = evaluateCapabilitySecurity(securityContext);
  if (requested !== "full-agent") return { requested, active: requested, rollout, security };
  if (!security.eligible) {
    throw new Error(`full-agent capability is not ready: ${security.reasons.join(", ")}`);
  }
  return { requested, active: rollout.eligible ? "full-agent" : "restricted", rollout, security };
}

/** Owner-facing explanation of a surface that came up narrower than it was asked to. */
export function describeCapabilityDegradation(
  activation: CapabilitySurfaceActivation,
): string | undefined {
  if (activation.active === activation.requested) return undefined;
  const { rollout } = activation;
  const detail = rollout.reasons.includes("insufficient_sample")
    ? `${Math.max(rollout.thresholds.minimumEligibleTasks - rollout.metrics.eligibleTasks, 0)} more `
      + "folder-scoped collaboration tasks are needed before it activates"
    : `local boundary-rebuild health is outside its limits (${rollout.reasons.join(", ")})`;
  return `Full agent is not active yet, so this bridge is running on the restricted surface: ${detail}. `
    + "Everything else works; restart the bridge once the gate clears.";
}
