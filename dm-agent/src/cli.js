#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { AicooApi } from "./api.js";
import { LocalDmAgent } from "./agent.js";
import { CodexResponder } from "./codex.js";
import { ApprovalBroker, resolveApproval, listApprovals } from "./approval.js";
import { AgentState } from "./state.js";
import { Policy, PolicyError } from "./policy.js";
import { AuditLog } from "./audit.js";
import { acquireLock, LockError } from "./lock.js";
import { checkModelReachable, explainUnreachable } from "./preflight.js";
import { ReachabilityWatch, respawn } from "./reachability.js";
import { collectSecrets, redact } from "./redact.js";

const DEFAULT_SERVER = "https://www.aicoo.io";
// After this many failed turns a message is answered with an honest failure and left behind.
// Retrying forever is worse than giving up: it burns a turn every poll and blocks the queue.
const MAX_MESSAGE_ATTEMPTS = 3;

/**
 * Everything the agent says also lands in <state-dir>/agent.log.
 *
 * The terminal is the wrong and only place to have to be. An owner who started the agent in a
 * window they have since closed, or scrolled past, has no way to see what a visitor asked or
 * what is waiting on them — and nothing outside this process can watch for it either. A file
 * next to the state gives both: the owner can look back, and a monitor can tail it.
 */
let logFd = null;
let logPath = null;

function setLogFile(path) {
  if (logPath === path) return; // start resolves the dir twice; do not open the file twice
  logPath = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // A log that grows without bound eventually becomes the reason someone stops keeping it.
    if (existsSync(path) && statSync(path).size > 5_000_000) renameSync(path, `${path}.1`);
    logFd = openSync(path, "a");
  } catch {
    logFd = null;
  }
}

/**
 * Written synchronously, deliberately.
 *
 * A buffered stream loses whatever has not flushed when process.exit() runs, and the lines
 * that immediately precede an exit are the only ones that explain it: FATAL on a rejected key,
 * the lock conflict naming the process to stop, and "replacing this process" before a restart.
 * A real restart test produced four startups and zero explanations for exactly this reason —
 * the agent appeared to reboot itself for no stated reason. The volume here is a few lines a
 * minute, so a synchronous write costs nothing worth measuring.
 */
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  if (logFd === null) return;
  try {
    writeSync(logFd, `${stamped}\n`);
  } catch {
    // A broken log must never take the agent down with it — this is a convenience, not the job.
    logFd = null;
  }
}

/**
 * stdio for a spawned replacement: stderr into our log, stdout discarded.
 *
 * stdout would duplicate every line — log() already writes the file itself — but stderr is a
 * genuine gap: console.error on a fatal, and anything Node prints on its way down, happen
 * where log() cannot reach. Sending only stderr keeps the crash and loses the echo.
 */
function logStdio() {
  return logFd === null ? "ignore" : ["ignore", "ignore", logFd];
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
  aicoo-dm-agent connect --peer <username>                     friend-request them, so they
                                                               can open your agent and ask it
  aicoo-dm-agent approve <id> --allow|--deny --peer <peer>     resolve a pending tool approval
  aicoo-dm-agent pending --peer <peer>                         list pending tool approvals
                 (share links have no peer: pass --state-dir <dir> instead, the one you started with)
  aicoo-dm-agent grants --peer <peer> [--revoke <key>]         standing capability grants
                                     [--revoke-all]           (what you already said yes to)
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
  --dm-only                answer only in the plain DM thread. Replies still land in the
                           agent thread (the API cannot post into a DM), so the asker sees
                           the answer somewhere other than where they typed. Rarely wanted.
  --policy <file>          folders, commands, capabilities, trust (default: <state-dir>/policy.json)
  --link-label <name>      for a guest policy: which share link this is, so the approval
                           prompt says which one you are answering for
  --no-sandbox             run the model's file tools unsandboxed (only if the platform
                           cannot start one — the default is to fail rather than pretend)
  --skip-preflight         start without checking the model is reachable first
  --state-dir <dir>        override state directory
