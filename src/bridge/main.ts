import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { makeTransport } from "../shared/aicoo-transport.js";
import { RuntimeBridge } from "./bridge.js";
import { BridgeSpool } from "./spool.js";

/**
 * Resolve a stable per-machine device identifier for Aicoo endpoint registration.
 * Precedence: explicit --device-id / CCD_DEVICE_ID, then a persisted id next to the
 * spool file, else a freshly generated `<hostname>-<uuid>` persisted for reuse.
 */
function resolveDeviceId(explicit: string | undefined, spoolFile: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const idFile = `${spoolFile}.device-id`;
  try {
    if (existsSync(idFile)) {
      const saved = readFileSync(idFile, "utf8").trim();
      if (saved) return saved;
    }
  } catch {
    /* unreadable — fall through and regenerate */
  }
  const generated = `${hostname()}-${randomUUID()}`;
  try {
    writeFileSync(idFile, generated);
  } catch {
    /* non-fatal: id is still used for this run */
  }
  return generated;
}

const program = new Command()
  .name("aicoo-local-agent-bridge")
  .requiredOption("--token <token>", "device bearer token", process.env.CCD_TOKEN)
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? "http://127.0.0.1:7790")
  .option("--spool <file>", "durable spool database", "bridge.spool")
  .option("--device-id <id>", "stable device identifier (Aicoo control plane)", process.env.CCD_DEVICE_ID)
  .addOption(new Option("--adapter <adapter>", "runtime adapter").choices(["fake", "claude-code", "codex"]).default("fake"))
  .option("--sessions <count>", "number of managed sessions", "1")
  .option("--fake-busy", "start the fake session busy", false)
  .option("--workspace <dir>", "managed-session workspace", process.cwd())
  .option("--claude-state <file>", "Claude Code managed-session state database")
  .option("--claude-path <file>", "Claude Code executable", process.env.CLAUDE_CODE_PATH)
  .option("--codex-state <file>", "Codex managed-session state database")
  .option("--codex-path <file>", "codex executable", process.env.CODEX_PATH)
  .option(
    "--relationship-policy <file>",
    "JSON allowlist of tools/folders for verified users and devices",
    process.env.CCD_RELATIONSHIP_POLICY,
  )
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL);

program.parse();
const options = program.opts<{
  token: string;
  server: string;
  spool: string;
  deviceId?: string;
  sessions: string;
  fakeBusy: boolean;
  adapter: RuntimeAdapterKind;
  workspace: string;
  claudeState?: string;
  claudePath?: string;
  codexState?: string;
  codexPath?: string;
  relationshipPolicy?: string;
  model?: string;
}>();
const selected = await selectRuntimeAdapter({
  kind: options.adapter,
  sessions: Number.parseInt(options.sessions, 10),
  fakeBusy: options.fakeBusy,
  spoolFile: options.spool,
  workspace: options.workspace,
  claudeStateFile: options.claudeState,
  claudePath: options.claudePath,
  codexStateFile: options.codexState,
  codexPath: options.codexPath,
  relationshipPolicyFile: options.relationshipPolicy,
  model: options.model,
  log: console.log,
});
const deviceId = resolveDeviceId(options.deviceId, options.spool);
console.log(`[bridge] deviceId=${deviceId}`);
const spool = new BridgeSpool(options.spool);
const bridge = new RuntimeBridge({
  transport: makeTransport({ baseUrl: options.server, token: options.token, deviceId }),
  spool,
  adapter: selected.adapter,
  adapterVersion: selected.adapterVersion,
  runtime: selected.runtime,
  log: console.log,
});
const started = await bridge.start();
console.log(JSON.stringify({ ...started, adapter: selected.label }, null, 2));

async function shutdown() {
  await bridge.stop();
  spool.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
