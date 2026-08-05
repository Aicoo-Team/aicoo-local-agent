import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Owner approval for tool calls. Two modes, both suspend the turn until decided:
 *  - Interactive TTY: y/N prompt right in the owner's terminal.
 *  - Headless: a pending-approval file is written under the state dir; the owner
 *    resolves it from any terminal with `aicoo-dm-agent approve <id> --allow|--deny`.
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

  constructor({ approvalsDir, timeoutSec = 300, autoAllowRead = false, log = console.log }) {
    this.approvalsDir = approvalsDir;
    this.timeoutSec = timeoutSec;
    this.autoAllowRead = autoAllowRead;
    this.log = log;
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
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return this.#askTty({ toolName, summary, kind });
    }
    return this.#askFile({ toolName, summary, kind });
  }

  async #askTty({ toolName, summary, kind }) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const timeoutController = new AbortController();
    // Ctrl-C at a y/N prompt must return control, not wait out the approval window. Closing
    // the readline interface resolves its question, which is enough to unwind the turn.
    const cancel = () => { try { rl.close(); } catch { /* already closed */ } };
    this.#addWaiter(cancel);
    try {
      process.stdout.write(""); // bell
      const answer = await Promise.race([
        // An out-of-folder read is the one decision the owner must not make on autopilot, so
        // it gets its own banner rather than looking like the reads they have been waving
        // through all session.
        rl.question(`\n== ${BANNERS[kind] ?? BANNERS.exec} ==\n   tool: ${toolName}\n   ${summary}\n   allow? [y/N] (${this.timeoutSec}s, default deny) `),
        delay(this.timeoutSec * 1000, "__timeout__", { signal: timeoutController.signal }).catch(() => "__aborted__"),
      ]);
      if (answer === "__timeout__") {
        this.log(`[approval] timed out after ${this.timeoutSec}s -> deny`);
        return false;
      }
      return /^y(es)?$/i.test(String(answer).trim());
    } finally {
      this.#removeWaiter(cancel);
      timeoutController.abort();
      rl.close();
    }
  }

  async #askFile({ toolName, summary, kind }) {
    const id = randomUUID().slice(0, 8);
    const file = join(this.approvalsDir, `${id}.json`);
    const expiresAt = Date.now() + this.timeoutSec * 1000;
    writeFileSync(file, JSON.stringify({ id, toolName, summary, kind, createdAt: new Date().toISOString(), expiresAt, decision: null }, null, 2));
    this.log(`[approval] PENDING ${id}${kind === "escalation" ? " (OUTSIDE your shared folders)" : ""}: ${toolName} ${summary}`);
    this.log(`[approval]   resolve with: aicoo-dm-agent approve ${id} --allow   (or --deny)`);
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    this.#addWaiter(cancel);
    try {
      while (Date.now() < expiresAt) {
        await delay(500);
        if (cancelled) {
          this.log(`[approval] ${id} -> cancelled (agent stopping)`);
          return false;
        }
        let record;
        try {
          record = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          this.log(`[approval] ${id} file unreadable/removed -> deny`);
          return false;
        }
        if (record.decision === "allow") {
          this.log(`[approval] ${id} -> ALLOWED by owner`);
          return true;
        }
        if (record.decision === "deny") {
          this.log(`[approval] ${id} -> DENIED by owner`);
          return false;
        }
      }
      this.log(`[approval] ${id} timed out after ${this.timeoutSec}s -> deny`);
      return false;
    } finally {
      this.#removeWaiter(cancel);
      rmSync(file, { force: true });
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
