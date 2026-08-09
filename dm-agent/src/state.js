import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
    this.data = { sessionId: null, sessions: {}, cursors: {}, failures: {}, grants: {}, restarts: [] };
    try {
      this.data = { sessionId: null, sessions: {}, cursors: {}, failures: {}, grants: {}, restarts: [], ...JSON.parse(readFileSync(file, "utf8")) };
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

  /**
   * A stable name for this installation, minted once and kept.
   *
   * The audit needs to say WHICH machine, and the hostname is not it — people rename laptops,
   * and two people can share one. This is per state directory, which is the same granularity
   * as the grants it sits beside: one agent, one relationship, one identity in the record.
   */
  deviceId() {
    if (!this.data.deviceId) {
      this.data.deviceId = `dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.save();
    }
    return this.data.deviceId;
  }

  /**
   * The model session for one conversation, and only that one.
   *
   * There used to be a single sessionId for the whole agent, resumed for every message from
   * anyone. On a share link that meant one visitor's turn ran with the previous visitor's
   * messages in context — nothing in code stopped the model repeating them, so the only thing
   * between two strangers was the model choosing to be discreet. Discretion is not isolation:
   * it holds until someone phrases the question differently.
   *
   * Keyed by the conversation the message arrived in, which is per-visitor on a share link and
   * per-thread for a named peer, so a returning visitor still gets continuity with themselves.
   */
  sessionFor(conversationId) {
    if (!conversationId) return this.data.sessionId ?? null; // dry runs and one-shots
    return this.data.sessions?.[String(conversationId)] ?? null;
  }

  setSessionFor(conversationId, sessionId) {
    if (!conversationId) {
      this.data.sessionId = sessionId;
      this.save();
      return;
    }
    this.data.sessions = { ...(this.data.sessions ?? {}), [String(conversationId)]: sessionId };
    this.save();
  }

  clearSessionFor(conversationId) {
    if (!conversationId) {
      this.data.sessionId = null;
    } else if (this.data.sessions) {
      delete this.data.sessions[String(conversationId)];
    }
    this.save();
  }

  /**
   * Forget every conversation — what the owner wants before handing a link to someone new.
   * Cursors are deliberately left alone: dropping those replays the whole backlog.
   */
  clearAllSessions() {
    this.data.sessionId = null;
    this.data.sessions = {};
    this.save();
  }

  /**
   * When this agent last replaced itself, and how often lately.
   *
   * On disk rather than in memory because the thing being rate-limited is the restart, and a
   * restart is precisely what destroys memory. A real test respawned three times in forty
   * seconds against a ten-minute limit: each replacement started counting from zero and
   * happily restarted again. A machine with its network off would have done that forever.
   */
  recentRestarts(withinMs = 3_600_000, now = Date.now()) {
    return (this.data.restarts ?? []).filter((at) => now - at < withinMs);
  }

  noteRestart(now = Date.now()) {
    this.data.restarts = [...this.recentRestarts(3_600_000, now), now];
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
