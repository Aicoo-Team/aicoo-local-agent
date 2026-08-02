import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable client state: provider session id (conversation memory across turns)
 * and per-conversation cursors (last processed inbound message id — prevents
 * history replay on restart and double-processing).
 */
export class AgentState {
  constructor(file) {
    this.file = file;
    this.data = { sessionId: null, cursors: {} };
    try {
      this.data = { sessionId: null, cursors: {}, ...JSON.parse(readFileSync(file, "utf8")) };
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
