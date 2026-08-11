import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * Append-only record of every gate decision.
 *
 * While approval is per-call the terminal is the record. The moment a standing grant
 * exists, this file is the only way anyone answers "what has that person's agent actually
 * read from my machine?" — so it is written from the start, and it records the rule that
 * decided, not just the outcome.
 */
export class AuditLog {
  /**
   * @param {object} [o]
   * @param {import("./outbox.js").Outbox} [o.outbox] queue a copy for upload. The file is still
   *   the record — the outbox is a follower, and losing it costs delivery, not history.
   */
  constructor(file, { log, outbox } = {}) {
    this.file = file;
    this.log = log;
    this.outbox = outbox ?? null;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* the audit never fails a turn */
    }
  }

  record(entry) {
    // Stamped once and shared by both copies: it is the dedupe key on the server, so the file
    // and the queued row have to agree on it even across a retry.
    const row = { at: new Date().toISOString(), clientEventId: randomUUID(), ...entry };
    try {
      appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    } catch (error) {
      this.log?.(`[audit] could not write: ${String(error.message ?? error)}`);
    }
    // Writing the file first, deliberately. If queuing throws, the record still exists locally;
    // the reverse would mean uploading something that was never written down here.
    this.outbox?.add({ ...row, track: "dm", occurredAt: row.at });
  }
}
