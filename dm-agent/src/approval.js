import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Owner approval for tool calls. Every question is published two ways at once and suspends the
 * turn until one of them answers:
 *  - a y/N prompt in the owner's terminal, when the agent has one;
 *  - a pending-approval file under the state dir, resolvable from anywhere with
 *    `aicoo-dm-agent approve <id> --allow|--deny`.
 *
 * Both channels are always open. Earlier this was either/or, keyed off isTTY, which meant the
 * owner had to be sitting at the terminal that happened to start the agent — the one place they
 * are least likely to be while someone else is using their machine. Whichever channel answers
 * first wins; the other is torn down in the same finally.
 *
 * No decision within timeoutSec -> deny (fail closed).
 */
/**
 * The banner is the part an owner reads at a glance after the tenth prompt, so each kind of
 * decision gets its own rather than blurring into the reads they have been waving through.
 */
const BANNERS = {
  exec: "OWNER APPROVAL REQUIRED",
  read: "OWNER APPROVAL REQUIRED",
  capability: "OWNER APPROVAL REQUIRED",
  escalation: "OUTSIDE YOUR SHARED FOLDERS",
};

export class ApprovalBroker {
  /** Resolvers for questions currently waiting, so Ctrl-C does not have to outlast them. */
  #waiting = new Set();

