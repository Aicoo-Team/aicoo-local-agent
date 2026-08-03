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
    this.data = { sessionId: null, cursors: {}, failures: {}, grants: {} };
    try {
      this.data = { sessionId: null, cursors: {}, failures: {}, grants: {}, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      /* first run */
    }
  }

  /**
   * Standing decisions for this peer, keyed by what was actually decided about — a skill by
   * name, an MCP tool by server and tool, a shell command by its exact text. Asking once per
   * distinct capability is the point; asking every time is how a gate becomes a formality the
   * owner clicks through.
   *
   * Denials are remembered too. Re-asking something the owner already refused is how a peer
   * wears them down, and it is the same question either way.
   */
  grant(key) {
    return this.data.grants[key] ?? null;
  }

  setGrant(key, decision) {
    this.data.grants[key] = { decision, at: new Date().toISOString() };
    this.save();
  }

  listGrants() {
    return Object.entries(this.data.grants).map(([key, v]) => ({ key, ...v }));
  }

  clearGrants(key) {
    if (key) delete this.data.grants[key];
    else this.data.grants = {};
    this.save();
  }

  /**
   * 0600, and 0700 on the directory: this file holds the standing grants and the provider
   * session id. World-readable was wrong — anything else on the machine could read which
   * capabilities a peer already has, and the session token for the conversation.
   */
  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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
