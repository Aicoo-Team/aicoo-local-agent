import {
  HttpMessageTransport,
  ApiError,
  normalizeBearerToken,
  type HttpTransportOptions,
} from "./http-client.js";
import type {
  CommunicationGrant,
  CommunicationSession,
  DeliveryAckInput,
  Endpoint,
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

const LA = "/api/v1/local-agent";
const LR = "/api/v1/local-realtime";

/**
 * Real Aicoo transport. Implements the same surface as HttpMessageTransport but
 * targets the production endpoints (`/api/v1/local-agent/*` + `/api/v1/local-realtime/*`)
 * and swaps the Aicoo user key for a device-scoped token minted at registration.
 *
 * Grant responses are flat rows on the server; we map them to the nested
 * CommunicationSession contract. Event types are remapped grant.* → comm.*.
 * See ../docs/API-SPEC.md for the endpoint contract.
 */
export class AicooTransport extends HttpMessageTransport {
  readonly #base: string;
  readonly #userToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #deviceId: string;
  #deviceToken?: string;
  #endpoint?: string;

  constructor(options: HttpTransportOptions) {
    super(options);
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.#userToken = normalizeBearerToken(options.token);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#deviceId = options.deviceId?.trim() ?? "";
  }

  #authToken(): string {
    return this.#deviceToken ?? this.#userToken;
  }

  override async requestJson<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.#authToken()}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Read the body exactly once (undici forbids a second read); parse JSON if we can,
        // otherwise keep the raw text so the real error isn't masked.
        const raw = await response.text();
        let errBody: unknown = raw;
        try {
          if (raw) errBody = JSON.parse(raw);
        } catch {
          /* non-JSON error body — keep raw text */
        }
        const code =
          typeof errBody === "object" && errBody !== null && "error" in errBody
            ? String((errBody as { error: unknown }).error)
            : "http_error";
        throw new ApiError(response.status, code, errBody);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  override async registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint> {
    if (!this.#deviceId) {
      throw new ApiError(400, "invalid_request", "deviceId is required (set CCD_DEVICE_ID or --device-id)");
    }
    const { endpoint, deviceToken } = await this.requestJson<{ endpoint: Endpoint; deviceToken: string }>(
      `${LA}/endpoints`,
      { method: "POST", body: { ...input, deviceId: this.#deviceId } },
    );
    this.#deviceToken = normalizeBearerToken(deviceToken);
    this.#endpoint = endpoint.endpointId;
    this.setEndpointId(endpoint.endpointId);
    return endpoint;
  }

  override async heartbeatEndpoint(endpointId: string): Promise<void> {
    await this.requestJson(`${LA}/endpoints/${encodeURIComponent(endpointId)}/heartbeat`, { method: "POST" });
  }

  override async registerRuntimeSession(
    endpointId: string,
    input: RegisterRuntimeSessionInput,
  ): Promise<RuntimeSessionBinding> {
    return this.requestJson(`${LA}/sessions`, { method: "POST", body: { endpointId, ...input } });
  }

  override async updateRuntimeSession(
    endpointId: string,
    sessionHandle: string,
    input: { state?: "idle" | "busy" | "closed"; allowInbound?: boolean; allowMidTurnSteer?: boolean },
  ): Promise<RuntimeSessionBinding> {
    return this.requestJson(`${LA}/sessions/${encodeURIComponent(sessionHandle)}`, { method: "PATCH", body: input });
  }

  override async setDefaultRoute(endpointId: string, sessionHandle: string) {
    return this.requestJson<{ endpointId: string; sessionHandle: string; updatedAt: string }>(`${LA}/default-route`, {
      method: "PUT",
      body: { endpointId, sessionHandle },
    });
  }

  override async getDefaultRoute(): Promise<{ endpointId: string; sessionHandle: string; updatedAt: string }> {
    return this.requestJson(`${LA}/default-route`);
  }

  override async listReachableTargets(_personId: string): Promise<ReachableTarget[]> {
    // Targets endpoint is not part of the P1 scenario slice.
    return [];
  }

  override async requestCommunicationSession(
    input: RequestCommunicationSessionInput,
  ): Promise<CommunicationSession> {
    const row = await this.requestJson<CommRow>(`${LA}/grants`, { method: "POST", body: input });
    return mapCommSession(row);
  }

  override async acceptCommunicationSession(sessionId: string): Promise<CommunicationGrant> {
    const row = await this.requestJson<CommRow>(`${LA}/grants/${encodeURIComponent(sessionId)}/accept`, {
      method: "POST",
    });
    return mapCommSession(row) as CommunicationGrant;
  }

  override async declineCommunicationSession(sessionId: string): Promise<void> {
    await this.requestJson(`${LA}/grants/${encodeURIComponent(sessionId)}/decline`, { method: "POST" });
  }

  override async revokeCommunicationSession(sessionId: string): Promise<void> {
    await this.requestJson(`${LA}/grants/${encodeURIComponent(sessionId)}/revoke`, { method: "POST" });
  }

  override async sendMessage(input: SendMessageInput): Promise<MessageReceipt> {
    if ("target" in input) {
      throw new ApiError(400, "unsupported", "human_inbox send is not supported by AicooTransport");
    }
    return this.requestJson(`${LA}/messages`, { method: "POST", body: input });
  }

  override async acknowledgeDelivery(input: DeliveryAckInput): Promise<void> {
    const { messageId, ...body } = input;
    await this.requestJson(`${LA}/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST", body });
  }

  override async validateInjection(input: {
    messageId: string;
    communicationSessionId: string;
    endpointId: string;
    sessionHandle?: string;
  }): Promise<{ valid: true } | { valid: false; reason: string }> {
    return this.requestJson(`${LA}/injections/validate`, { method: "POST", body: input });
  }

  override async getMessageStatus(messageId: string): Promise<MessageDelivery> {
    const res = await this.requestJson<{ delivery: DeliveryRow; attempts: AttemptRow[] }>(
      `${LA}/messages/${encodeURIComponent(messageId)}`,
    );
    return mapDelivery(messageId, res.delivery, res.attempts);
  }

  override async *subscribeEvents(cursor = "0", signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const endpointId = this.#endpoint;
    if (!endpointId) throw new Error("AicooTransport endpoint is not registered");
    let lastCursor = cursor;
    let backoff = 50;
    while (!signal?.aborted) {
      try {
        const url = `${this.#base}${LR}/stream?endpointId=${encodeURIComponent(endpointId)}&cursor=${encodeURIComponent(lastCursor)}`;
        const response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${this.#authToken()}`, accept: "text/event-stream" },
          signal,
        });
        if (!response.ok) throw new ApiError(response.status, "sse_error", null);
        if (!response.body) throw new Error("SSE response had no body");
        backoff = 50;
        for await (const event of parseSse(response.body, signal)) {
          lastCursor = event.cursor;
          yield event;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
      }
      await delay(backoff, signal);
      backoff = Math.min(backoff * 2, 5_000);
    }
  }

  override async fetchInbox(afterCursor = "0"): Promise<RuntimeEvent[]> {
    const endpointId = this.#endpoint;
    if (!endpointId) throw new Error("AicooTransport endpoint is not registered");
    return this.requestJson(
      `${LR}/poll?endpointId=${encodeURIComponent(endpointId)}&cursor=${encodeURIComponent(afterCursor)}`,
    );
  }

  async requestToolApproval(
    input: ToolApprovalRequest,
  ): Promise<{ approvalId: string; status: string; decision: string | null }> {
    return this.requestJson(`${LA}/tool-approvals`, { method: "POST", body: input });
  }

  async getToolApproval(approvalId: string): Promise<{ status: string; decision: "allow" | "deny" | null }> {
    return this.requestJson(`${LA}/tool-approvals/${encodeURIComponent(approvalId)}`);
  }
}

interface CommRow {
  commSessionId: string;
  requesterPrincipalId: string;
  requesterReplyEndpointId: string;
  requesterReplySessionHandle: string;
  recipientPrincipalId: string;
  targetKind: CommunicationSession["recipient"]["targetKind"];
  targetOfferId: string | null;
  frozenEndpointId: string | null;
  frozenSessionHandle: string | null;
  status: CommunicationSession["status"];
  requestedAt: string;
  requestExpiresAt: string;
  activatedAt: string | null;
  grantExpiresAt: string | null;
  revokedAt: string | null;
}

function mapCommSession(row: CommRow): CommunicationSession {
  return {
    id: row.commSessionId,
    requester: {
      principalId: row.requesterPrincipalId,
      replyEndpointId: row.requesterReplyEndpointId,
      replySessionHandle: row.requesterReplySessionHandle,
    },
    recipient: {
      principalId: row.recipientPrincipalId,
      targetKind: row.targetKind,
      ...(row.targetOfferId ? { targetOfferId: row.targetOfferId } : {}),
      ...(row.frozenEndpointId ? { endpointId: row.frozenEndpointId } : {}),
      ...(row.frozenSessionHandle ? { sessionHandle: row.frozenSessionHandle } : {}),
    },
    status: row.status,
    capabilities: ["message:send", "message:reply"],
    requestedAt: row.requestedAt,
    requestExpiresAt: row.requestExpiresAt,
    ...(row.activatedAt ? { activatedAt: row.activatedAt } : {}),
    ...(row.grantExpiresAt ? { grantExpiresAt: row.grantExpiresAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

interface DeliveryRow {
  deliveryId: string;
  status: MessageDelivery["status"];
  queuedAt: string;
  dispatchedAt: string | null;
  deviceAckReceivedAt: string | null;
  runtimePendingAt: string | null;
  runtimeAckReceivedAt: string | null;
  terminalAt: string | null;
  resultCode: string | null;
  runtimeAckId: string | null;
  adapterLabel: string | null;
}

interface AttemptRow {
  attemptId: string;
  phase: MessageDelivery["attempts"][number]["phase"];
  resultCode: string | null;
  retryable: boolean;
  runtimeAckId: string | null;
  createdAt: string;
}

function mapDelivery(messageId: string, d: DeliveryRow, attempts: AttemptRow[]): MessageDelivery {
  return {
    messageId,
    deliveryId: d.deliveryId,
    status: d.status,
    queuedAt: d.queuedAt,
    ...(d.dispatchedAt ? { dispatchedAt: d.dispatchedAt } : {}),
    ...(d.deviceAckReceivedAt ? { deviceAckReceivedAt: d.deviceAckReceivedAt } : {}),
    ...(d.runtimePendingAt ? { runtimePendingAt: d.runtimePendingAt } : {}),
    ...(d.runtimeAckReceivedAt ? { runtimeAckReceivedAt: d.runtimeAckReceivedAt } : {}),
    ...(d.terminalAt ? { terminalAt: d.terminalAt } : {}),
    ...(d.resultCode ? { resultCode: d.resultCode } : {}),
    ...(d.runtimeAckId ? { runtimeAckId: d.runtimeAckId } : {}),
    ...(d.adapterLabel ? { adapterLabel: d.adapterLabel } : {}),
    attempts: attempts.map((a) => ({
      attemptId: a.attemptId,
      phase: a.phase,
      ...(a.resultCode ? { resultCode: a.resultCode } : {}),
      retryable: a.retryable,
      ...(a.runtimeAckId ? { runtimeAckId: a.runtimeAckId } : {}),
      createdAt: a.createdAt,
    })),
  };
}

const EVENT_TYPE_MAP: Record<string, RuntimeEvent["type"]> = {
  "grant.request": "comm.request",
  "grant.activated": "comm.activated",
  "grant.declined": "comm.declined",
  "grant.revoked": "comm.revoked",
  "message.dispatch": "message.dispatch",
};

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
        if (data) {
          const raw = JSON.parse(data) as RuntimeEvent & { type: string };
          const mapped = EVENT_TYPE_MAP[raw.type];
          if (mapped) yield { ...raw, type: mapped };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Transport factory: AicooTransport (real Aicoo endpoints + device token) when
 * CCD_AICOO=1, else the flat-path HttpMessageTransport (mock control plane).
 */
export function makeTransport(options: HttpTransportOptions): HttpMessageTransport {
  return process.env.CCD_AICOO === "1" ? new AicooTransport(options) : new HttpMessageTransport(options);
}

export interface ToolApprovalRequest {
  communicationSessionId: string;
  sessionHandle: string;
  messageId?: string;
  toolName: string;
  toolInputSummary: string;
}

// AicooTransport tool-approval helpers (幕 4). Declared as a module augmentation
// would need the class; instead expose via a thin wrapper factory below.
export interface ToolApprovalClient {
  requestToolApproval(
    input: ToolApprovalRequest,
  ): Promise<{ approvalId: string; status: string; decision: string | null }>;
  getToolApproval(approvalId: string): Promise<{ status: string; decision: "allow" | "deny" | null }>;
}

/**
 * Build a resolveToolPermission callback (for ClaudeCodeAdapter) bound to one
 * grant + session. Auto-allowed by policy → allow; pending → poll until the owner
 * decides or the timeout elapses (fail-closed deny). The client is typically an
 * AicooTransport instance (it satisfies ToolApprovalClient once the methods below
 * are attached).
 */
export function makeToolPermissionResolver(
  client: ToolApprovalClient,
  context: { communicationSessionId: string; sessionHandle: string; messageId?: string },
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1_500;
  return async (action: {
    toolName: string;
    input: Record<string, unknown>;
  }): Promise<{ behavior: "allow" | "deny"; message?: string }> => {
    const raw = JSON.stringify(action.input);
    const summary = `${action.toolName}: ${raw.length > 500 ? `${raw.slice(0, 500)}…` : raw}`;
    const res = await client.requestToolApproval({
      communicationSessionId: context.communicationSessionId,
      sessionHandle: context.sessionHandle,
      messageId: context.messageId,
      toolName: action.toolName,
      toolInputSummary: summary,
    });
    if (res.status === "auto_allow" || res.decision === "allow") return { behavior: "allow" };
    if (res.decision === "deny") return { behavior: "deny", message: "owner denied" };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const cur = await client.getToolApproval(res.approvalId);
      if (cur.decision === "allow") return { behavior: "allow" };
      if (cur.decision === "deny") return { behavior: "deny", message: "owner denied" };
    }
    return { behavior: "deny", message: "approval timed out" };
  };
}
