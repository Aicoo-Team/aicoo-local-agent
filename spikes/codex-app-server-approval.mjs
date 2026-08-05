/**
 * Phase 3 feasibility spike: can we intercept a Codex tool call, hold it on an async decision we
 * make ourselves, and have Codex honour that decision?
 *
 * That is the exact shape the Claude Code adapter already has via canUseTool. If this round trip
 * works, Codex can use the same owner-approval gateway. If it does not, phase 3 is off.
 *
 * Usage: node codex-spike.mjs <accept|decline>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODE = process.argv[2] === "decline" ? "decline" : "accept";
const TARGET_APPROVAL = "item/commandExecution/requestApproval";
const DEADLINE_MS = Number(process.env.SPIKE_DEADLINE_MS ?? 150_000);

const workspace = mkdtempSync(join(tmpdir(), "aicoo-codex-spike-"));
writeFileSync(join(workspace, "canary.txt"), "AICOO_CANARY_CONTENT\n");

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map();
const log = [];
function note(kind, detail) {
  const line = { t: Date.now() - t0, kind, detail };
  log.push(line);
  console.log(`[${String(line.t).padStart(6)}ms] ${kind}${detail ? ` :: ${detail}` : ""}`);
}
const t0 = Date.now();

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** What we are here to prove: the approval arrived, and we answered it ourselves. */
let approvalSeen = null;
let approvalAnsweredAt = null;
let heldForMs = null;
let turnEnded = null;
const commandOutputs = [];
const agentText = [];

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
child.stderr.on("data", (c) => {
  const s = c.toString().trim();
  if (s) note("stderr", s.slice(0, 300));
});

async function handle(msg) {
  // A response to something we asked.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (!waiter) return;
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
    return;
  }

  // A request FROM the server that we must answer. This is the whole point.
  if (msg.id !== undefined && msg.method) {
    note("server->client REQUEST", msg.method);
    if (msg.method.endsWith("requestApproval")) {
      // Only answer the one under test. Blanket-accepting once let Codex's own memory plugin
      // write outside the workspace — precisely the failure this whole feature exists to stop.
      if (msg.method !== TARGET_APPROVAL) {
        note("declining off-target approval", `${msg.method} ${JSON.stringify(msg.params?.command ?? msg.params?.changes ?? {}).slice(0, 160)}`);
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: "decline" } });
        return;
      }
      const askedAt = Date.now();
      approvalSeen = { method: msg.method, params: msg.params };
      note(
        "approval params",
        JSON.stringify({
          command: msg.params?.command,
          cwd: msg.params?.cwd,
          reason: msg.params?.reason,
          permissions: msg.params?.permissions,
        }).slice(0, 400),
      );

      // Simulate exactly what the real gateway does: an async network round trip to the owner.
      // If Codex cannot tolerate a slow answer here, the whole design is dead, so make it slow.
      note("holding the turn while we 'ask the owner'...");
      await new Promise((r) => setTimeout(r, Number(process.env.SPIKE_HOLD_MS ?? 3_000)));

      const decision =
        msg.method === "item/permissions/requestApproval"
          ? { permissions: msg.params?.permissions ?? {}, scope: "turn" }
          : { decision: MODE === "accept" ? "accept" : "decline" };
      heldForMs = Date.now() - askedAt;
      approvalAnsweredAt = Date.now();
      note(`answering ${MODE} after holding ${heldForMs}ms`);
      send({ jsonrpc: "2.0", id: msg.id, result: decision });
      return;
    }
    // Anything else the server asks, answer minimally so it does not stall.
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  // Notifications.
  const m = msg.method ?? "";
  if (process.env.SPIKE_TRACE) note("notif", `${m} ${JSON.stringify(msg.params ?? {}).slice(0, 220)}`);
  if (m.includes("commandExecution") || m.includes("command/exec")) {
    const out = msg.params?.chunk ?? msg.params?.delta ?? msg.params?.output;
    if (typeof out === "string" && out.trim()) commandOutputs.push(out);
  }
  if (m === "codex/event/agent_message_delta" || m.includes("AgentMessageDelta")) {
    if (msg.params?.delta) agentText.push(msg.params.delta);
  }
  if (m.includes("item/completed") || m.includes("ItemCompleted")) {
    const item = msg.params?.item;
    if (item?.type) note("item completed", `${item.type}${item.command ? ` :: ${item.command}` : ""}`);
    if (item?.aggregatedOutput) commandOutputs.push(item.aggregatedOutput);
    if (item?.text) agentText.push(item.text);
  }
  if (m.includes("turn/completed") || m.includes("TurnCompleted")) {
    turnEnded = "completed";
    note("TURN COMPLETED");
  }
  if (m.includes("turn/failed") || m.includes("TurnFailed")) {
    turnEnded = "failed";
    note("TURN FAILED", JSON.stringify(msg.params).slice(0, 300));
  }
  if (m.includes("error")) note("notification", `${m} ${JSON.stringify(msg.params).slice(0, 200)}`);
}

async function main() {
  note("initialize");
  const init = await request("initialize", {
    clientInfo: { name: "aicoo-spike", version: "0.0.1", title: "Aicoo phase-3 spike" },
  });
  note("initialized", `${init.platformOs} codexHome=${init.codexHome}`);
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  note("thread/start");
  const thread = await request("thread/start", {
    cwd: workspace,
    // 'untrusted' = ask before anything leaves the sandbox. We want to be asked.
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  const threadId = thread.threadId ?? thread.thread?.id ?? thread.id;
  note("thread started", threadId);

  note("turn/start");
  const turnPromise = request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        // A write: the readOnly sandbox cannot satisfy it, so Codex must ask before running it.
        // That ask is the thing under test.
        text:
          "Run exactly this shell command, nothing else: `echo AICOO_SPIKE_WROTE > spike-out.txt`. " +
          "Then run `cat spike-out.txt` and report its output verbatim. " +
          "Do not save any memory, do not write any other file, do not use file tools — shell only.",
      },
    ],
  });

  const timer = setTimeout(() => {
    note("DEADLINE HIT — no terminal event");
    finish();
  }, DEADLINE_MS);

  turnPromise
    .then(() => note("turn/start acked"))
    .catch((error) => note("turn/start rejected", String(error).slice(0, 300)));

  // turn/start only acknowledges; the work arrives as notifications. Wait for a terminal one.
  while (turnEnded === null && Date.now() - t0 < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 2_000));
  clearTimeout(timer);
  finish();
}

function finish() {
  const output = commandOutputs.join("") + agentText.join("");
  const sawCanary = output.includes("AICOO_SPIKE_WROTE");
  const wroteFile = existsSync(join(workspace, "spike-out.txt"));
  console.log("\n================ SPIKE RESULT ================");
  console.log(`mode                : ${MODE}`);
  console.log(`approval requested  : ${approvalSeen ? `YES (${approvalSeen.method})` : "NO"}`);
  console.log(`we answered it      : ${approvalAnsweredAt ? "YES" : "NO"}`);
  console.log(`turn tolerated hold : ${heldForMs !== null ? `${heldForMs}ms` : "n/a"}`);
  console.log(`turn ended as       : ${turnEnded ?? "(none)"}`);
  console.log(`command ran         : ${sawCanary ? "YES — output came back" : "NO"}`);
  console.log(`side effect on disk : ${wroteFile ? "YES — spike-out.txt exists" : "NO — nothing written"}`);
  console.log(`workspace           : ${workspace}`);
  console.log("==============================================");
  child.kill("SIGTERM");
  process.exit(0);
}

main().catch((error) => {
  note("FATAL", String(error));
  finish();
});
