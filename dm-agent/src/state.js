import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable client state: the provider session id (conversation memory across turns), the
 * per-conversation cursor (last processed inbound message — prevents history replay on
 * restart and double-processing), and how many times a message has failed.
 *
 * The failure count is persisted on purpose. A restart that forgot it would re-enter the
 * same loop from the top, which is exactly the shape of the bug it exists to stop.
 */
export class AgentState {
  constructor(file) {
    this.file = file;
    this.data = { sessionId: null, cursors: {}, failures: {} };
    try {
      this.data = { sessionId: null, cursors: {}, failures: {}, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      /* first run */
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  cursor(convId) {
    return this.data.cursors[convId] ?? null;
  }

  /** How many times this message has failed to produce a reply. */
  failures(messageId) {
    return this.data.failures[messageId] ?? 0;
  }

  recordFailure(messageId) {
    const count = this.failures(messageId) + 1;
    this.data.failures[messageId] = count;
    this.save();
    return count;
  }

  /** Forget a message once it is behind us, so the map cannot grow without bound. */
  clearFailures(messageId) {
    if (this.data.failures[messageId] === undefined) return;
    delete this.data.failures[messageId];
    this.save();
  }

  setCursor(convId, messageId) {
    this.data.cursors[convId] = messageId;
    this.save();
  }

  get sessionId() {
    return this.data.sessionId;
  }

  set sessionId(value) {
    this.data.sessionId = value;
    this.save();
  }
}
