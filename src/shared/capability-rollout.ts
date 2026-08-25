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
