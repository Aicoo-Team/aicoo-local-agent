import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Codex driven through `app-server` instead of `exec`, so the owner can be asked mid-turn.
 *
 * `codex exec` runs a turn to completion with no way in: anything the sandbox cannot satisfy
 * is silently refused, and the peer is told no for something the owner would likely have
 * allowed. `app-server` sends that question to us as a JSON-RPC request we answer whenever
 * we are ready — which is what makes the owner the decider on this runtime too.
 *
 * Protocol and its traps verified live against codex-cli 0.146.0; see
 * aicoo-local-agent/docs/CODEX-APP-SERVER-APPROVAL.md. A turn survived a 310-second hold and
 * then honoured the answer, so a real round trip to a human fits with room to spare.
 */

const APPROVAL_METHODS = {
  commandExecution: "item/commandExecution/requestApproval",
  fileChange: "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval",
};

/**
 * Recognise an approval request. Anything unrecognised returns null and the caller must treat
 * that as a refusal: an approval we cannot describe to the owner is one we must not answer on
 * their behalf.
 */
export function classifyApproval(method, params, item) {
  const kind = Object.keys(APPROVAL_METHODS).find((key) => APPROVAL_METHODS[key] === method);
  if (!kind) return null;
  const p = params ?? {};
  const command = typeof p.command === "string"
    ? p.command
    : Array.isArray(p.command)
      ? p.command.join(" ")
      : (typeof item?.command === "string" ? item.command : undefined);
  const cwd = typeof p.cwd === "string" ? p.cwd : (typeof item?.cwd === "string" ? item.cwd : undefined);
  // A fileChange approval carries only ids — no path, no diff. Verified live against
  // codex-cli 0.146.0: the params are {threadId, turnId, itemId, startedAtMs, reason,
  // grantRoot}. What it is about arrives earlier, on item/started for the same id, which is
  // where `changes[]` with path, kind and diff live. Without that correlation the owner is
  // shown "Modify files" and asked yes or no, which is not a decision anyone can make.
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes.map((c) => c?.path).filter((x) => typeof x === "string");
  return {
    kind,
    command,
    cwd,
    itemId: typeof p.itemId === "string" ? p.itemId : undefined,
    paths,
    changes,
    summary: kind === "commandExecution"
      ? (command ? `Run: ${command}` : "Run a shell command")
      : kind === "fileChange"
        ? (paths.length ? `Change ${paths.join(", ")}` : "Modify files (Codex did not say which)")
        : "Widen this session's sandbox permissions",
  };
}

/**
 * The JSON-RPC result for an approval.
 *
 * A `permissions` request is Codex asking for *more* than the profile it was started with.
 * The answer is always an empty grant regardless of what the owner said: the peer's reach is
 * defined by the relationship, not by what the model would like. Answering (rather than
 * ignoring) keeps Codex from waiting on a request nobody replied to.
 */
export function approvalResponse(request, decision) {
  if (request.kind === "permissions") return { permissions: {}, scope: "turn" };
  return { decision };
}

export const UNKNOWN_APPROVAL_RESPONSE = { decision: "decline" };

const TERMINAL = new Set(["turn/completed", "turn/failed"]);

function mapNotification(method, params) {
  const p = params ?? {};
  if (method === "turn/completed") return { type: "turn.completed", usage: p.usage };
  if (method === "turn/failed") return { type: "turn.failed", error: p.error };
  if (method === "item/started") return { type: "item.started", item: p.item ?? {} };
  if (method === "item/updated") return { type: "item.updated", item: p.item ?? {} };
  if (method === "item/completed") return { type: "item.completed", item: p.item ?? {} };
  return undefined;
}

/** One turn: spawn app-server, drive the handshake, stream events, answer approvals. */
export class CodexAppServerTurn {
  #child;
  #pending = new Map();
  #queue = [];
  #waiters = [];
  #closed = false;
  #ended = false;
  #sawTerminal = false;
  /**
   * item/started payloads, by id. An approval request names only an itemId; everything the
   * owner needs to judge it — the file path, the kind of change, the diff — arrived on this
   * notification moments earlier. Kept for the life of the turn, which is short.
   */
  #items = new Map();
  #nextId = 1;
  #stderrTail = "";

