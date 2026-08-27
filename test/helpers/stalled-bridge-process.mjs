import { startProcessWatchdog } from "../../src/bridge/process-watchdog.ts";

const diagnosticFile = process.argv[2];
const mode = process.argv[3] ?? "stall";
if (!diagnosticFile) throw new Error("diagnostic file is required");

// Model a bridge whose signal handler cannot run because its main event loop is starved.
process.on("SIGTERM", () => undefined);
startProcessWatchdog({
  diagnosticFile,
  checkIntervalMs: 20,
  stallTimeoutMs: 100,
  terminateGraceMs: 50,
});
process.stdout.write("watchdog-ready\n");

if (mode === "suspend-safe") {
  setTimeout(() => process.exit(0), 500);
  await new Promise(() => undefined);
}

const blockedUntil = Date.now() + 10_000;
while (Date.now() < blockedUntil) {
  // Deliberately starve the main event loop. The watchdog runs in another worker thread.
}
