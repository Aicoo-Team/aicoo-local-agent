import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWatchdogObservation,
  readProcessWatchdogDiagnostic,
  startProcessWatchdog,
} from "../../src/bridge/process-watchdog.js";

const FIXTURE = resolve("test/helpers/stalled-bridge-process.mjs");

describe("bridge process watchdog", () => {
  it("distinguishes whole-process suspension from a stalled main loop", () => {
    expect(classifyWatchdogObservation({
      counterChanged: false,
      elapsedSinceCheckMs: 250,
      elapsedSinceProgressMs: 250,
      checkIntervalMs: 20,
      stallTimeoutMs: 100,
    })).toBe("worker_suspended");
    expect(classifyWatchdogObservation({
      counterChanged: false,
      elapsedSinceCheckMs: 20,
      elapsedSinceProgressMs: 100,
      checkIntervalMs: 20,
      stallTimeoutMs: 100,
    })).toBe("main_stalled");
  });

  it("terminates a bridge whose main event loop stops making progress", async () => {
    // Regression: an in-process heartbeat watchdog froze with the bridge, allowing the daemon
    // to consume CPU for days while its endpoint remained silently offline.
    const directory = mkdtempSync(join(tmpdir(), "ccd-process-watchdog-"));
    const diagnosticFile = join(directory, "watchdog.json");
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, diagnosticFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("watchdog did not terminate the stalled bridge"));
      }, 3_000);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });

    expect(result.code === 0 && result.signal === null).toBe(false);
    expect(existsSync(diagnosticFile)).toBe(true);
    expect(JSON.parse(readFileSync(diagnosticFile, "utf8"))).toMatchObject({
      status: "terminated",
      reason: "event_loop_stalled",
    });
    expect(readProcessWatchdogDiagnostic(diagnosticFile)).toMatchObject({
      status: "terminated",
      reason: "event_loop_stalled",
    });
  }, 5_000);

  it("stops cleanly without leaving a false stall diagnostic", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-process-watchdog-stop-"));
    const diagnosticFile = join(directory, "watchdog.json");
    const watchdog = startProcessWatchdog({
      diagnosticFile,
      checkIntervalMs: 20,
      stallTimeoutMs: 100,
      terminateGraceMs: 50,
    });

    await watchdog.stop();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));

    expect(existsSync(diagnosticFile)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not treat laptop suspend as an event-loop stall", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-process-watchdog-suspend-"));
    const diagnosticFile = join(directory, "watchdog.json");
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, diagnosticFile, "suspend-safe"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolveReady, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolveReady());
    });
    child.kill("SIGSTOP");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    child.kill("SIGCONT");

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("suspend-safe fixture did not exit"));
      }, 3_000);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(existsSync(diagnosticFile)).toBe(false);
  }, 5_000);
});