`);
}

/**
 * Wait for Aicoo to be reachable rather than dying because it is not.
 *
 * The poll loop has always tolerated a failed request; startup did not, and `identity()` is the
 * first thing it does. That asymmetry turned the self-restart into a killer: the agent replaces
 * itself BECAUSE it cannot reach Aicoo, and the replacement then needs to reach Aicoo to boot.
 * The first real one exited silently and left the machine with no agent at all — strictly worse
 * than the outage it was recovering from.
 *
 * Retries forever on purpose. A process sitting here waiting is useful the moment the network
 * comes back; a process that gave up is not, and nothing is going to restart it.
 */
async function reachAicoo(fn, { log, firstDelayMs = 2000, maxDelayMs = 60_000 } = {}) {
  let wait = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // A rejected key is not going to start working, and retrying it forever hides the one
      // thing the owner has to fix.
      if (error?.status === 401 || error?.status === 403) throw error;
      log(`cannot reach Aicoo to start up (attempt ${attempt}): ${String(error.message ?? error)}`);
      log(`   waiting ${Math.round(wait / 1000)}s and trying again — nothing is lost, and Ctrl-C still stops it`);
      await delay(wait);
      wait = Math.min(wait * 2, maxDelayMs);
    }
  }
}

/**
 * How the person on the other end is named in the approval prompt and to the model.
 *
 * A named peer is a username. A guest is not — they are whoever opened a particular link, so
 * the useful identifier is WHICH link. With several out at once, "a peer" tells the owner
 * nothing about what they are approving, and the label is the only thing distinguishing
 * "someone from the investor link" from "someone from the contractor link".
 */
function peerLabelFor(peer, policy, linkLabel) {
  if (!policy.isGuest) return `@${peer}`;
  return linkLabel ? `a visitor via your "${linkLabel}" link` : `a visitor via your share link`;
}

/**
 * What to tell someone when a message could not be answered.
 *
 * "The agent kept failing" was the only thing it ever said, and it was usually a lie: the
 * common case is a turn that ran out of time while its owner was away from the terminal, or
 * a machine that cannot reach the model at all. Blaming the agent sends the asker off to
 * retry something that will fail again the same way, and tells the owner nothing.
 */
function describeGiveUp(error) {
  const message = String(error?.message ?? error ?? "");
  if (error?.name === "AbortError" || /abort/i.test(message)) {
    return "I ran out of time on that one before it finished — usually because the owner was away from the terminal where approvals appear. Your question is saved; ask again once they are back.";
  }
  if (error?.code === "timeout" || /timed out/i.test(message)) {
    return "I could not reach my own service in time. Your question is saved — the owner needs to check the machine's connection.";
  }
  if (/credit|quota|402/i.test(message)) {
    return "The owner's account cannot pay for this right now. Your question is saved until they top it up.";
  }
  return "I could not answer that one — something on the owner's machine kept failing. Your question is saved; they will need to look at it.";
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
    // A share-link agent has no peer — the visitor is a stranger by design. Demanding one made
    // the file channel unusable in the one mode it matters most for, even though stateDirFor
    // only needs a peer when it has to derive the path itself.
    if (!peer && !args["state-dir"]) {
      throw new Error(
        "need --peer <peer>, or --state-dir <dir> for a share-link agent (use the same --state-dir you started it with)",
      );
    }
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

  // ── grants: what this peer has been permanently allowed, and taking it back ──
  // A standing grant the owner cannot see is worse than no grant: they consented once, months
  // ago, to a sentence they no longer remember. Listing and revoking is the other half of
  // "ask once".
  if (command === "grants") {
    const peer = args.peer;
    if (!peer) throw new Error("--peer is required (grants are per relationship)");
    const dir = stateDirFor({ server, me: args.me ?? "me", peer, override: args["state-dir"] });
    const state = new AgentState(join(dir, "state.json"));
    if (args.revoke === true) throw new Error('--revoke needs a key, or use --revoke-all');
    if (args["revoke-all"]) {
      state.clearGrants();
      console.log(`revoked every standing grant for @${peer}. They will be asked again next time.`);
      return;
    }
    if (args.revoke) {
      state.clearGrants(String(args.revoke));
      console.log(`revoked ${args.revoke} for @${peer}.`);
      return;
    }
    const grants = state.listGrants();
    if (!grants.length) return console.log(`@${peer} has no standing grants — everything still asks.`);
    for (const g of grants) console.log(`${g.decision === "allow" ? "allow" : "DENY "}  ${g.key}   (decided ${String(g.at).slice(0, 10)})`);
    console.log(`\nrevoke one with: aicoo-dm-agent grants --peer ${peer} --revoke "<key>"`);
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
      peerLabel: peerLabelFor(args.peer ?? "a peer", policy, args["link-label"]),
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
  // A cold serverless database behind the API can take well over the default 15s, and the
  // abort message ("This operation was aborted") reads like a bug in the agent rather than a
  // slow round trip. Configurable, so the answer to a slow backend is not "give up".
  const api = new AicooApi({ baseUrl: server, token, log, timeoutMs: Number(args["api-timeout"] ?? 15) * 1000 });

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

  // ── connect: make sure the peer can actually reach this agent ──
  // Someone who is not a contact has no way to open your agent in the app, so the loop would
  // sit online answering nothing. Checking first, and saying plainly whose move it is, beats
  // discovering it during a demo.
  if (command === "connect") {
    if (!args.peer) throw new Error("usage: connect --peer <their Aicoo username>");
    const peer = String(args.peer).replace(/^@/, "");
    const contacts = await api.contacts();
    if (contacts.some((c) => c.username?.toLowerCase() === peer.toLowerCase())) {
      console.log(`@${peer} is already connected — they can open your agent and ask it anything.`);
      return;
    }
    let res;
    try {
      res = await api.requestFriend(peer);
    } catch (error) {
      // The predictable wrong answer here is an email address, because that is how people
      // refer to each other. Naming that specifically saves a round of confusion.
      if (error.code === "not_found") {
        const hint = peer.includes("@") || peer.includes(".")
          ? `That looks like an email. Aicoo wants their *username* — they can read it off their own profile.`
          : `Check the spelling — Aicoo wants their username, which is not always their display name.`;
        throw new Error(`No Aicoo user named "${peer}". ${hint}`);
      }
      throw error;
    }
    if (res.already === "pending") {
      console.log(`A request to @${peer} is already waiting. Nothing more to send — they have to accept it in Aicoo.`);
    } else {
      console.log(`Friend request sent to @${peer}.`);
    }
    console.log(`Next: ask them to accept it at https://www.aicoo.io, then open your agent and type a question.`);
    return;
  }

  if (command !== "start") {
    usage();
    throw new Error(`unknown command: ${command}`);
  }

  // ── start: the main loop ──
  // When the dir was given outright there is no reason to wait for identity() to start keeping
  // the log — the lines before that point are the ones explaining a failure to come up at all.
  if (args["state-dir"]) setLogFile(join(args["state-dir"], "agent.log"));
  const workspace = args.workspace ?? process.cwd();
  const pollMs = Number(args.poll ?? 3000);
  // The policy has to be read before --peer is validated: a share-link policy answers whoever
  // holds a link, so there is no named peer to require.
  const earlyPolicy = loadPolicy(args.policy ?? join(stateDirFor({ server, me: "unknown", peer: args.peer ?? "guest", override: args["state-dir"] }), "policy.json"), workspace);
  const peer = args.peer ?? (earlyPolicy.isGuest ? "guest" : undefined);
  if (!peer) throw new Error("--peer is required (or set \"trust\": \"guest\" in the policy to answer share links)");

  const me = await reachAicoo(() => api.identity(), { log });
  log(`agent online as @${me.username} (${me.userId}), ${earlyPolicy.isGuest ? "answering share links" : `peer=${peer}`}, workspace=${workspace}`);

  // An agent that is online but unreachable looks identical to one that is working, right up
  // until the person you are demoing to types and nothing happens. Say it at startup instead.
  // A share link needs no contact — that is the whole point of one.
  if (!earlyPolicy.isGuest) {
    try {
      const contacts = await api.contacts();
      const bare = String(peer).replace(/^@/, "").toLowerCase();
      if (!contacts.some((c) => c.username?.toLowerCase() === bare)) {
        log(`WARNING: @${peer} is not a contact yet, so they cannot open your agent in Aicoo.`);
        log(`         Run: aicoo-dm-agent connect --peer ${peer}   (then they accept it in the app)`);
      }
    } catch (error) {
      log(`[network] could not check whether @${peer} is a contact: ${error.message}`);
    }
  }

  const stateDir = stateDirFor({ server, me: me.username, peer, override: args["state-dir"] });
  mkdirSync(stateDir, { recursive: true });
  // From here on, everything logged is also readable from outside this process — see setLogFile.
  setLogFile(join(stateDir, "agent.log"));

  // One agent per state directory, claimed before anything else touches it.
  let releaseLock = () => {};
  try {
    releaseLock = acquireLock(stateDir, { log });
  } catch (error) {
    if (error instanceof LockError) {
      log(`FATAL: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  process.on("exit", () => releaseLock());
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
    peerLabel: peerLabelFor(peer, policy, args["link-label"]),
    ownerId: me.userId,
    deviceId: state.deviceId(),
    // A share-link visitor has no identity to record — that is the point of the link, and
    // writing the label in here would dress a guess up as one. The conversation id on each
    // audit line is what distinguishes them.
    peerId: policy.isGuest ? null : peer,
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
        peerLabel: peerLabelFor(peer, policy, args["link-label"]),
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

  // Prove the runtime can answer before telling anyone this agent is online. An agent that
  // prints a healthy banner and then fails every message is indistinguishable from a working
  // one until someone is already waiting on it — which is exactly how a network block cost
  // three debugging sessions before anybody could see the cause.
  if (responder === "agent" && !args["skip-preflight"]) {
    const reach = await checkModelReachable();
    if (!reach.ok) {
      log(`FATAL: ${explainUnreachable(reach)}`);
      log(`   (start with --skip-preflight to bypass this check)`);
      releaseLock();
      process.exit(1);
    }
    log(reach.skipped
      ? `could not run the reachability check (${reach.reason}) — starting anyway`
      : `api.anthropic.com reachable (HTTP ${reach.status})`);
  }

  if (args.reachout) {
    const res = await api.withRetry(() => api.sendHuman(peer, String(args.reachout), `dm-agent-reachout:${me.userId}:${Date.now()}`));
    log(`reachout sent → conversation ${res.conversationId} (recipient: ${res.recipientName})`);
  }

  // Replies can only be written to the agent thread: POST /api/v1/agent/message takes a
  // username, a userId or group:N, and always lands in the shared_agent conversation. There
  // is no way to post into a `direct` DM. Watching direct-only therefore read the question
  // in one thread and answered in another — the asker saw silence where they had typed.
  // So the agent thread is the default, and it is also where a peer naturally goes to talk
  // to someone's agent. The cost is that the cloud agent answers there too; the 🖥️ tag on
  // our reply is what tells the two apart.
  const dmOnly = Boolean(args["dm-only"]);
  const watchAgentThread = !dmOnly;
  if (!policy.isGuest) {
    log(dmOnly
      ? `watching direct DMs only (--dm-only) — note replies still land in the agent thread`
      : `watching the agent thread and direct DMs; replies land in the agent thread, tagged 🖥️`);
  }

  /**
   * One inbound message, end to end: run a turn, redact, send, advance the cursor.
   * Throws on failure so the caller can count attempts — the retry policy is a property of
   * the loop, not of this step.
   */
  /**
   * Run one turn and produce exactly the text that will leave the machine.
   *
   * Shared by the DM path and the share-link path so the egress filter cannot end up applied
   * on one and forgotten on the other — a redactor that covers most of the exits is not a
   * redactor. Redaction happens before the log line too: the owner's preview should be what
   * was actually sent, and a redirected stdout should not become the one place a withheld
   * value lands on disk.
   */
  async function composeReply(inbound, id) {
    const reply = responder === "echo"
      ? `[transport-test echo] received #${id}: "${inbound.text.slice(0, 200)}"`
      : responder === "codex"
        ? await codex.runTurn(inbound)
        : await agent.runTurn(inbound);

    const { text: safe, redacted } = redact(reply, collectSecrets(policy.folders, { extra: ownSecrets }));
    log(`reply for #${id}: ${safe.slice(0, 120).replace(/\s+/g, " ")}`);
    if (redacted.length) {
      log(`[redact] withheld ${redacted.length} value(s) from the reply (${redacted.map((r) => r.source).join(", ")})`);
    }
    return safe;
  }

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
    const safe = await composeReply(inbound, message.id);

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
  // Ctrl-C has to actually stop it. Setting a flag only ends the loop after the current
  // iteration, and that iteration may be parked for fifteen minutes waiting on an approval
  // nobody is going to give — so the first signal also abandons whatever is in flight, and a
  // second one leaves immediately for anyone who does not want to wait even that long.
  const stop = (signal) => {
    if (stopping) {
      log(`second ${signal} — exiting now`);
      releaseLock();
      process.exit(130);
    }
    stopping = true;
    log(`${signal} — stopping (press again to exit immediately)`);
    agent?.abortInFlight?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Being briefly unreachable is ordinary — roughly 0.3% of polls fail on a normal day. Staying
  // unreachable is not, and used to go entirely unhandled: a three-day-old agent failed every
  // poll for 37 minutes while a fresh process reached the same endpoint in 670ms.
  const reach = new ReachabilityWatch({
    warnAfterMs: Number(args["warn-after"] ?? 120) * 1000,
    restartAfterMs: args["no-self-restart"] ? Infinity : Number(args["restart-after"] ?? 300) * 1000,
    // Inherited from disk, because a restart is exactly what erases in-memory rate limits.
    priorRestarts: state.recentRestarts(),
    onRestart: () => state.noteRestart(),
  });
  const priorRestarts = state.recentRestarts();
  if (priorRestarts.length) {
    log(`note: this agent has replaced itself ${priorRestarts.length}x in the last hour (most recently ${new Date(Math.max(...priorRestarts)).toISOString()})`);
  }
  // "0m" is what a 40-second outage rounds to, and it reads as "no time at all" next to a
  // warning that something is wrong. Say seconds when it is seconds.
  const forHuman = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
  const notePollOk = () => {
    const { recovered, downForMs } = reach.ok();
    if (recovered) log(`reachable again — Aicoo was unreachable for ${forHuman(downForMs)}`);
  };
  // `alreadyLogged` exists because the named-peer loop prints a richer line of its own (401
  // handling, the proxy hint) and printing the raw error twice per poll would bury both.
  const notePollFail = (error, { alreadyLogged = false } = {}) => {
    if (!alreadyLogged) log(`[poll] ${String(error.message ?? error)}`);
    const { action, downForMs, reason } = reach.fail();
    const mins = forHuman(downForMs);
    if (action === "warn") {
      log(`WARNING: cannot reach Aicoo — ${mins} and counting. Nothing is lost; visitors are waiting. Still retrying.`);
    } else if (action === "stuck") {
      log(`WARNING: still cannot reach Aicoo after ${mins}, and not restarting again (${reason}). This looks like the network or Aicoo, not this process — check both.`);
    } else if (action === "restart") {
      log(`unreachable for ${mins} — that is no longer a blip.`);
      reach.noteRestart();
      respawn({ releaseLock, log, spawn, exit: (code) => process.exit(code), stdio: logStdio() });
    }
  };

  // ── Share-link mode ──
  // A guest policy means this machine is answering visitors on a link rather than one named
  // person, so it polls the guest queue instead of conversations. Same turn, same gate, same
  // egress filter; only the transport differs.
  if (policy.isGuest) {
    log(`share-link mode: answering visitors on links you pointed at this machine`);
    let announced = false;
    while (!stopping) {
      try {
        const cursor = state.cursor("guest") ?? 0;
        const { links, messages } = await api.guestMessages(cursor);
        notePollOk();
        if (!announced) {
          announced = true;
          log(links.length
            ? `links routed here: ${links.map((l) => l.label ?? l.shareToken).join(", ")}`
            : `no links point here yet — create one in Aicoo and set it to answer from this machine`);
        }
        // Only questions. Assistant rows are our own past replies, returned so a restart can
        // advance past them rather than treating the whole history as a backlog.
        const fresh = messages
          .filter((m) => m.role === "user")
          .sort((a, b) => Number(a.id) - Number(b.id));
        const maxId = messages.length ? Math.max(...messages.map((m) => Number(m.id))) : cursor;

        for (const message of fresh) {
          try {
            const who = message.linkLabel ? `"${message.linkLabel}" link` : "a share link";
            log(`inbound guest #${message.id} (via ${who}): ${String(message.content).slice(0, 100).replace(/\s+/g, " ")}`);
            const safe = await composeReply({
              text: String(message.content),
              from: `a visitor via your ${who}`,
              conversationId: message.sessionId,
              createdAt: message.createdAt,
            }, message.id);
            await api.withRetry(() => api.replyToGuest(message.sessionId, safe));
            state.setCursor("guest", Number(message.id));
            state.clearFailures(message.id);
            log(`reply sent for guest #${message.id}`);
          } catch (error) {
            const attempts = state.recordFailure(message.id);
            log(`guest #${message.id} failed (attempt ${attempts}/${MAX_MESSAGE_ATTEMPTS}): ${String(error.message ?? error)}`);
            if (attempts < MAX_MESSAGE_ATTEMPTS) break; // leave the cursor; try again
            log(`giving up on guest #${message.id}; moving past it`);
            await api.withRetry(() => api.replyToGuest(
              message.sessionId,
              describeGiveUp(error),
            )).catch(() => {});
            state.setCursor("guest", Number(message.id));
            state.clearFailures(message.id);
          }
        }
        // Nothing to answer: still move past our own replies so they are not re-fetched.
        if (!fresh.length && maxId > cursor) state.setCursor("guest", maxId);
      } catch (error) {
        notePollFail(error);
      }
      await delay(pollMs);
    }
    return;
  }

  while (!stopping) {
    try {
      const conversations = (await api.conversations({ view: "all", contact: peer, limit: 50 }))
        // Direct DMs only, by default. In the peer's *agent* thread their cloud agent
        // already answers every message, so listening there too means one question gets
        // two different answers. Keeping to the DM makes the split legible: the DM
        // reaches the machine, the agent thread reaches the cloud.
        .filter((c) => (watchAgentThread ? c.type !== "group" : c.type === "direct"));
      notePollOk();
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
              `${args.tag ?? "🖥️ [本地 agent]"} ${describeGiveUp(error)}`,
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
      notePollFail(error, { alreadyLogged: true });
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
  const message = `error: ${error?.message ?? error}`;
  // stderr for a person at a terminal — that is where CLI errors belong, and the tests read it
  // there. The file as well, because a replacement process is spawned without one: a real
  // self-restart died at startup and left seven lines in the log, no cause, and no agent.
  console.error(message);
  if (logFd !== null) {
    try {
      writeSync(logFd, `[${new Date().toISOString()}] FATAL: ${error?.stack ?? message}\n`);
    } catch { /* the log is a convenience; the exit code is the contract */ }
  }
  process.exit(1);
});