  /**
   * Abandon every open question, denying each. Called when the owner stops the agent: a
   * pending approval can be a fifteen-minute wait, and nobody expects Ctrl-C to sit through it.
   */
  cancelPending() {
    for (const cancel of this.#waiting) cancel();
    this.#waiting.clear();
  }

  #addWaiter(fn) { this.#waiting.add(fn); }
  #removeWaiter(fn) { this.#waiting.delete(fn); }

  /**
   * @param {object} options
   * @param {Function|null} [options.prompt] Override the terminal channel. Receives
   *   ({toolName, summary, kind, timeoutSec, signal}) and resolves "allow"/"deny", or never
   *   resolves if that channel has nothing to say. Pass null to run file-only. Defaults to the
   *   readline prompt when stdin/stdout are a TTY, and to file-only when they are not.
   */
  constructor({ approvalsDir, timeoutSec = 300, autoAllowRead = false, log = console.log, prompt }) {
    this.approvalsDir = approvalsDir;
    this.timeoutSec = timeoutSec;
    this.autoAllowRead = autoAllowRead;
    this.log = log;
    this.prompt = prompt === undefined
      ? (process.stdin.isTTY && process.stdout.isTTY ? (req) => this.#askTty(req) : null)
      : prompt;
    mkdirSync(approvalsDir, { recursive: true });
    this.#sweepOrphans();
  }

  /**
   * A killed process never runs its cleanup, so its pending files outlive the turn
   * that was waiting on them. They would otherwise show up in `pending` forever and
   * invite the owner to approve a call nobody is waiting for.
   */
  #sweepOrphans() {
    for (const record of listApprovals(this.approvalsDir)) {
      rmSync(join(this.approvalsDir, `${record.id}.json`), { force: true });
      this.log(`[approval] swept orphaned request ${record.id} (${record.toolName}) from a previous run`);
    }
  }

  /**
   * @param {{toolName: string, summary: string, kind?: "read"|"exec"}} request
   *   `kind` defaults to "exec" — the cautious reading — so a caller that forgets to say
   *   what it is asking about can never accidentally inherit the read shortcut.
   */
  async ask({ toolName, summary, kind = "exec" }) {
    // --auto-allow-read means reads, and only reads, *inside the shared folders*. Neither a
    // command nor a step outside those folders is what the owner agreed to when they said
    // "don't ask me about the folder I shared" — kind "escalation" deliberately misses here.
    if (this.autoAllowRead && kind === "read") {
      this.log(`[approval] auto-allowed (--auto-allow-read): ${toolName} ${summary}`);
      return true;
    }

    const id = randomUUID().slice(0, 8);
    const file = join(this.approvalsDir, `${id}.json`);
    const expiresAt = Date.now() + this.timeoutSec * 1000;
    writeFileSync(file, JSON.stringify(
      { id, toolName, summary, kind, createdAt: new Date().toISOString(), expiresAt, decision: null },
      null,
      2,
    ));
    this.log(`[approval] PENDING ${id}${kind === "escalation" ? " (OUTSIDE your shared folders)" : ""}: ${toolName} ${summary}`);
    this.log(`[approval]   resolve with: aicoo-dm-agent approve ${id} --allow   (or --deny)`);

    const stop = new AbortController();
    let cancelled = false;
    const cancel = () => { cancelled = true; stop.abort(); };
    this.#addWaiter(cancel);
    try {
      const racers = [this.#watchFile({ id, file, expiresAt, isCancelled: () => cancelled })];
      if (this.prompt) {
        racers.push(
          Promise.resolve(this.prompt({ toolName, summary, kind, timeoutSec: this.timeoutSec, signal: stop.signal }))
            // A closed readline settles its question with nothing. That is not a decision — it
            // means the other channel got there first, so leave the race to whoever did.
            .then((answer) => (answer === undefined || answer === null ? new Promise(() => {}) : answer))
            .catch(() => new Promise(() => {})),
        );
      }
      const outcome = await Promise.race(racers);
      if (outcome === "allow") this.log(`[approval] ${id} -> ALLOWED by owner`);
      else if (outcome === "cancelled") this.log(`[approval] ${id} -> cancelled (agent stopping)`);
      else if (outcome === "timeout") this.log(`[approval] ${id} timed out after ${this.timeoutSec}s -> deny`);
      else this.log(`[approval] ${id} -> DENIED by owner`);
      return outcome === "allow";
    } finally {
      this.#removeWaiter(cancel);
      // Tears down the terminal prompt when the file answered first, and vice versa.
      stop.abort();
      rmSync(file, { force: true });
    }
  }

  /** The file channel: poll our own pending record until someone writes a decision into it. */
  async #watchFile({ id, file, expiresAt, isCancelled }) {
    while (Date.now() < expiresAt) {
      await delay(500);
      if (isCancelled()) return "cancelled";
      let record;
      try {
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.log(`[approval] ${id} file unreadable/removed -> deny`);
        return "deny";
      }
      if (record.decision === "allow") return "allow";
      if (record.decision === "deny") return "deny";
    }
    return "timeout";
  }

  /** The terminal channel. Resolves undefined when closed out from under us — see the race. */
  async #askTty({ toolName, summary, kind, timeoutSec, signal }) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const close = () => { try { rl.close(); } catch { /* already closed */ } };
    signal?.addEventListener("abort", close, { once: true });
    try {
      process.stdout.write(""); // bell
      const answer = await rl.question(
        // An out-of-folder read is the one decision the owner must not make on autopilot, so
        // it gets its own banner rather than looking like the reads they have been waving
        // through all session.
        `\n== ${BANNERS[kind] ?? BANNERS.exec} ==\n   tool: ${toolName}\n   ${summary}\n   allow? [y/N] (${timeoutSec}s, default deny) `,
      );
      if (answer === undefined || answer === null) return undefined;
      return /^y(es)?$/i.test(String(answer).trim()) ? "allow" : "deny";
    } finally {
      signal?.removeEventListener?.("abort", close);
      close();
    }
  }
}

/** CLI side: resolve a pending approval by id. */
export function resolveApproval({ approvalsDir, id, decision }) {
  const file = join(approvalsDir, `${id}.json`);
  if (!existsSync(file)) {
    const pending = existsSync(approvalsDir) ? readdirSync(approvalsDir).filter((f) => f.endsWith(".json")) : [];
    throw new Error(`No pending approval ${id}. Pending: ${pending.length ? pending.map((f) => f.replace(".json", "")).join(", ") : "(none)"}`);
  }
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.decision = decision;
  writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

/** CLI side: list pending approvals. */
export function listApprovals(approvalsDir) {
  if (!existsSync(approvalsDir)) return [];
  return readdirSync(approvalsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(approvalsDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
