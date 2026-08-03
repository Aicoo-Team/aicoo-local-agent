import { execFile } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const MCP_SERVER_NAME = "aicoo";
export const RUN_COMMAND_TOOL = `mcp__${MCP_SERVER_NAME}__run_command`;

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 20_000;
// execFile throws ENOBUFS rather than truncating when output exceeds maxBuffer, so keep
// the buffer well above the limit we actually enforce and do the truncation ourselves.
const MAX_BUFFER = 4 * 1024 * 1024;

/** Our own secrets, removed. Everything else the command may legitimately need. */
export function childEnv(source = process.env) {
  const { AICOO_TOKEN, ...rest } = source;
  return rest;
}

function clip(text) {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n…[truncated at ${OUTPUT_LIMIT} characters]`;
}

/**
 * Run one declared command. No shell, ever: argv comes from the owner's policy as an
 * array, so there is no string for `&&`, a pipe or `$(…)` to live in. The peer chooses
 * a name from an enum and nothing else — the name is the entire input surface.
 */
export function runDeclaredCommand(entry, { cwd, log }) {
  const [file, ...args] = entry.argv;
  const timeout = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      file,
      args,
      {
        cwd,
        timeout,
        // SIGTERM is ignorable and a wedged child would hold the turn open; escalate.
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        // A declared command has no business seeing our credentials. Inheriting the whole
        // environment hands the owner's Aicoo key to anything that prints its env on failure
        // — plenty of tools do — and from there it is one model quote away from the peer.
        env: childEnv(),
      },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - startedAt;
        const output = clip([stdout, stderr].filter(Boolean).join("").trimEnd());
        if (error && error.killed) {
          log?.(`[command] ${entry.name} timed out after ${timeout}ms`);
          return resolve({ ok: false, status: "timeout", output, elapsedMs, timeout });
        }
        if (error && error.code === "ENOENT") {
          log?.(`[command] ${entry.name}: ${file} not found on PATH`);
          return resolve({ ok: false, status: "not_found", output: `${file}: not found`, elapsedMs });
        }
        const exitCode = error?.code ?? 0;
        log?.(`[command] ${entry.name} exited ${exitCode} in ${elapsedMs}ms`);
        resolve({ ok: !error, status: error ? "failed" : "ok", exitCode, output, elapsedMs });
      },
    );
  });
}

function formatResult(entry, result) {
  const head = `$ ${entry.argv.join(" ")}`;
  if (result.status === "timeout") {
    return `${head}\n\n[timed out after ${result.timeout}ms — killed]\n${result.output}`;
  }
  if (result.status === "not_found") {
    return `${head}\n\n[not run] ${result.output}`;
  }
  const status = result.ok ? "exit 0" : `exit ${result.exitCode}`;
  return `${head}\n\n[${status} in ${result.elapsedMs}ms]\n${result.output || "(no output)"}`;
}

/**
 * An in-process MCP server exposing exactly one tool whose only argument is an enum of
 * the owner's declared command names. The model never composes a command string; it
 * picks a name, and the PreToolUse gate sees `mcp__aicoo__run_command` like any other
 * tool call and asks the owner before this handler runs.
 */
export function createCommandServer({ policy, cwd, log, onRan }) {
  const names = policy.commandNames;
  if (!names.length) return null;

  const runCommand = tool(
    "run_command",
    `Run one of the commands the owner declared on this machine. Available: ${names
      .map((n) => {
        const entry = policy.command(n);
        return entry.describe ? `${n} (${entry.describe})` : n;
      })
      .join(", ")}. You cannot run anything else, and the owner approves each run.`,
    { name: z.enum(names) },
    async (args) => {
      const entry = policy.command(args.name);
      if (!entry) {
        // Unreachable through the enum, but the gate is the boundary, not the schema.
        return { content: [{ type: "text", text: `No command named "${args.name}" is declared.` }], isError: true };
      }
      const result = await runDeclaredCommand(entry, { cwd, log });
      onRan?.(entry, result);
      return { content: [{ type: "text", text: formatResult(entry, result) }] };
    },
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    instructions: "Commands the owner of this machine declared. Invoke by name; nothing else can be run.",
    tools: [runCommand],
  });
}