  constructor({ prompt, cwd, resumeThreadId, writableRoots, codexPath = "codex", onApproval, log }) {
    this.input = { prompt, cwd, resumeThreadId, writableRoots, onApproval };
    this.log = log;

    this.#child = spawn(codexPath, ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#onLine(line));
    this.#child.stderr?.on("data", (data) => {
      this.#stderrTail = (this.#stderrTail + data.toString()).slice(-2000);
    });
    this.#child.on("error", (error) => {
      this.#push({ type: "error", message: `codex app-server spawn failed: ${String(error)}`, fatal: true });
      this.#end();
    });
    this.#child.on("close", (code) => {
      if (!this.#closed && !this.#sawTerminal) {
        this.#push({
          type: "error",
          message: `codex app-server exited with code ${code}: ${this.#stderrTail.trim() || "no stderr"}`,
          fatal: true,
        });
      }
      for (const waiter of this.#pending.values()) waiter.reject(new Error("codex app-server closed"));
      this.#pending.clear();
      this.#end();
    });

    void this.#run();
  }

  async #run() {
    try {
      await this.#request("initialize", {
        clientInfo: { name: "aicoo-dm-agent", version: "0.3.0", title: "Aicoo DM Agent" },
      });
      this.#notify("initialized", {});

      const writableRoots = this.input.writableRoots ?? [];
      const thread = this.input.resumeThreadId
        ? await this.#request("thread/resume", { threadId: this.input.resumeThreadId })
        : await this.#request("thread/start", {
          cwd: this.input.cwd,
          // Everything the sandbox cannot serve becomes a question for the owner rather than
          // a silent refusal — the entire reason for using app-server over exec.
          approvalPolicy: "untrusted",
          sandboxPolicy: writableRoots.length
            ? { type: "workspaceWrite", writableRoots, networkAccess: false }
            : { type: "readOnly", networkAccess: false },
        });

      const threadId = readThreadId(thread);
      if (!threadId) throw new Error("codex app-server did not return a thread id");
      this.#push({ type: "thread.started", thread_id: threadId });

      // turn/start only acknowledges — it resolves in milliseconds, long before any work.
      // Everything real arrives as notifications ending at turn/completed or turn/failed.
      // Waiting on this promise for the answer is the mistake that makes a healthy turn look
      // like one where no approval was ever requested.
      await this.#request("turn/start", { threadId, input: [{ type: "text", text: this.input.prompt }] });
    } catch (error) {
      if (this.#closed) return;
      this.#push({ type: "error", message: `codex app-server turn failed: ${String(error)}`, fatal: true });
      this.#end();
    }
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    const { id, method } = msg;
    if (id !== undefined && method === undefined) {
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      if (!waiter) return;
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (id !== undefined && method) {
      void this.#answerServerRequest(id, method, msg.params);
      return;
    }
    if (!method) return;

    const event = mapNotification(method, msg.params);
    const item = msg.params?.item;
    if (item?.id) this.#items.set(item.id, item);
    if (!TERMINAL.has(method)) {
      if (event) this.#push(event);
      return;
    }
    // Deliver the terminal event before closing, or the consumer sees the stream end with no
    // turn.completed and reads a healthy turn as a dropped one.
    this.#sawTerminal = true;
    if (event) this.#push(event);
    this.#end();
    this.#child.kill("SIGTERM");
  }

  async #answerServerRequest(id, method, params) {
    if (!method.endsWith("requestApproval")) {
      this.#respond(id, {});
      return;
    }
    const request = classifyApproval(method, params, this.#items.get(params?.itemId));
    if (!request) {
      this.log?.(`[codex] approval of unknown kind refused: ${method}`);
      this.#respond(id, UNKNOWN_APPROVAL_RESPONSE);
      return;
    }
    if (!this.input.onApproval) {
      this.log?.(`[codex] approval refused, no route configured: ${request.summary}`);
      this.#respond(id, approvalResponse(request, "decline"));
      return;
    }
    let decision;
    try {
      decision = await this.input.onApproval(request);
    } catch (error) {
      // Failing to reach the owner is not permission. It is the absence of permission.
      this.log?.(`[codex] approval could not be routed, refusing: ${String(error)}`);
      decision = "decline";
    }
    this.#respond(id, approvalResponse(request, decision));
  }

  #request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #write(message) {
    if (this.#closed) return;
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #push(event) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  #end() {
    if (this.#ended) return;
    this.#ended = true;
    while (this.#waiters.length) this.#waiters.shift()({ value: undefined, done: true });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill("SIGTERM");
    this.#end();
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function readThreadId(result) {
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.threadId === "string") return result.threadId;
  const thread = result.thread;
  if (thread && typeof thread === "object" && typeof thread.id === "string") return thread.id;
  return undefined;
}
