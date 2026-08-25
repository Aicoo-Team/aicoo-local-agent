import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncMessageQueue } from "../claude-code/message-queue.js";
import type { PreparedCodexProfile } from "./permission-profile.js";
import type { CodexApprovalDecision, CodexApprovalRequest } from "./app-server-protocol.js";

export interface CodexThreadItem {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started"; item: CodexThreadItem }
  | { type: "item.updated"; item: CodexThreadItem }
  | { type: "item.completed"; item: CodexThreadItem }
  | { type: "turn.completed"; usage?: Record<string, unknown> }
  | { type: "turn.failed"; error?: { message?: string } }
  /**
   * `fatal` separates the two very different things that arrive as `type: "error"`.
   * Codex CLI emits recoverable ones on stdout mid-turn — notably `"Reconnecting..."` when its
   * WebSocket drops, after which it falls back to HTTPS and still produces `agent_message` and
   * `turn.completed`. Only errors this driver synthesizes (spawn failure, non-zero exit) end a turn.
   */
  | { type: "error"; message?: string; fatal?: boolean };

export interface CodexTurnStartInput {
  prompt: string;
  cwd: string;
  resumeThreadId?: string;
  writableRoots?: string[];
  /**
   * Kernel-enforced scoping for this relationship. When present it replaces the sandbox_mode
   * flags entirely: those grant root-level read (writable_roots scopes writes only), so they
   * cannot express "this folder and nothing else". See permission-profile.ts.
   */
  permissionProfile?: PreparedCodexProfile;
  codexPath?: string;
  model?: string;
  /**
   * Asked before anything the sandbox cannot already do, so the owner decides instead of the
   * caller getting a refusal for something they would have allowed. Per turn rather than per
   * driver because the answer has to be attributed to the message that provoked it.
   * Only the app-server driver can honour this; `codex exec` has no way to be interrupted.
   */
  onApproval?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  /** Hard wall-clock limit for one app-server turn, including tool execution. */
  turnTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface CodexTurn extends AsyncIterable<CodexThreadEvent> {
  close(): void;
}

export interface CodexDriver {
  startTurn(input: CodexTurnStartInput): CodexTurn;
}

export interface CodexSpawnCommand {
  command: string;
  args: string[];
}

// Verified against codex-cli 0.144.5: `codex exec --json` emits one JSON event per
// stdout line (thread.started, turn.started, item.*, turn.completed/turn.failed),
// resume re-emits thread.started with the same thread id, and a failed invocation
// exits non-zero with the reason on stderr and no JSONL.
export class CodexExecDriver implements CodexDriver {
  startTurn(input: CodexTurnStartInput): CodexTurn {
    return new CodexExecTurn(input);
  }
}

class CodexExecTurn implements CodexTurn {
  readonly #events = new AsyncMessageQueue<CodexThreadEvent>();
  readonly #child: ReturnType<typeof spawn>;
  #stderrTail = "";
  #sawTerminalEvent = false;
  #closed = false;

  constructor(input: CodexTurnStartInput) {
    const command = input.codexPath ?? "codex";
    const spawnCommand = buildCodexSpawnCommand(command, buildArgs(input));
    this.#child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.permissionProfile
        ? { ...process.env, CODEX_HOME: input.permissionProfile.codexHome }
        : process.env,
      windowsVerbatimArguments: false,
    });
    this.#child.stdin?.end(input.prompt);
    const stdout = createInterface({ input: this.#child.stdout! });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CodexThreadEvent;
      try {
        event = JSON.parse(trimmed) as CodexThreadEvent;
      } catch {
        input.log?.(`codex non-JSON output ignored: ${trimmed}`);
        return;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        this.#sawTerminalEvent = true;
      }
      if (event.type === "error") {
        // Recoverable by default: Codex reports transport hiccups this way and keeps going.
        // A turn that really dies still ends the process, and the close handler below catches that.
        input.log?.(`codex reported a recoverable error, still waiting: ${event.message ?? "(no message)"}`);
      }
      this.push(event);
    });
    this.#child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#stderrTail = (this.#stderrTail + text).slice(-2000);
      input.log?.(`codex stderr: ${text.trimEnd()}`);
    });
    this.#child.on("error", (error) => {
      this.push({ type: "error", message: `codex spawn failed: ${String(error)}`, fatal: true });
      this.#events.close();
    });
    this.#child.on("close", (code) => {
      if (!this.#closed && code !== 0 && !this.#sawTerminalEvent) {
        this.push({
          type: "error",
          message: `codex exited with code ${code}: ${this.#stderrTail.trim() || "no stderr output"}`,
          fatal: true,
        });
      }
      this.#events.close();
    });
  }

  private push(event: CodexThreadEvent): void {
    // The consumer may abandon the iterator after a terminal event; a push into a
    // closed queue must not surface as an unhandled rejection.
    this.#events.push(event).catch(() => {});
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGTERM");
    this.#events.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexThreadEvent> {
    return this.#events[Symbol.asyncIterator]();
  }
}

export function requiresWindowsShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

export function buildCodexSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CodexSpawnCommand {
  if (!requiresWindowsShell(command, platform)) return { command, args };

  // Windows cannot execute npm .cmd/.bat shims directly. Spawn cmd.exe
  // explicitly so Node still quotes every argv element instead of using
  // shell:true, which joins the command line with no argument escaping.
  return {
    command: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

export function buildArgs(input: CodexTurnStartInput): string[] {
  const writableRoots = input.writableRoots ?? [];
  // The receiver stays as close to text-only as codex allows: no user
  // config/rules/AGENTS.md ingestion and no web search. Edit grants switch to
  // workspace-write with explicit writable roots. `-` reads the prompt from
  // stdin so message content never appears in the process argument list.
  // A permission profile expresses what sandbox_mode cannot: reads scoped to the granted
  // folders. When one is supplied it is authoritative and the sandbox_mode flags are dropped,
  // since the profile already pins both read and write scope plus network.
  const profile = input.permissionProfile;
  const isolation = [
    "--json",
    "--skip-git-repo-check",
    // --ignore-user-config means "do not load $CODEX_HOME/config.toml", which is exactly where
    // the permission profile lives — passing both would silently run with no profile. It exists
    // to keep the owner's own Codex config away from a remote caller, and the private CODEX_HOME
    // the profile is written into already does that, more thoroughly.
    ...(profile ? [] : ["--ignore-user-config"]),
    "--ignore-rules",
    ...(profile
      // `codex exec` selects a permissions profile through the config override. `-P` belongs
      // only to `codex sandbox` (Codex 0.147) and makes exec exit before accepting the turn.
      ? ["-c", `permission_profile=${JSON.stringify(profile.profileName)}`]
      : [
        "-c", writableRoots.length > 0 ? 'sandbox_mode="workspace-write"' : 'sandbox_mode="read-only"',
        ...(writableRoots.length > 0
          ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`]
          : []),
      ]),
    "-c", "project_doc_max_bytes=0",
    "-c", "tools.web_search=false",
    ...(input.model ? ["-m", input.model] : []),
  ];
  return input.resumeThreadId
    ? ["exec", "resume", input.resumeThreadId, ...isolation, "-"]
    : ["exec", ...isolation, "-C", input.cwd, "-"];
}
