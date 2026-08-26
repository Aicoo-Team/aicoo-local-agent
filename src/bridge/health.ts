export type BridgeHealthStatus = "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";

export interface BridgeHealthState {
  status: BridgeHealthStatus;
  consecutiveHeartbeatFailures: number;
  nextHeartbeatInMs: number;
  eventLoopLagMs: number;
  lastHeartbeatAttemptAt?: string;
  lastHeartbeatSuccessAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface HeartbeatWatchdogOptions {
  heartbeatMs: number;
  maxBackoffMs: number;
  failureThreshold: number;
  persist: (state: BridgeHealthState) => void;
  now?: () => Date;
}

export class HeartbeatWatchdog {
  readonly #now: () => Date;
  #state: BridgeHealthState;

  constructor(private readonly options: HeartbeatWatchdogOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error("heartbeat failure threshold must be a positive integer");
    }
    this.#now = options.now ?? (() => new Date());
    this.#state = {
      status: "starting",
      consecutiveHeartbeatFailures: 0,
      nextHeartbeatInMs: options.heartbeatMs,
      eventLoopLagMs: 0,
      updatedAt: this.#now().toISOString(),
    };
    this.persist();
  }

  get state(): BridgeHealthState {
    return { ...this.#state };
  }

  recordSuccess(eventLoopLagMs: number): BridgeHealthState {
    const now = this.#now().toISOString();
    this.#state = {
      status: eventLoopLagMs >= this.options.heartbeatMs ? "degraded" : "healthy",
      consecutiveHeartbeatFailures: 0,
      nextHeartbeatInMs: this.options.heartbeatMs,
      eventLoopLagMs,
      lastHeartbeatAttemptAt: now,
      lastHeartbeatSuccessAt: now,
      updatedAt: now,
    };
    return this.persist();
  }

  recordFailure(error: unknown, eventLoopLagMs: number): BridgeHealthState {
    const now = this.#now().toISOString();
    const failures = this.#state.consecutiveHeartbeatFailures + 1;
    const exponent = Math.max(0, failures - 1);
    this.#state = {
      status: failures >= this.options.failureThreshold ? "unhealthy" : "degraded",
      consecutiveHeartbeatFailures: failures,
      nextHeartbeatInMs: Math.min(
        this.options.maxBackoffMs,
        this.options.heartbeatMs * (2 ** exponent),
      ),
      eventLoopLagMs,
      lastHeartbeatAttemptAt: now,
      ...(this.#state.lastHeartbeatSuccessAt
        ? { lastHeartbeatSuccessAt: this.#state.lastHeartbeatSuccessAt }
        : {}),
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now,
    };
    return this.persist();
  }

  stop(): BridgeHealthState {
    this.#state = {
      ...this.#state,
      status: "stopped",
      updatedAt: this.#now().toISOString(),
    };
    return this.persist();
  }

  private persist(): BridgeHealthState {
    const snapshot = { ...this.#state };
    this.options.persist(snapshot);
    return snapshot;
  }
}

export function parseBridgeHealth(value: string | undefined): BridgeHealthState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<BridgeHealthState>;
    if (
      !["starting", "healthy", "degraded", "unhealthy", "stopped"].includes(parsed.status ?? "")
      || !Number.isInteger(parsed.consecutiveHeartbeatFailures)
      || typeof parsed.nextHeartbeatInMs !== "number"
      || typeof parsed.eventLoopLagMs !== "number"
      || typeof parsed.updatedAt !== "string"
    ) return undefined;
    return parsed as BridgeHealthState;
  } catch {
    return undefined;
  }
}

/** A separate CLI process can detect a starved or dead bridge because its health record stops moving. */
export function bridgeHealthIsFresh(state: BridgeHealthState, nowMs = Date.now()): boolean {
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  // One heartbeat may spend roughly 20s in two bounded transport attempts. Give the daemon two
  // scheduled intervals plus that request budget before declaring its local signal stale.
  const maximumAgeMs = Math.max(40_000, (state.nextHeartbeatInMs * 2) + 20_000);
  return nowMs - updatedAt <= maximumAgeMs;
}
