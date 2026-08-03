#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AicooApi } from "./api.js";
import { LocalDmAgent } from "./agent.js";
import { CodexResponder } from "./codex.js";
import { ApprovalBroker, resolveApproval, listApprovals } from "./approval.js";
import { AgentState } from "./state.js";
import { Policy, PolicyError } from "./policy.js";
import { AuditLog } from "./audit.js";
import { collectSecrets, redact } from "./redact.js";

const DEFAULT_SERVER = "https://www.aicoo.io";
// After this many failed turns a message is answered with an honest failure and left behind.
// Retrying forever is worse than giving up: it burns a turn every poll and blocks the queue.
const MAX_MESSAGE_ATTEMPTS = 3;

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
  --auto-allow-read        skip approval for in-workspace READS only (demo only);
                           declared commands still ask every time
  --reachout "<text>"      send this DM to --peer once at startup
  --model <model>          model override for the local session
  --watch-agent-thread     also answer in the peer's agent thread (their cloud agent
                           answers there too, so expect two replies per question)
  --policy <file>          declared commands + folders (default: <state-dir>/policy.json)
  --no-sandbox             run the model's file tools unsandboxed (only if the platform
                           cannot start one — the default is to fail rather than pretend)
  --state-dir <dir>        override state directory
`);
}

/** Load the policy, turning a bad file into an actionable line rather than a stack trace. */
function loadPolicy(file, workspace) {
  try {
    return Policy.fromFile(file, workspace, log);
  } catch (error) {
    if (error instanceof PolicyError) {
      log(`FATAL: ${file}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const server = args.server ?? DEFAULT_SERVER;
  const token = process.env.AICOO_TOKEN;

  // `--help` as the first token lands in `command`, not in `args` — and without this it would
  // fall through to the token check and greet a first-time user with an error instead of help.
  if (!command || command === "help" || command === "--help" || command === "-h" || args.help) return usage();

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
    const policy = loadPolicy(args.policy ?? join(stateDir, "policy.json"), workspace);
    const audit = new AuditLog(join(stateDir, "audit.jsonl"), { log });
    const shared = {
      workspace,
      state,
      approvals,
      policy,
      audit,
      ownerLabel: args["owner-label"] ?? "the owner",
      peerLabel: args.peer ?? "a peer",
      log,
    };
    // A dry run has to exercise the runtime the flag names. Silently running the Claude path
    // while --responder codex is set produces a green result for code that was never called.
    const dryResponder = args.responder ?? "agent";
    const agent = dryResponder === "codex"
      ? new CodexResponder({ ...shared, codexPath: args["codex-path"] })
      : new LocalDmAgent({ ...shared, model: args.model, sandbox: args["no-sandbox"] ? false : undefined });
    log(`dry run in ${workspace} · responder=${dryResponder} · ${policy.describe()}`);
    const reply = await agent.runTurn({
      text: String(args["dry-run-message"]),
      from: args.peer ?? "dry-run-peer",
      conversationId: "dry",
      createdAt: new Date().toISOString(),
    });
    // Same egress filter as the live path: a dry run must show exactly what would be sent,
    // or it is a rehearsal of different behaviour.
    const { text: safe, redacted } = redact(reply, collectSecrets(policy.folders, { log }));
    if (redacted.length) log(`[redact] withheld ${redacted.length} value(s) (${redacted.map((r) => r.source).join(", ")})`);
    console.log(`\n────── reply ──────\n${safe}\n───────────────────`);
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
  const policy = loadPolicy(args.policy ?? join(stateDir, "policy.json"), workspace);
  const agent = new LocalDmAgent({
    workspace,
    state,
    approvals,
    policy,
    audit: new AuditLog(join(stateDir, "audit.jsonl"), { log }),
    sandbox: args["no-sandbox"] ? false : undefined,
    ownerLabel: `@${me.username}`,
    peerLabel: `@${peer}`,
    model: args.model,
    log,
  });
  log(`[policy] ${policy.describe()}${policy.source ? ` (${policy.source})` : " (no policy file)"}`);
  // --responder: "agent" (Claude SDK, per-call owner approval), "codex" (codex exec,
  // read-only sandbox as the wall — no per-call approval hook), or "echo" (transport
  // smoke test, no LLM — for machines whose local runtime is not logged in).
  const responder = args.responder ?? "agent";
  const codex = responder === "codex"
    ? new CodexResponder({
        workspace,
        state,
        approvals,
        policy,
        audit: new AuditLog(join(stateDir, "audit.jsonl"), { log }),
        ownerLabel: `@${me.username}`,
        peerLabel: `@${peer}`,
        codexPath: args["codex-path"],
        log,
      })
    : null;
  if (codex) {
    log(`[codex] app-server: read-only sandbox in ${workspace}, network off, owner asked for anything it cannot serve`);
    // Not the same granularity as Claude Code, and worth saying plainly: the sandbox answers
    // reads inside the shared folder without asking, so the prompt is reserved for what it
    // refuses. Reads are effectively a standing grant on the folder the owner shared.
    log(`[codex] reads inside the shared folder are served without a prompt; commands and escapes are not`);
    if (policy.commandNames.length) {
      const offerable = codex.offerable().map((entry) => entry.name);
      const skipped = policy.commandNames.filter((name) => !offerable.includes(name));
      if (offerable.length) log(`[codex] declared commands available: ${offerable.join(", ")}`);
      // Say which ones are not on offer and why, rather than letting the owner wonder why
      // a command they declared is never used on this runtime.
      if (skipped.length) {
        log(`[codex] NOT offered here (their argv needs shell quoting, which Codex re-quotes unpredictably): ${skipped.join(", ")}`);
        log(`[codex]   wrap those in a script file and declare the script path instead`);
      }
    }
  }
  log(`state: ${stateDir}  responder=${responder}`);

  if (args.reachout) {
    const res = await api.withRetry(() => api.sendHuman(peer, String(args.reachout), `dm-agent-reachout:${me.userId}:${Date.now()}`));
    log(`reachout sent → conversation ${res.conversationId} (recipient: ${res.recipientName})`);
  }

  const watchAgentThread = Boolean(args["watch-agent-thread"]);
  log(watchAgentThread
    ? `watching direct DMs AND the agent thread — expect the cloud agent to answer there too`
    : `watching direct DMs only (pass --watch-agent-thread to also answer in the agent thread)`);

  /**
   * One inbound message, end to end: run a turn, redact, send, advance the cursor.
   * Throws on failure so the caller can count attempts — the retry policy is a property of
   * the loop, not of this step.
   */
  async function handleMessage(message, conv) {
    const preview = String(message.content).slice(0, 120).replace(/\s+/g, " ");
    // Spell out that the sender is a person: the bare conversation type reads as "an agent
    // sent this", and only senderType === "human" rows get this far.
    log(`inbound #${message.id} (from a human, conv ${conv.conversationId}, type=${conv.type}): ${preview}`);

    const inbound = {
      text: String(message.content),
      from: message.senderLabel ?? `@${peer}`,
      conversationId: conv.conversationId,
      createdAt: message.createdAt,
    };
    const reply = responder === "echo"
      ? `[transport-test echo] received #${message.id}: "${String(message.content).slice(0, 200)}"`
      : responder === "codex"
        ? await codex.runTurn(inbound)
        : await agent.runTurn(inbound);

    // Redact before logging, not after: the preview the owner sees should be what was
    // actually sent, and a redirected stdout should not become the one place a withheld
    // value does land on disk.
    const { text: safe, redacted } = redact(reply, collectSecrets(policy.folders, { extra: ownSecrets }));
    log(`reply for #${message.id}: ${safe.slice(0, 120).replace(/\s+/g, " ")}`);
    if (redacted.length) {
      log(`[redact] withheld ${redacted.length} value(s) from the reply (${redacted.map((r) => r.source).join(", ")})`);
    }

    // The peer's thread also receives answers from Aicoo's cloud agent, which replies to the
    // same message within seconds and cannot see this machine. Tag ours so the two are never
    // confused in the app.
    const tagged = args["no-tag"] ? safe : `${args.tag ?? "🖥️ [本地 agent]"} ${safe}`;
    await api.withRetry(() => api.sendHuman(peer, tagged, `dm-agent:${me.userId}:${message.id}`));
    state.setCursor(conv.conversationId, Number(message.id));
    state.clearFailures(message.id);
    log(`reply sent for #${message.id}`);
  }

  // Watched on every reply regardless of where a value came from.
  const ownSecrets = { "your Aicoo key": token };

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
          // Each message succeeds or fails on its own. Letting one throw out of this loop
          // leaves its cursor un-advanced, so the next poll fetches it again — forever — and
          // every message behind it waits on a turn that is never going to work. That is
          // head-of-line blocking, and it is what an unreachable runtime looked like in
          // practice: the same message reprocessed every few seconds indefinitely.
          try {
            await handleMessage(message, conv);
          } catch (error) {
            const attempts = state.recordFailure(message.id);
            const reason = String(error.message ?? error).slice(0, 200);
            log(`reply FAILED for #${message.id} (attempt ${attempts}/${MAX_MESSAGE_ATTEMPTS}): ${reason}`);
            if (attempts < MAX_MESSAGE_ATTEMPTS) break; // leave the cursor; try this one again
            // Out of attempts: say so and move on, rather than retrying in silence forever.
            log(`giving up on #${message.id}; moving past it`);
            await api.withRetry(() => api.sendHuman(
              peer,
              `${args.tag ?? "🖥️ [本地 agent]"} I could not answer that one — my local runtime kept failing (${reason}). Ask again, or ping the owner.`,
              `dm-agent-failed:${me.userId}:${message.id}`,
            )).catch((sendError) => log(`could not report the failure: ${String(sendError.message ?? sendError)}`));
            state.setCursor(conv.conversationId, Number(message.id));
            state.clearFailures(message.id);
          }
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
