import type {
  AuditRecord,
  CommunicationGrant,
  CommunicationSession,
  DeliveryAckInput,
  Endpoint,
  HumanInboxSendMessageInput,
  MessageDelivery,
  MessageReceipt,
  ReachableTarget,
  RegisterEndpointInput,
  RegisterRuntimeSessionInput,
  RequestCommunicationSessionInput,
  RuntimeEvent,
  RuntimeSessionBinding,
  SendMessageInput,
} from "./contracts.js";
import type { MessageTransport } from "./transport.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(`API request failed (${status} ${code})`);
  }
}

export interface PairStatusResponse {
  status: "request_pair" | "awaiting_their_accept" | "accept_incoming" | "setup_bridge" | "ready";
  message: string;
  targetReachable?: boolean;
}

export interface ResolvedPersonResponse {
  principalId: string;
  handle?: string;
  name?: string;
  displayName?: string;
  hasReachableRuntime?: boolean;
}

export interface StartDeviceCodeInput {
  deviceId: string;
  runtime: "claude-code" | "codex";
  bridgeVersion: string;
  adapterVersion: string;
  capabilities: string[];
  label?: string;
}

export interface StartDeviceCodeResponse {
  userCode: string;
  pollToken: string;
  approvalUrl?: string;
  expiresAt: string;
}

export type PollDeviceCodeResponse =
  | { status: "pending" }
  | { status: "approved"; deviceToken: string; userId: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "consumed" };

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  fetchImpl?: typeof fetch;
  /** Stable per-machine device identifier. Required by the Aicoo control plane
   *  (POST /api/v1/local-agent/endpoints), which mints a device credential keyed
   *  to (principal, deviceId). Ignored by the standalone HttpMessageTransport. */
  deviceId?: string;
  onTokenRefreshed?: (token: string) => void;
}

/**
 * Remove copy/paste artifacts around a bearer token while refusing to silently
 * rewrite invalid bytes inside the credential. Undici rejects control bytes in
 * header values before a request is sent, which otherwise surfaces as a vague
 * `fetch failed` error.
 */
export function normalizeBearerToken(token: string): string {
  const normalized = token.replace(/^[\s\u0000-\u001f\u007f\u200b\ufeff]+|[\s\u0000-\u001f\u007f\u200b\ufeff]+$/gu, "");
  if (!normalized) throw new Error("Bearer token must not be empty");
  if (/[\s\u0000-\u001f\u007f\u200b\ufeff]/u.test(normalized)) {
    throw new Error("Bearer token contains invalid whitespace or control characters");
  }
  return normalized;
}

export class HttpMessageTransport implements MessageTransport {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #minReconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #fetch: typeof fetch;
  #endpointId?: string;

  constructor(options: HttpTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = normalizeBearerToken(options.token);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#minReconnectMs = options.minReconnectMs ?? 50;
    this.#maxReconnectMs = options.maxReconnectMs ?? 5_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get endpointId(): string | undefined {
    return this.#endpointId;
  }

  setEndpointId(endpointId: string): void {
    this.#endpointId = endpointId;
  }

  async registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint> {
    const endpoint = await this.requestJson<Endpoint>("/api/v1/endpoints", { method: "POST", body: input });
    this.#endpointId = endpoint.endpointId;
    return endpoint;
  }

  async heartbeatEndpoint(endpointId: string): Promise<void> {
    await this.requestJson(`/api/v1/endpoints/${encodeURIComponent(endpointId)}/heartbeat`, { method: "POST" });
  }

  async registerRuntimeSession(endpointId: string, input: RegisterRuntimeSessionInput): Promise<RuntimeSessionBinding> {
    return this.requestJson(`/api/v1/endpoints/${encodeURIComponent(endpointId)}/sessions`, {
      method: "POST",
      body: input,
    });
  }

  async updateRuntimeSession(
    endpointId: string,
    sessionHandle: string,
    input: { state?: "idle" | "busy" | "closed"; allowInbound?: boolean; allowMidTurnSteer?: boolean },
  ): Promise<RuntimeSessionBinding> {
    return this.requestJson(
      `/api/v1/endpoints/${encodeURIComponent(endpointId)}/sessions/${encodeURIComponent(sessionHandle)}`,
      { method: "PATCH", body: input },
    );
  }

  async listReachableTargets(personId: string): Promise<ReachableTarget[]> {
    return this.requestJson(`/api/v1/targets?personId=${encodeURIComponent(personId)}`);
  }

  async requestCommunicationSession(input: RequestCommunicationSessionInput): Promise<CommunicationSession> {
    return this.requestJson("/api/v1/comm-sessions", { method: "POST", body: input });
  }

  async listCommunicationSessions(): Promise<CommunicationSession[]> {
    return this.requestJson("/api/v1/comm-sessions");
  }

  async acceptCommunicationSession(sessionId: string): Promise<CommunicationGrant> {
    return this.requestJson(`/api/v1/comm-sessions/${encodeURIComponent(sessionId)}/accept`, { method: "POST" });
  }

  async declineCommunicationSession(sessionId: string): Promise<void> {
    await this.requestJson(`/api/v1/comm-sessions/${encodeURIComponent(sessionId)}/decline`, { method: "POST" });
  }

