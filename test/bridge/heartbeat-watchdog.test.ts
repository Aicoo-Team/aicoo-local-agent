import { describe, expect, it, vi } from "vitest";
import { bridgeHealthIsFresh, HeartbeatWatchdog } from "../../src/bridge/health.js";

describe("bridge heartbeat watchdog", () => {
  it("becomes unhealthy after repeated failures and backs off", () => {
    // Regression: a bridge could fail every heartbeat for days while continuing at its normal
    // retry cadence and exposing no durable local health signal.
    const persist = vi.fn();
    const watchdog = new HeartbeatWatchdog({
      heartbeatMs: 10_000,
      maxBackoffMs: 60_000,
      failureThreshold: 3,
      persist,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });

    expect(watchdog.recordFailure(new Error("timeout"), 0)).toMatchObject({
      status: "degraded",
      consecutiveHeartbeatFailures: 1,
      nextHeartbeatInMs: 10_000,
    });
    expect(watchdog.recordFailure(new Error("timeout"), 0)).toMatchObject({
      status: "degraded",
      consecutiveHeartbeatFailures: 2,
      nextHeartbeatInMs: 20_000,
    });
    expect(watchdog.recordFailure(new Error("timeout"), 920_000)).toMatchObject({
      status: "unhealthy",
      consecutiveHeartbeatFailures: 3,
      eventLoopLagMs: 920_000,
      nextHeartbeatInMs: 40_000,
    });
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ status: "unhealthy" }));
  });

  it("returns to healthy after a successful heartbeat", () => {
    const watchdog = new HeartbeatWatchdog({
      heartbeatMs: 10_000,
      maxBackoffMs: 60_000,
      failureThreshold: 2,
      persist: vi.fn(),
    });
    watchdog.recordFailure(new Error("timeout"), 5_000);

    expect(watchdog.recordSuccess(12)).toMatchObject({
      status: "healthy",
      consecutiveHeartbeatFailures: 0,
      eventLoopLagMs: 12,
      nextHeartbeatInMs: 10_000,
    });
  });

  it("lets an external doctor detect a bridge whose event loop stopped updating health", () => {
    const watchdog = new HeartbeatWatchdog({
      heartbeatMs: 10_000,
      maxBackoffMs: 60_000,
      failureThreshold: 3,
      persist: vi.fn(),
      now: () => new Date("2026-08-26T10:00:00.000Z"),
    });
    const healthy = watchdog.recordSuccess(0);

    expect(bridgeHealthIsFresh(healthy, Date.parse("2026-08-26T10:00:30.000Z"))).toBe(true);
    expect(bridgeHealthIsFresh(healthy, Date.parse("2026-08-26T10:02:00.000Z"))).toBe(false);
  });
});
