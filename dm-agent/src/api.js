import { setTimeout as delay } from "node:timers/promises";

export const MAX_MESSAGE_CHARS = 4000;

/**
 * Minimal Aicoo API client for the chat-rails agent.
 * Read side:  GET  /api/v1/conversations  (view=me direct DMs, view=coo shared-agent threads)
 * Write side: POST /api/v1/agent/message  (human path — lands in the shared_agent thread,
 *             stored with senderType='agent', fire-and-forget, no cloud-agent invocation)
 */
export class AicooApi {
  constructor({ baseUrl, token, timeoutMs = 15_000, log = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  async request(path, { method = "GET", body, idempotencyKey } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data = raw;
      try {
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* keep raw text */
      }
      if (!response.ok) {
        const code = data && typeof data === "object" && data.error ? data.error : `http_${response.status}`;
        // An HTML body from a JSON API means the route is not there — Next served its 404 page.
        // Pasting a screenful of markup helps nobody; naming what it actually means does.
        const isHtml = typeof data === "string" && /^\s*<(!doctype|html)/i.test(data);
        const detail = isHtml
          ? `this endpoint does not exist on ${this.baseUrl} (the server may be running an older deploy)`
          : typeof data === "object" ? JSON.stringify(data).slice(0, 300) : String(data).slice(0, 300);
        const err = new Error(`${method} ${path} failed: ${code} — ${detail}`);
      err.path = path;
        err.status = response.status;
        err.code = code;
        throw err;
      }
      return data;
    } catch (error) {
      // AbortError's own message says only "This operation was aborted", which reads as a bug
      // in the agent rather than a slow backend. Say which call, and how long we waited.
      if (error?.name === "AbortError") {
        const err = new Error(`${method} ${path} timed out after ${this.timeoutMs / 1000}s — raise it with --api-timeout <seconds> if the server is just slow`);
        err.code = "timeout";
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Who does this API key belong to? */
  async identity() {
    const res = await this.request("/api/v1/identity");
    return res.profile; // { userId, username, name, email }
  }

  /**
   * List conversations with a contact. view: "me" (direct human DM) | "coo" (shared_agent) | "all".
   * Messages come back oldest-first with { id, role, senderType, senderId, content, createdAt }.
   */
  async conversations({ view = "all", contact, limit = 50 } = {}) {
    const params = new URLSearchParams({ view, limit: String(limit) });
    if (contact) params.set("contact", contact);
    const res = await this.request(`/api/v1/conversations?${params}`);
    return res.conversations ?? [];
  }

  /**
   * Send a message to a human. Lands in the shared_agent thread
   * (owner = this key's account, participant = recipient) as senderType='agent'.
   */
  async sendHuman(to, text, idempotencyKey) {
    const message = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 20)}\n…[truncated]` : text;
    return this.request("/api/v1/agent/message", {
      method: "POST",
      body: { to, message, intent: "inform" },
      idempotencyKey,
    });
  }

  /**
   * Questions waiting on share links this account pointed at this machine.
   * Returns { links, messages } — messages include our own past replies so the agent can tell
   * where it left off rather than treating every restart as a backlog.
   */
  async guestMessages(since = 0) {
    const params = new URLSearchParams({ since: String(since) });
    const res = await this.request(`/api/v1/local-agent/guest-messages?${params}`);
    return { links: res.links ?? [], messages: res.messages ?? [] };
  }

  /** Post an answer back into a guest conversation, where the visitor's own UI picks it up. */
  async replyToGuest(sessionId, content) {
    return this.request("/api/v1/local-agent/guest-messages/reply", {
      method: "POST",
      body: { sessionId, content },
    });
  }

  /** Contacts this key's account is connected to. */
  async contacts() {
    const res = await this.request("/api/v1/network");
    return res.network?.contacts ?? [];
  }

  /**
   * Send a plain friend request (a `_coo` suffix would ask for agent access instead, which is
   * a different and much larger grant — we never want it here).
   * Returns { ok } or, for the two states that are not failures, { already: "connected"|"pending" }.
   */
  async requestFriend(username) {
    try {
      await this.request("/api/v1/network/request", { method: "POST", body: { to: username } });
      return { ok: true };
    } catch (error) {
      if (error.code === "already_connected") return { ok: true, already: "connected" };
      if (error.code === "already_pending") return { ok: true, already: "pending" };
      throw error;
    }
  }

  /** Retry helper for transient failures (5xx / network). 4xx are rethrown immediately. */
  async withRetry(fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error.status && error.status >= 400 && error.status < 500) throw error;
        this.log(`[api] transient error (attempt ${i + 1}/${attempts}): ${error.message}`);
        await delay(baseDelayMs * 2 ** i);
      }
    }
    throw lastError;
  }
}
