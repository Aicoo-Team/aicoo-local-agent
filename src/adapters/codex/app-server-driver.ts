import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AsyncMessageQueue } from "../claude-code/message-queue.js";
import { buildCodexSpawnCommand, type CodexDriver, type CodexThreadEvent, type CodexTurn, type CodexTurnStartInput } from "./driver.js";
import {
  approvalResponse,
  classifyApproval,
  isTerminalNotification,
  mapNotification,
  UNKNOWN_APPROVAL_RESPONSE,
  type CodexApprovalDecision,
  type CodexApprovalRequest,
} from "./app-server-protocol.js";

/**
 * A Codex driver that can stop and ask.
 *
 * `codex exec` runs a turn to completion with no way in: a tool call the sandbox cannot satisfy is
 * simply refused, and the peer gets a refusal for something its owner would very likely have
 * allowed. The `app-server` protocol sends that question to us instead, as a JSON-RPC request we
 * answer whenever we are ready — which is what lets the owner be the one who decides.
 *
 * Verified live before this was written (docs/CODEX-APP-SERVER-APPROVAL.md): the turn survived a
 * 310-second hold and then honoured the answer, so a real round trip to the owner fits inside the
 * five-minute approval budget with room to spare.
 */
export interface CodexAppServerDriverConfig {
  log?: (line: string) => void;
}

export class CodexAppServerDriver implements CodexDriver {
  readonly #config: CodexAppServerDriverConfig;

  constructor(config: CodexAppServerDriverConfig = {}) {
    this.#config = config;
  }

