import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Rows waiting to reach Aicoo, kept apart from the audit file they were copied from.
 *
 * The obvious design — remember "uploaded up to line N of audit.jsonl" — breaks the first time
 * that file rotates past 5MB, because line N then points at completely different content and
 * the agent either skips a stretch or re-sends one, silently either way. This file is only
 * ever appended to and rewritten shorter, so rotation of the audit log cannot reach it.
 *
 * The audit file remains authoritative. Nothing here is a second copy of the truth: if the
 * outbox is deleted, some rows never reach the server and the local record is still complete.
 */

/** Beyond this, the oldest rows are dropped. A month offline should not fill someone's disk. */
const MAX_PENDING = 50_000;
/** One poll carries at most this much. The message poll is a hot path; a backlog must not stall it. */
const MAX_BATCH_ROWS = 50;
const MAX_BATCH_BYTES = 64 * 1024;
/** A row the server keeps refusing is dropped rather than retried into eternity. */
const MAX_ATTEMPTS = 5;

export class Outbox {
  #file;
  #log;
  #pending = [];
  #loaded = false;

  constructor(file, { log = () => {} } = {}) {
    this.#file = file;
    this.#log = log;
  }

  #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const text = readFileSync(this.#file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.#pending.push(JSON.parse(line));
        } catch {
          // A half-written final line is what a killed process leaves behind. Skip it rather
          // than refusing to load everything before it.
        }
      }
    } catch {
      /* first run */
    }
  }

  get size() {
    this.#load();
    return this.#pending.length;
  }

  /** Queue one row. Never throws: a full disk must not stop the agent from answering. */
  add(row) {
    this.#load();
    try {
      this.#pending.push(row);
      if (this.#pending.length > MAX_PENDING) {
        const dropped = this.#pending.length - MAX_PENDING;
        this.#pending.splice(0, dropped);
        this.#log(`[outbox] dropped ${dropped} oldest pending row(s) — backlog over ${MAX_PENDING}`);
        this.#rewrite();
        return;
      }
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      appendFileSync(this.#file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch (error) {
      this.#log(`[outbox] could not queue a row: ${String(error.message ?? error)}`);
    }
  }

  /**
   * The next batch to send, bounded by both count and bytes — fifty rows of a long question is
   * a much bigger request than fifty of a short one, and this rides a three-second poll.
   */
  nextBatch() {
    this.#load();
    const batch = [];
    let bytes = 0;
    for (const row of this.#pending) {
      const size = JSON.stringify(row).length;
      if (batch.length && (batch.length >= MAX_BATCH_ROWS || bytes + size > MAX_BATCH_BYTES)) break;
      batch.push(row);
      bytes += size;
    }
    return batch;
  }

  /**
   * Remove what the server confirmed, and give up on what it refused.
   *
   * "Rejected" and "failed" are different answers. A rejected row will never be accepted, so
   * retrying it forever wedges everything behind it — that is the poison pill. A row that was
   * merely not confirmed stays, and is counted: if the server keeps quietly not taking it, it
   * is dropped after a few attempts for the same reason.
   */
  settle({ accepted = [], rejected = [], attempted = [] } = {}) {
    this.#load();
    const done = new Set([
      ...accepted,
      ...rejected.map((r) => (typeof r === "string" ? r : r?.clientEventId)).filter(Boolean),
    ]);
    for (const r of rejected) {
      if (typeof r === "object" && r?.reason) {
        this.#log(`[outbox] server refused ${r.clientEventId}: ${r.reason} — dropping it`);
      }
    }

    const tried = new Set(attempted);
    let givenUp = 0;
    this.#pending = this.#pending.filter((row) => {
      if (done.has(row.clientEventId)) return false;
      if (!tried.has(row.clientEventId)) return true;
      row.attempts = (row.attempts ?? 0) + 1;
      if (row.attempts >= MAX_ATTEMPTS) {
        givenUp += 1;
        return false;
      }
      return true;
    });
    if (givenUp) {
      this.#log(`[outbox] gave up on ${givenUp} row(s) after ${MAX_ATTEMPTS} attempts — the rest keep flowing`);
    }
    this.#rewrite();
  }

  /** Rewrite via a temp file: a crash mid-write must not leave a truncated outbox. */
  #rewrite() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, this.#pending.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      this.#log(`[outbox] could not rewrite: ${String(error.message ?? error)}`);
    }
  }
}

export { MAX_PENDING, MAX_BATCH_ROWS, MAX_BATCH_BYTES, MAX_ATTEMPTS };
