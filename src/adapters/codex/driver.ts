import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncMessageQueue } from "../claude-code/message-queue.js";

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
  | { type: "error"; message?: string };

export interface CodexTurnStartInput {
  prompt: string;
  cwd: string;
  resumeThreadId?: string;
  codexPath?: string;
  model?: string;
  log?: (line: string) => void;
}

export interface CodexTurn extends AsyncIterable<CodexThreadEvent> {
  close(): void;
}

export interface CodexDriver {
  startTurn(input: CodexTurnStartInput): CodexTurn;
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
    this.#child = spawn(command, buildArgs(input), {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Windows cannot execute npm .cmd/.bat shims directly. Limit shell use
      // to those shims; native executables and POSIX launchers remain direct.
      shell: requiresWindowsShell(command),
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
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
        this.#sawTerminalEvent = true;
      }
      this.push(event);
    });
    this.#child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#stderrTail = (this.#stderrTail + text).slice(-2000);
      input.log?.(`codex stderr: ${text.trimEnd()}`);
    });
    this.#child.on("error", (error) => {
      this.push({ type: "error", message: `codex spawn failed: ${String(error)}` });
      this.#events.close();
    });
    this.#child.on("close", (code) => {
      if (!this.#closed && code !== 0 && !this.#sawTerminalEvent) {
        this.push({
          type: "error",
          message: `codex exited with code ${code}: ${this.#stderrTail.trim() || "no stderr output"}`,
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

function buildArgs(input: CodexTurnStartInput): string[] {
  // The receiver stays as close to text-only as codex allows: read-only sandbox,
  // no user config/rules/AGENTS.md ingestion, no web search. `-` reads the prompt
  // from stdin so message content never appears in the process argument list.
  const isolation = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-c", 'sandbox_mode="read-only"',
    "-c", "project_doc_max_bytes=0",
    "-c", "tools.web_search=false",
    ...(input.model ? ["-m", input.model] : []),
  ];
  return input.resumeThreadId
    ? ["exec", "resume", input.resumeThreadId, ...isolation, "-"]
    : ["exec", ...isolation, "-C", input.cwd, "-"];
}
