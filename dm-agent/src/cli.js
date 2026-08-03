#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AicooApi } from "./api.js";
import { LocalDmAgent } from "./agent.js";
import { CodexResponder } from "./codex.js";
import { ApprovalBroker, resolveApproval, listApprovals } from "./approval.js";
import { AgentState } from "./state.js";

const DEFAULT_SERVER = "https://www.aicoo.io";

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function stateDirFor({ server, me, peer, override }) {
  if (override) return override;
  const host = new URL(server).hostname;
  return join(homedir(), ".aicoo-dm-agent", host, `${me}--${peer}`);
}

function usage() {
  console.log(`aicoo-dm-agent — chat-rails local agent for Aicoo DMs

Usage:
  AICOO_TOKEN=aicoo_sk_… aicoo-dm-agent start --peer <username|userId> [options]
  aicoo-dm-agent send --peer <username|userId> --text "…"      one-shot DM (reachout)
  aicoo-dm-agent whoami                                        identity of AICOO_TOKEN
  aicoo-dm-agent approve <id> --allow|--deny --peer <peer>     resolve a pending tool approval
  aicoo-dm-agent pending --peer <peer>                         list pending tool approvals
  aicoo-dm-agent start --dry-run-message "…" [options]         one local turn, no network send

Options:
  --workspace <dir>        folder the agent may Read/Glob/Grep (default: cwd)
  --server <url>           control plane (default: ${DEFAULT_SERVER} — keep the www host)
  --poll <ms>              poll interval (default: 3000)
  --approve-timeout <s>    owner approval timeout, then deny (default: 300)
  --auto-allow-read        skip approval prompts for in-workspace reads (demo only)
  --reachout "<text>"      send this DM to --peer once at startup
  --model <model>          model override for the local session
  --watch-agent-thread     also answer in the peer's agent thread (their cloud agent
                           answers there too, so expect two replies per question)
  --state-dir <dir>        override state directory
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const server = args.server ?? DEFAULT_SERVER;
  const token = process.env.AICOO_TOKEN;

  if (!command || command === "help" || args.help) return usage();

  // ── Local-only commands (no token needed) ──
  if (command === "approve" || command === "pending") {
    const peer = args.peer;
    if (!peer) throw new Error("--peer is required (state is scoped per peer)");
    const me = args.me ?? "me";
    // approvals dir must match the running agent's; allow explicit --state-dir
    const dir = join(stateDirFor({ server, me, peer, override: args["state-dir"] }), "approvals");
    if (command === "pending") {
      const pending = listApprovals(dir);
      if (!pending.length) return console.log("(no pending approvals)");
      for (const p of pending) console.log(`${p.id}  ${p.toolName}  ${p.summary}  expires ${new Date(p.expiresAt).toISOString()}`);
      return;
    }
    const id = args._[0];
    const decision = args.allow ? "allow" : args.deny ? "deny" : null;
    if (!id || !decision) throw new Error("usage: approve <id> --allow|--deny --peer <peer>");
    const record = resolveApproval({ approvalsDir: dir, id, decision });
    console.log(`approval ${record.id} → ${decision}`);
    return;
  }

  // ── Dry run: one local turn, print reply, exit ──
  if (command === "start" && args["dry-run-message"]) {
    const workspace = args.workspace ?? process.cwd();
    const stateDir = stateDirFor({ server, me: "dry", peer: args.peer ?? "dry", override: args["state-dir"] });
    const state = new AgentState(join(stateDir, "state.json"));
    const approvals = new ApprovalBroker({
      approvalsDir: join(stateDir, "approvals"),
      timeoutSec: Number(args["approve-timeout"] ?? 300),
      autoAllowRead: Boolean(args["auto-allow-read"]),
      log,
    });
    const agent = new LocalDmAgent({
      workspace,
      state,
      approvals,
      ownerLabel: args["owner-label"] ?? "the owner",
      peerLabel: args.peer ?? "a peer",
      model: args.model,
      log,
    });
    log(`dry run in ${workspace}`);
    const reply = await agent.runTurn({
      text: String(args["dry-run-message"]),
      from: args.peer ?? "dry-run-peer",
      conversationId: "dry",
      createdAt: new Date().toISOString(),
    });
    console.log(`\n────── reply ──────\n${reply}\n───────────────────`);
    return;
  }

  if (!token) throw new Error("AICOO_TOKEN env var is required");
  const api = new AicooApi({ baseUrl: server, token, log });

  if (command === "whoami") {
    const me = await api.identity();
    console.log(JSON.stringify(me, null, 2));
    return;
  }

  if (command === "send") {
    if (!args.peer || !args.text) throw new Error("usage: send --peer <username|userId> --text \"…\"");
    const res = await api.sendHuman(args.peer, String(args.text));
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command !== "start") {
    usage();
    throw new Error(`unknown command: ${command}`);
  }

  // ── start: the main loop ──
  const peer = args.peer;
  if (!peer) throw new Error("--peer is required");
  const workspace = args.workspace ?? process.cwd();
  const pollMs = Number(args.poll ?? 3000);

  const me = await api.identity();
  log(`agent online as @${me.username} (${me.userId}), peer=${peer}, workspace=${workspace}`);

  const stateDir = stateDirFor({ server, me: me.username, peer, override: args["state-dir"] });
  const state = new AgentState(join(stateDir, "state.json"));
  const approvals = new ApprovalBroker({
    approvalsDir: join(stateDir, "approvals"),
    timeoutSec: Number(args["approve-timeout"] ?? 300),
    autoAllowRead: Boolean(args["auto-allow-read"]),
    log,
  });
  const agent = new LocalDmAgent({
    workspace,
    state,
    approvals,
    ownerLabel: `@${me.username}`,
    peerLabel: `@${peer}`,
    model: args.model,
    log,
  });
  // --responder: "agent" (Claude SDK, per-call owner approval), "codex" (codex exec,
  // read-only sandbox as the wall — no per-call approval hook), or "echo" (transport
  // smoke test, no LLM — for machines whose local runtime is not logged in).
  const responder = args.responder ?? "agent";
  const codex = responder === "codex"
    ? new CodexResponder({
        workspace,
        state,
        ownerLabel: `@${me.username}`,
        peerLabel: `@${peer}`,
        codexPath: args["codex-path"],
        model: args.model,
        log,
      })
    : null;
  if (codex) log(`[codex] containment = read-only sandbox in ${workspace}; per-call owner approval NOT wired on this runtime`);
  log(`state: ${stateDir}  responder=${responder}`);

  if (args.reachout) {
    const res = await api.withRetry(() => api.sendHuman(peer, String(args.reachout), `dm-agent-reachout:${me.userId}:${Date.now()}`));
    log(`reachout sent → conversation ${res.conversationId} (recipient: ${res.recipientName})`);
  }

  const watchAgentThread = Boolean(args["watch-agent-thread"]);
  log(watchAgentThread
    ? `watching direct DMs AND the agent thread — expect the cloud agent to answer there too`
    : `watching direct DMs only (pass --watch-agent-thread to also answer in the agent thread)`);

  let stopping = false;
  let runtimeHintShown = false;
  process.on("SIGINT", () => { stopping = true; log("stopping…"); });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      const conversations = (await api.conversations({ view: "all", contact: peer, limit: 50 }))
        // Direct DMs only, by default. In the peer's *agent* thread their cloud agent
        // already answers every message, so listening there too means one question gets
        // two different answers. Keeping to the DM makes the split legible: the DM
        // reaches the machine, the agent thread reaches the cloud.
        .filter((c) => (watchAgentThread ? c.type !== "group" : c.type === "direct"));
      for (const conv of conversations) {
        const cursor = state.cursor(conv.conversationId);
        const messages = (conv.messages ?? []).filter((m) => m.id != null);
        if (!messages.length) continue;
        const maxId = Math.max(...messages.map((m) => Number(m.id)));
        if (cursor === null) {
          // First sight of this conversation: baseline, never replay history.
          state.setCursor(conv.conversationId, maxId);
          continue;
        }
        const fresh = messages
          .filter((m) => Number(m.id) > cursor)
          .filter((m) => m.senderType === "human" && m.senderId && m.senderId !== me.userId && m.role !== "assistant")
          .sort((a, b) => Number(a.id) - Number(b.id));
        // Advance past non-processable messages too (our own echoes, agent rows).
        if (!fresh.length) {
          if (maxId > cursor) state.setCursor(conv.conversationId, maxId);
          continue;
        }
        for (const message of fresh) {
          const preview = String(message.content).slice(0, 120).replace(/\s+/g, " ");
          // Spell out that the sender is a person: the bare conversation type reads as
          // "an agent sent this", and only senderType === 'human' rows get this far.
          log(`inbound #${message.id} (from a human, conv ${conv.conversationId}, type=${conv.type}): ${preview}`);
          const inbound = {
            text: String(message.content),
            from: message.senderLabel ?? `@${peer}`,
            conversationId: conv.conversationId,
            createdAt: message.createdAt,
          };
          const reply = responder === "echo"
            ? `[transport-test echo] 已收到你的消息(#${message.id}): "${String(message.content).slice(0, 200)}" — 本地 runtime 等 owner 重新 claude /login 后切换真实 agent 模式。`
            : responder === "codex"
              ? await codex.runTurn(inbound)
              : await agent.runTurn(inbound);
          log(`reply for #${message.id}: ${reply.slice(0, 120).replace(/\s+/g, " ")}`);
          // The peer's thread also receives answers from Aicoo's cloud agent, which
          // replies to the same message within seconds and has no access to this
          // machine. Prefix ours so the two are never confused in the app.
          const tagged = args["no-tag"] ? reply : `${args.tag ?? "🖥️ [本地 agent]"} ${reply}`;
          await api.withRetry(() => api.sendHuman(peer, tagged, `dm-agent:${me.userId}:${message.id}`));
          state.setCursor(conv.conversationId, Number(message.id));
          log(`reply sent for #${message.id}`);
        }
        state.setCursor(conv.conversationId, maxId);
      }
    } catch (error) {
      if (error.status === 401) {
        log(`FATAL: API key rejected (401). Exiting.`);
        process.exit(1);
      }
      const detail = String(error.message ?? error);
      log(`poll error: ${detail.slice(0, 300)}`);
      // These two fail identically every few seconds forever, and the raw text says
      // nothing about the fix. Name it once, the first time it happens.
      if (!runtimeHintShown) {
        if (/Request not allowed|403/.test(detail)) {
          runtimeHintShown = true;
          log(`[hint] Anthropic returned 403 "Request not allowed" — that is the network refusing the`);
          log(`[hint] request, not your Aicoo key. If you reach the API through a proxy, restart with:`);
          log(`[hint]   HTTPS_PROXY=http://127.0.0.1:<port> HTTP_PROXY=http://127.0.0.1:<port> aicoo-dm-agent start ...`);
        } else if (/Not logged in|Please run \/login|authenticate/i.test(detail)) {
          runtimeHintShown = true;
          log(`[hint] The local Claude Code is not logged in. In a plain terminal run 'claude /login',`);
          log(`[hint] then verify with: env -i HOME="$HOME" PATH="$PATH" claude -p "reply with exactly OK"`);
        }
      }
      await delay(5000);
    }
    await delay(pollMs);
  }
  log("stopped.");
}

main().catch((error) => {
  console.error(`error: ${error.message ?? error}`);
  process.exit(1);
});
