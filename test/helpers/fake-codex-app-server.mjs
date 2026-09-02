#!/usr/bin/env node
/**
 * A stand-in for `codex app-server` that speaks the same JSON-RPC dialect the real one does,
 * so the driver's spawn/framing/approval plumbing is exercised without a model or a network.
 *
 * Shapes here were taken from a live codex-cli 0.146.0 session, not from the schema alone —
 * see docs/CODEX-APP-SERVER-APPROVAL.md.
 *
 * Env:
 *   FAKE_APPROVAL_METHOD  which approval to request (default item/commandExecution/requestApproval)
 *   FAKE_APPROVAL_PARAMS  JSON params for it
 *   FAKE_SKIP_APPROVAL    set to skip asking and just complete the turn
 *   FAKE_EXIT_EARLY       set to exit(1) right after turn/start, simulating a crash mid-turn
 *   FAKE_REQUIRE_EXPERIMENTAL_API reject workspace roots unless initialize advertised support
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const APPROVAL_METHOD = process.env.FAKE_APPROVAL_METHOD ?? "item/commandExecution/requestApproval";
const APPROVAL_PARAMS = JSON.parse(
  process.env.FAKE_APPROVAL_PARAMS ?? '{"command":"/bin/zsh -lc \'git diff\'","cwd":"/srv/project"}',
);

let approvalRequestId = null;
let dynamicToolRequestId = null;
let threadStartParams = null;
let experimentalApiEnabled = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Our own approval question came back answered.
  if (msg.id !== undefined && msg.method === undefined && msg.id === approvalRequestId) {
    const decision = msg.result?.decision ?? (msg.result?.permissions ? "permissions-answered" : "unknown");
    // Deliberately camelCase, like the real server: the driver has to normalize it.
    notify("item/completed", { item: { type: "agentMessage", id: "msg_1", text: `decision=${decision}` } });
    notify("turn/completed", { threadId: "th_fake" });
    return;
  }
  if (msg.id !== undefined && msg.method === undefined && msg.id === dynamicToolRequestId) {
    const text = msg.result?.contentItems?.[0]?.text ?? "missing dynamic tool response";
    notify("item/completed", { item: { type: "agentMessage", id: "msg_1", text } });
    notify("turn/completed", { threadId: "th_fake" });
    return;
  }

  if (msg.method === "initialize") {
    experimentalApiEnabled = msg.params?.capabilities?.experimentalApi === true;
    respond(msg.id, { codexHome: "/tmp/fake-codex", platformOs: "macos", platformFamily: "unix", userAgent: "fake" });
    return;
  }
  if (msg.method === "thread/start" || msg.method === "thread/resume") {
    if (msg.method === "thread/start") threadStartParams = msg.params;
    if (
      process.env.FAKE_REQUIRE_EXPERIMENTAL_API
      && Array.isArray(msg.params?.runtimeWorkspaceRoots)
      && !experimentalApiEnabled
    ) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32600,
          message: "thread/start.runtimeWorkspaceRoots requires experimentalApi capability",
        },
      });
      return;
    }
    respond(msg.id, { threadId: "th_fake" });
    return;
  }
  if (msg.method === "turn/start") {
    // turn/start only acknowledges — the real server resolves this long before any work happens.
    respond(msg.id, {});
    if (process.env.FAKE_EXIT_EARLY) {
      process.exit(1);
      return;
    }
    notify("turn/started", { threadId: "th_fake" });
    // Noise the driver must ignore rather than forward.
    notify("item/agentMessage/delta", { delta: "thinking" });
    notify("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 1 } } });

    if (process.env.FAKE_HANG_AFTER_TURN_START) return;

    if (process.env.FAKE_CALL_DYNAMIC_TOOL) {
      if (!threadStartParams?.dynamicTools?.some((candidate) => candidate.name === "request_capability")) {
        notify("item/completed", {
          item: { type: "agentMessage", id: "msg_1", text: "dynamic tool was not registered" },
        });
        notify("turn/completed", { threadId: "th_fake" });
        return;
      }
      dynamicToolRequestId = 9002;
      send({
        jsonrpc: "2.0",
        id: dynamicToolRequestId,
        method: "item/tool/call",
        params: {
          threadId: "th_fake",
          turnId: "turn_fake",
          callId: "call_fake",
          namespace: null,
          tool: "request_capability",
          arguments: { capability: "mcp.lark.search_messages", reason: "Find the requested discussion" },
        },
      });
      return;
    }

    if (process.env.FAKE_SKIP_APPROVAL) {
      const text = process.env.FAKE_REPORT_THREAD_START
        ? JSON.stringify(threadStartParams)
        : "no approval needed";
      notify("item/completed", { item: { type: "agentMessage", id: "msg_1", text } });
      notify("turn/completed", { threadId: "th_fake" });
      return;
    }
    approvalRequestId = 9001;
    send({ jsonrpc: "2.0", id: approvalRequestId, method: APPROVAL_METHOD, params: APPROVAL_PARAMS });
    return;
  }
});
