import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Event-loop delay instrumentation, for telling a slow server apart from a blocked client.
 *
 * A request that aborts at its cap looks identical in both cases: elapsed time reads ~= the
 * cap whether the server took that long to answer or this process was too busy to notice the
 * answer arriving. Bridge.runHeartbeat already documents the second case — creating a managed
 * session can stall the loop for tens of seconds while the endpoint itself answers in under a
 * second — so elapsed alone will point at the network every time and be wrong half of it.
 *
 * The discriminator is how late the abort timer itself fired. setTimeout(fn, 5000) that runs
 * 5900ms in means the loop was blocked ~900ms; the request may never have been slow at all.
 */
let histogram: IntervalHistogram | undefined;

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
}

/** Worst event-loop delay since process start, in ms. NaN when monitoring never started. */
export function eventLoopMaxMs(): number {
  if (!histogram) return Number.NaN;
  return histogram.max / 1e6; // the histogram reports nanoseconds
}

/**
 * Human-readable timing verdict for a timed-out request. `overshootMs` is the per-request
 * signal and is exact; the histogram max is process-wide context.
 */
export function describeTimeoutTiming(firedAfterMs: number, timeoutMs: number): string {
  const overshoot = Math.max(0, firedAfterMs - timeoutMs);
  const loopMax = eventLoopMaxMs();
  const parts = [`timer fired ${firedAfterMs.toFixed(0)}ms in`];
  parts.push(
    overshoot >= 250
      ? `LOOP BLOCKED ~${overshoot.toFixed(0)}ms (the request may not have been slow)`
      : `overshoot ${overshoot.toFixed(0)}ms (loop healthy, server or network was genuinely slow)`,
  );
  if (!Number.isNaN(loopMax)) parts.push(`worst loop delay so far ${loopMax.toFixed(0)}ms`);
  return parts.join("; ");
}