  startTurn(input: CodexTurnStartInput): CodexTurn {
    return new CodexAppServerTurn(input, this.#config);
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CodexAppServerTurn implements CodexTurn {
  readonly #events = new AsyncMessageQueue<CodexThreadEvent>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #child: ChildProcess;
  readonly #input: CodexTurnStartInput;
  readonly #config: CodexAppServerDriverConfig;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #sawTerminal = false;
  #closed = false;
  #turnTimer?: ReturnType<typeof setTimeout>;

  constructor(input: CodexTurnStartInput, config: CodexAppServerDriverConfig) {
    this.#input = input;
    this.#config = config;

    const command = input.codexPath ?? "codex";
    const spawnCommand = buildCodexSpawnCommand(command, ["app-server"]);
    this.#child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: input.permissionProfile
        ? {
            ...process.env,
            ...input.permissionProfile.environment,
            CODEX_HOME: input.permissionProfile.codexHome,
          }
        : process.env,
      windowsVerbatimArguments: false,
    });

    const stdout = createInterface({ input: this.#child.stdout! });
    stdout.on("line", (line) => this.#onLine(line));
    this.#child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.#stderrTail = (this.#stderrTail + text).slice(-2000);
    });
    this.#child.on("error", (error) => {
      this.#push({ type: "error", message: `codex app-server spawn failed: ${String(error)}`, fatal: true });
      this.#events.close();
    });
    this.#child.on("close", (code) => {
      if (this.#turnTimer) clearTimeout(this.#turnTimer);
      if (!this.#closed && !this.#sawTerminal) {
        this.#push({
          type: "error",
          message: `codex app-server exited with code ${code}: ${this.#stderrTail.trim() || "no stderr output"}`,
          fatal: true,
        });
      }
      for (const waiter of this.#pending.values()) waiter.reject(new Error("codex app-server closed"));
      this.#pending.clear();
      this.#events.close();
    });

    void this.#run();
  }

  async #run(): Promise<void> {
    try {
      await this.#request("initialize", {
        clientInfo: { name: "aicoo-local-agent", version: "0.3.1", title: "Aicoo Local Agent" },
        capabilities: { experimentalApi: true },
      });
      this.#notify("initialized", {});

      const thread = this.#input.resumeThreadId
        ? await this.#request("thread/resume", { threadId: this.#input.resumeThreadId })
        : await this.#request("thread/start", {
          cwd: this.#input.cwd,
          ...(this.#input.dynamicTools?.length ? { dynamicTools: this.#input.dynamicTools } : {}),
          // Everything the sandbox cannot serve becomes a question for the owner rather than a
          // silent refusal. That is the entire point of using app-server over exec.
          approvalPolicy: "untrusted",
          ...(this.#input.permissionProfile
            ? {
                permissions: this.#input.permissionProfile.profileName,
                runtimeWorkspaceRoots: this.#input.permissionProfile.workspaceRoots ?? [this.#input.cwd],
              }
            : { sandboxPolicy: sandboxPolicy(this.#input) }),
        });
      const threadId = readThreadId(thread);
      if (!threadId) throw new Error("codex app-server did not return a thread id");
      this.#push({ type: "thread.started", thread_id: threadId });

      await this.#request("turn/start", {
        threadId,
        input: [{ type: "text", text: this.#input.prompt }],
      });
      if (this.#input.turnTimeoutMs !== undefined) {
        this.#turnTimer = setTimeout(() => {
          if (this.#closed || this.#sawTerminal) return;
          this.#sawTerminal = true;
          this.#push({
            type: "error",
            message: `codex app-server execution timeout after ${this.#input.turnTimeoutMs}ms`,
            fatal: true,
          });
          this.#events.close();
          this.#child.kill("SIGTERM");
        }, this.#input.turnTimeoutMs);
      }
      // turn/start only acknowledges; the work arrives as notifications and ends at
      // turn/completed or turn/failed. Nothing more to await here.
    } catch (error) {
      if (this.#closed) return;
      this.#push({ type: "error", message: `codex app-server turn failed: ${String(error)}`, fatal: true });
      this.#events.close();
    }
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.#config.log?.(`codex app-server non-JSON output ignored: ${trimmed.slice(0, 200)}`);
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    // A response to something we asked.
    if (id !== undefined && method === undefined) {
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      if (!waiter) return;
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }

    // A request from the server. Approvals are the reason this driver exists.
    if (id !== undefined && method) {
      void this.#answerServerRequest(id, method, msg.params);
      return;
    }

    if (!method) return;
    const event = mapNotification(method, msg.params);
    if (!isTerminalNotification(method)) {
      if (event) this.#push(event);
      return;
    }
    // The terminal event has to be delivered before the queue closes, or the consumer sees the
    // stream end with no turn.completed and reads a healthy turn as a dropped one.
    this.#sawTerminal = true;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    const delivered = event ? this.#events.push(event).catch(() => {}) : Promise.resolve();
    void delivered.then(() => {
      this.#events.close();
      this.#child.kill("SIGTERM");
    });
  }

  async #answerServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method === "item/tool/call") {
      if (!this.#input.onDynamicToolCall) {
        this.#config.log?.("codex dynamic tool refused: no host route configured");
        this.#respond(id, dynamicToolResponse(false, "Aicoo capability request route is unavailable"));
        return;
      }
      try {
        const result = await this.#input.onDynamicToolCall(params as Parameters<NonNullable<CodexTurnStartInput["onDynamicToolCall"]>>[0]);
        this.#respond(id, dynamicToolResponse(result.success, result.text));
      } catch (error) {
        this.#config.log?.(`codex dynamic tool failed closed: ${String(error)}`);
        this.#respond(id, dynamicToolResponse(false, "Aicoo capability request failed"));
      }
      return;
    }
    if (!method.endsWith("requestApproval")) {
      // Anything else the server asks gets a minimal answer so it does not stall waiting on us.
      this.#respond(id, {});
      return;
    }

    const request = classifyApproval(method, params);
    if (!request) {
      this.#config.log?.(`codex approval of unknown kind refused: ${method}`);
      this.#respond(id, UNKNOWN_APPROVAL_RESPONSE);
      return;
    }
    if (!this.#input.onApproval) {
      this.#config.log?.(`codex approval refused, no approval route configured: ${request.summary}`);
      this.#respond(id, approvalResponse(request, "decline"));
      return;
    }

    let decision: CodexApprovalDecision;
    try {
      decision = await this.#input.onApproval(request);
    } catch (error) {
      // Failing to reach the owner is not permission. It is the absence of permission.
      this.#config.log?.(`codex approval could not be routed, refusing: ${String(error)}`);
      decision = "decline";
    }
    this.#config.log?.(`codex approval ${decision}: ${request.summary}`);
    this.#respond(id, approvalResponse(request, decision));
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #respond(id: number, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #write(message: unknown): void {
    if (this.#closed) return;
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #push(event: CodexThreadEvent): void {
    this.#events.push(event).catch(() => {});
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#turnTimer) clearTimeout(this.#turnTimer);
    this.#child.kill("SIGTERM");
    this.#events.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexThreadEvent> {
    return this.#events[Symbol.asyncIterator]();
  }
}

function dynamicToolResponse(success: boolean, text: string): Record<string, unknown> {
  return { success, contentItems: [{ type: "inputText", text }] };
}

/**
 * Writes are opened only where the relationship actually granted them. Reads are scoped by the
 * permission profile in CODEX_HOME (see permission-profile.ts), which the sandbox policy cannot
 * express on its own.
 */
function sandboxPolicy(input: CodexTurnStartInput): Record<string, unknown> {
  const writableRoots = input.writableRoots ?? [];
  return writableRoots.length > 0
    ? { type: "workspaceWrite", writableRoots, networkAccess: false }
    : { type: "readOnly", networkAccess: false };
}

function readThreadId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.threadId === "string") return record.threadId;
  const thread = record.thread;
  if (thread && typeof thread === "object") {
    const id = (thread as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}