  async revokeCommunicationSession(sessionId: string): Promise<void> {
    await this.requestJson(`/api/v1/comm-sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });
  }

  async sendMessage(input: SendMessageInput): Promise<MessageReceipt> {
    return this.requestJson("/api/v1/messages", { method: "POST", body: input });
  }

  async sendInbox(input: HumanInboxSendMessageInput): Promise<MessageReceipt> {
    return this.sendMessage(input);
  }

  async *subscribeEvents(cursor = "0", signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const endpointId = this.requireEndpoint();
    let lastCursor = cursor;
    let backoff = this.#minReconnectMs;
    while (!signal?.aborted) {
      try {
        const url = `${this.#baseUrl}/api/v1/events?endpointId=${encodeURIComponent(endpointId)}&cursor=${encodeURIComponent(lastCursor)}`;
        const response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${this.#token}`, accept: "text/event-stream" },
          signal,
        });
        if (!response.ok) await this.throwApiError(response);
        if (!response.body) throw new Error("SSE response had no body");
        backoff = this.#minReconnectMs;
        for await (const event of parseSse(response.body, signal)) {
          lastCursor = event.cursor;
          yield event;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
      }
      await abortableDelay(jitter(backoff), signal);
      backoff = Math.min(backoff * 2, this.#maxReconnectMs);
    }
  }

  async fetchInbox(afterCursor = "0"): Promise<RuntimeEvent[]> {
    const endpointId = this.requireEndpoint();
    return this.requestJson(
      `/api/v1/events/poll?endpointId=${encodeURIComponent(endpointId)}&cursor=${encodeURIComponent(afterCursor)}`,
    );
  }

  async validateInjection(input: {
    messageId: string;
    communicationSessionId: string;
    endpointId: string;
    sessionHandle?: string;
  }): Promise<{ valid: true } | { valid: false; reason: string }> {
    return this.requestJson("/api/v1/injections/validate", { method: "POST", body: input });
  }

  async acknowledgeDelivery(input: DeliveryAckInput): Promise<void> {
    const { messageId, ...body } = input;
    await this.requestJson(`/api/v1/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST", body });
  }

  async getMessageStatus(messageId: string): Promise<MessageDelivery> {
    return this.requestJson(`/api/v1/messages/${encodeURIComponent(messageId)}/status`);
  }

  async whoami(): Promise<{ principalId: string; deviceId: string }> {
    return this.requestJson("/api/v1/whoami");
  }

  async getDefaultRoute(): Promise<{ endpointId: string; sessionHandle: string; updatedAt: string }> {
    return this.requestJson("/api/v1/default-route");
  }

  async setDefaultRoute(endpointId: string, sessionHandle: string) {
    return this.requestJson<{ endpointId: string; sessionHandle: string; updatedAt: string }>("/api/v1/default-route", {
      method: "PUT",
      body: { endpointId, sessionHandle },
    });
  }

  async clearDefaultRoute(): Promise<void> {
    await this.requestJson("/api/v1/default-route", { method: "DELETE" });
  }

  async createOffer(input: {
    endpointId: string;
    sessionHandle: string;
    audiencePrincipalId: string;
    ttlSeconds?: number;
  }): Promise<{ targetOfferId: string; expiresAt: string }> {
    return this.requestJson("/api/v1/target-offers", { method: "POST", body: input });
  }

  async revokeOffer(offerId: string): Promise<void> {
    await this.requestJson(`/api/v1/target-offers/${encodeURIComponent(offerId)}/revoke`, { method: "POST" });
  }

  async listInboxItems(): Promise<unknown[]> {
    return this.requestJson("/api/v1/inbox");
  }

  async listAudit(commSessionId?: string): Promise<AuditRecord[]> {
    const query = commSessionId ? `?commSessionId=${encodeURIComponent(commSessionId)}` : "";
    return this.requestJson(`/api/v1/audit${query}`);
  }

  async getPairStatus(principalId: string): Promise<PairStatusResponse> {
    return this.requestJson(`/api/v1/local-agent/pair-status?principalId=${encodeURIComponent(principalId)}`);
  }

  async resolvePerson(query: string): Promise<ResolvedPersonResponse> {
    return this.requestJson(`/api/v1/local-agent/resolve-person?q=${encodeURIComponent(query)}`);
  }

  async startDeviceCode(input: StartDeviceCodeInput): Promise<StartDeviceCodeResponse> {
    return this.requestJson("/api/v1/local-agent/device-code/start", { method: "POST", body: input });
  }

  async pollDeviceCode(pollToken: string): Promise<PollDeviceCodeResponse> {
    return this.requestJson("/api/v1/local-agent/device-code/poll", { method: "POST", body: { pollToken } });
  }

  async requestJson<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!response.ok) await this.throwApiError(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireEndpoint(): string {
    if (!this.#endpointId) throw new Error("Transport endpoint is not registered");
    return this.#endpointId;
  }

  private async throwApiError(response: Response): Promise<never> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const code = isErrorBody(body) ? body.error.code : "http_error";
    throw new ApiError(response.status, code, body);
  }
}

async function* parseSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as RuntimeEvent;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isErrorBody(value: unknown): value is { error: { code: string } } {
  return typeof value === "object" && value !== null && "error" in value
    && typeof (value as { error?: unknown }).error === "object"
    && (value as { error: { code?: unknown } }).error !== null
    && typeof (value as { error: { code?: unknown } }).error.code === "string";
}

function jitter(value: number): number {
  return Math.max(1, Math.round(value * (0.8 + Math.random() * 0.4)));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
