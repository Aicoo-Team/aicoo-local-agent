import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { HttpMessageTransport } from "../shared/http-client.js";
import { RuntimeBridge } from "./bridge.js";
import { BridgeSpool } from "./spool.js";

const program = new Command()
  .name("aicoo-local-agent-bridge")
  .requiredOption("--token <token>", "device bearer token", process.env.CCD_TOKEN)
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? "http://127.0.0.1:7790")
  .option("--spool <file>", "durable spool database", "bridge.spool")
  .addOption(new Option("--adapter <adapter>", "runtime adapter").choices(["fake", "claude-code", "codex"]).default("fake"))
  .option("--sessions <count>", "number of managed sessions", "1")
  .option("--fake-busy", "start the fake session busy", false)
  .option("--workspace <dir>", "managed-session workspace", process.cwd())
  .option("--claude-state <file>", "Claude Code managed-session state database")
  .option("--claude-path <file>", "Claude Code executable", process.env.CLAUDE_CODE_PATH)
  .option("--codex-state <file>", "Codex managed-session state database")
  .option("--codex-path <file>", "codex executable", process.env.CODEX_PATH)
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL);

program.parse();
const options = program.opts<{
  token: string;
  server: string;
  spool: string;
  sessions: string;
  fakeBusy: boolean;
  adapter: RuntimeAdapterKind;
  workspace: string;
  claudeState?: string;
  claudePath?: string;
  codexState?: string;
  codexPath?: string;
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
  model: options.model,
  log: console.log,
});
const spool = new BridgeSpool(options.spool);
const bridge = new RuntimeBridge({
  transport: new HttpMessageTransport({ baseUrl: options.server, token: options.token }),
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
