import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";

export interface ProcessWatchdogDiagnostic {
  status: "terminated";
  reason: "event_loop_stalled";
  pid: number;
  detectedAt: string;
  stallMs: number;
}

export interface ProcessWatchdog {
  stop(): Promise<void>;
}

export interface ProcessWatchdogOptions {
  diagnosticFile: string;
  checkIntervalMs?: number;
  stallTimeoutMs?: number;
  terminateGraceMs?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;

export type WatchdogObservation = "progress" | "waiting" | "worker_suspended" | "main_stalled";

export function classifyWatchdogObservation(input: {
  counterChanged: boolean;
  elapsedSinceCheckMs: number;
  elapsedSinceProgressMs: number;
  checkIntervalMs: number;
  stallTimeoutMs: number;
}): WatchdogObservation {
  if (input.counterChanged) return "progress";
  // Laptop sleep and VM suspension pause both the main thread and this worker. If the worker's
  // own timer overshot the entire stall budget, reset the observation window on wake instead of
  // blaming the main event loop. A real main-thread spin leaves this worker ticking normally.
  if (input.elapsedSinceCheckMs >= Math.max(input.stallTimeoutMs, input.checkIntervalMs * 4)) {
    return "worker_suspended";
  }
  return input.elapsedSinceProgressMs >= input.stallTimeoutMs ? "main_stalled" : "waiting";
}

const WORKER_SOURCE = String.raw`
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { dirname } = require("node:path");
  const { workerData } = require("node:worker_threads");
  const classifyWatchdogObservation = (${classifyWatchdogObservation.toString()});

  const counter = new Int32Array(workerData.sharedCounter);
  let lastCounter = Atomics.load(counter, 0);
  let lastProgressAt = Date.now();
  let lastCheckAt = lastProgressAt;
  let terminating = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const currentCounter = Atomics.load(counter, 0);
    const observation = classifyWatchdogObservation({
      counterChanged: currentCounter !== lastCounter,
      elapsedSinceCheckMs: now - lastCheckAt,
      elapsedSinceProgressMs: now - lastProgressAt,
      checkIntervalMs: workerData.checkIntervalMs,
      stallTimeoutMs: workerData.stallTimeoutMs,
    });
    lastCheckAt = now;
    if (observation === "progress" || observation === "worker_suspended") {
      lastCounter = currentCounter;
      lastProgressAt = now;
      return;
    }
    const stallMs = now - lastProgressAt;
    if (terminating || observation !== "main_stalled") return;
    terminating = true;
    clearInterval(timer);

    const diagnostic = {
      status: "terminated",
      reason: "event_loop_stalled",
      pid: workerData.pid,
      detectedAt: new Date(now).toISOString(),
      stallMs,
    };
    try {
      mkdirSync(dirname(workerData.diagnosticFile), { recursive: true });
      writeFileSync(workerData.diagnosticFile, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600 });
    } catch (error) {
      process.stderr.write("[bridge-watchdog] could not persist stall diagnostic: " + String(error) + "\n");
    }
    process.stderr.write(
      "[bridge-watchdog] FATAL: main event loop made no progress for " + stallMs
        + "ms; stopping the bridge to prevent sustained CPU burn. Run ccd doctor and inspect bridge.log.\n",
    );

    try {
      process.kill(workerData.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(workerData.pid, 0);
        process.kill(workerData.pid, "SIGKILL");
      } catch {}
    }, workerData.terminateGraceMs);
  }, workerData.checkIntervalMs);
`;

export function startProcessWatchdog(options: ProcessWatchdogOptions): ProcessWatchdog {
  const checkIntervalMs = positiveInteger(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS, "check interval");
  const stallTimeoutMs = positiveInteger(options.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS, "stall timeout");
  const terminateGraceMs = positiveInteger(options.terminateGraceMs, DEFAULT_TERMINATE_GRACE_MS, "termination grace");
  if (stallTimeoutMs <= checkIntervalMs) {
    throw new Error("event-loop stall timeout must be greater than the watchdog check interval");
  }

  try {
    unlinkSync(options.diagnosticFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sharedCounter = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(sharedCounter);
  const tick = setInterval(() => Atomics.add(counter, 0, 1), checkIntervalMs);
  tick.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      sharedCounter,
      checkIntervalMs,
      stallTimeoutMs,
      terminateGraceMs,
      diagnosticFile: options.diagnosticFile,
      pid: process.pid,
    },
  });
  worker.unref();

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      await worker.terminate();
    },
  };
}

export function readProcessWatchdogDiagnostic(file: string): ProcessWatchdogDiagnostic | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ProcessWatchdogDiagnostic>;
    if (
      value.status !== "terminated"
      || value.reason !== "event_loop_stalled"
      || !Number.isSafeInteger(value.pid)
      || typeof value.detectedAt !== "string"
      || typeof value.stallMs !== "number"
    ) return undefined;
    return value as ProcessWatchdogDiagnostic;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`event-loop watchdog ${label} must be a positive integer`);
  }
  return selected;
}
