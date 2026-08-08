import {
  HttpMessageTransport,
  ApiError,
  normalizeBearerToken,
  parseResolvedPersonResponse,
  type AuthenticationRecoveryResult,
  type HttpTransportOptions,
  type PairStatusResponse,
  type ResolvedPersonResponse,
  type StartDeviceCodeInput,
  type StartDeviceCodeResponse,
  type PollDeviceCodeResponse,
} from "./http-client.js";
import { describeTimeoutTiming, startEventLoopMonitor } from "./event-loop.js";
import type { DelegationRequestOptions } from "./transport.js";
import type {
  CommunicationGrant,
  CommunicationSession,
  DeliveryAckInput,
  Endpoint,
  LocalAgentDelegationInput,
  LocalAgentDelegationResponse,
  MessageDelivery,
  MessageReceipt,
  ReachableTarget,
  RegisterEndpointInput,
  RegisterRuntimeSessionInput,
  RequestCommunicationSessionInput,
  RuntimeEvent,
  TrustedToolPolicyUsageInput,
  RuntimeSessionBinding,
  SendMessageInput,
} from "./contracts.js";

const LA = "/api/v1/local-agent";
const LR = "/api/v1/local-realtime";
const DEFAULT_DELEGATION_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Attempts per call. Two, not more: the presence caps are bounded by the control plane's 60s
 * endpoint-staleness window (LOCAL_AGENT_ENDPOINT_STALE_MS). runHeartbeat is a serial loop —
 * delay(heartbeatMs) -> heartbeat -> setDefaultRoute — and lastSeenAt only advances on a
 * successful heartbeat, so the worst gap between successful beats is
 * heartbeatMs + attempts * (heartbeatCap + routeCap). At heartbeatMs=10s, a 10s heartbeat cap,
 * and a 5s route cap that is 40s, comfortably inside 60s. Raising either cap or the attempt count trades a
 * recovered request for the endpoint being declared unreachable, which is strictly worse.
 */
const DEFAULT_ATTEMPTS = 2;
const AUTHENTICATION_RECOVERY_GRACE_MS = 1_000;

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
  readonly #heartbeatTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #deviceId: string;
  readonly #onTokenRefreshed?: (token: string) => void;
  readonly #loadToken?: () => string | undefined;
  #deviceToken?: string;
  #endpoint?: string;
  #registrationInput?: RegisterEndpointInput;
  #authenticationRecovery?: Promise<AuthenticationRecoveryResult>;
  #lastAuthenticationRecovery?: { at: number; result: AuthenticationRecoveryResult };

  constructor(options: HttpTransportOptions) {
    super(options);
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.#userToken = normalizeBearerToken(options.token);
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#heartbeatTimeoutMs = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#deviceId = options.deviceId?.trim() ?? "";
    this.#onTokenRefreshed = options.onTokenRefreshed;
    this.#loadToken = options.loadToken;
    startEventLoopMonitor();
  }

  #authToken(): string {
    return this.#deviceToken ?? this.#userToken;
  }

  /**
   * Every route this transport calls is idempotent by construction — heartbeat and
   * setDefaultRoute are upserts, acknowledgeDelivery carries `attemptId`, sendMessage carries
   * `clientMessageId` — so a timed-out attempt is always safe to repeat. Repeating it is worth
   * doing: in the field we see an attempt abort at the cap and the very next request, issued
   * microseconds later on the socket the failed attempt just opened, succeed. One retry converts
   * that whole class of failure into a success without widening the cap.
   *
   * Only timeouts and transport errors are retried. An ApiError is a real answer from the server
   * and must reach the caller intact — retrying a 401 would paper over the token-revoked path in
   * Bridge.runHeartbeat, and retrying a 409 would just repeat a refusal.
   */
  override async requestJson<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; timeoutMs?: number; attempts?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#attempt<T>(path, options, timeoutMs, attempt, attempts);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async #attempt<T>(
    path: string,
    options: { method?: string; body?: unknown },
    timeoutMs: number,
    attempt: number,
    attempts: number,
    authToken = this.#authToken(),
  ): Promise<T> {
    const method = options.method ?? "GET";
    const controller = new AbortController();
    // Abort WITH a reason. A bare abort() surfaces as "AbortError: This operation was aborted",
    // which is indistinguishable from a cancellation and tells an operator nothing. The timing
    // verdict is the part that matters: without it a blocked event loop and a slow server are
    // the same log line, and the elapsed time reads the same in both cases.
    const startedAt = performance.now();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `request timed out after ${timeoutMs}ms (attempt ${attempt}/${attempts}): ${method} ${path}` +
              ` [${describeTimeoutTiming(performance.now() - startedAt, timeoutMs)}]`,
          ),
        ),
      timeoutMs,
    );
    try {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${authToken}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        // The apex domain 307s to www, and undici drops Authorization across that origin hop —
        // which surfaces as an unexplained 401. Fail loudly instead.
        redirect: "error",
      });
      // Capture the status before touching the body: the abort timer is still armed, so a slow
      // body read would otherwise turn a perfectly good 401 into an AbortError and bypass the
      // token-revoked handling in Bridge.runHeartbeat.
      const { ok, status } = response;
      if (!ok) {
        // Read the body exactly once (undici forbids a second read); parse JSON if we can,
        // otherwise keep the raw text so the real error isn't masked.
        let errBody: unknown;
        try {
          const raw = await response.text();
          errBody = raw;
          try {
            if (raw) errBody = JSON.parse(raw);
          } catch {
            /* non-JSON error body — keep raw text */
          }
        } catch {
          errBody = "<error body could not be read>";
        }
        const code =
          typeof errBody === "object" && errBody !== null && "error" in errBody
            ? String((errBody as { error: unknown }).error)
            : "http_error";
        throw new ApiError(status, code, errBody);
      }
      if (status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  override async registerEndpoint(input: RegisterEndpointInput): Promise<Endpoint> {
    if (!this.#deviceId) {
      throw new ApiError(400, "invalid_request", "deviceId is required (set CCD_DEVICE_ID or --device-id)");
    }
    const { endpoint, deviceToken } = await this.#registerWithToken(input, this.#authToken());
    this.#registrationInput = { ...input, capabilities: [...input.capabilities] };
    this.#applyRegistration(endpoint, deviceToken);
    return endpoint;
  }

  override async recoverAuthentication(): Promise<AuthenticationRecoveryResult> {
    if (this.#authenticationRecovery) return this.#authenticationRecovery;
    if (
      this.#lastAuthenticationRecovery?.result.recovered
      && Date.now() - this.#lastAuthenticationRecovery.at < AUTHENTICATION_RECOVERY_GRACE_MS
    ) {
      return this.#lastAuthenticationRecovery.result;
    }
    this.#authenticationRecovery = this.#recoverAuthentication();
    try {
      const result = await this.#authenticationRecovery;
      this.#lastAuthenticationRecovery = { at: Date.now(), result };
      return result;
    } finally {
      this.#authenticationRecovery = undefined;
    }
  }

  async #recoverAuthentication(): Promise<AuthenticationRecoveryResult> {
    let reloadFailure: string | undefined;
    try {
      const persistedToken = this.#loadToken?.();
      if (persistedToken) {
        const normalized = normalizeBearerToken(persistedToken);
        if (normalized !== this.#authToken()) {
          this.#deviceToken = normalized;
          return { recovered: true, source: "credentials" };
        }
      }
    } catch (error) {
      reloadFailure = `could not reload credentials: ${String(error)}`;
    }

    // An explicit user/API token remains valid when a device token is revoked. If the
    // process started with only the old device token, wait for another process to persist
    // its replacement instead of repeatedly rotating the shared identity.
    if (!this.#registrationInput || this.#userToken === this.#deviceToken) {
      return {
        recovered: false,
        reason: reloadFailure ?? "no newer persisted token or registration credential is available",
      };
    }
    try {
      const { endpoint, deviceToken } = await this.#registerWithToken(this.#registrationInput, this.#userToken);
      if (this.#endpoint && endpoint.endpointId !== this.#endpoint) {
        return {
          recovered: false,
          reason: `re-registration changed endpoint from ${this.#endpoint} to ${endpoint.endpointId}`,
        };
      }
      this.#applyRegistration(endpoint, deviceToken);
      return { recovered: true, source: "registration" };
    } catch (error) {
      return { recovered: false, reason: `re-registration failed: ${String(error)}` };
    }
  }

  async #registerWithToken(
    input: RegisterEndpointInput,
    token: string,
  ): Promise<{ endpoint: Endpoint; deviceToken: string }> {
    const path = `${LA}/endpoints`;
    const options = { method: "POST", body: { ...input, deviceId: this.#deviceId } };
    let lastError: unknown;
    for (let attempt = 1; attempt <= DEFAULT_ATTEMPTS; attempt += 1) {
      try {
        return await this.#attempt(path, options, this.#timeoutMs, attempt, DEFAULT_ATTEMPTS, token);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  #applyRegistration(endpoint: Endpoint, deviceToken: string): void {
    this.#deviceToken = normalizeBearerToken(deviceToken);
    this.#endpoint = endpoint.endpointId;
    this.setEndpointId(endpoint.endpointId);
    this.#onTokenRefreshed?.(deviceToken);
  }

  override async heartbeatEndpoint(endpointId: string): Promise<void> {
    await this.requestJson(`${LA}/endpoints/${encodeURIComponent(endpointId)}/heartbeat`, {
      method: "POST",
      timeoutMs: this.#heartbeatTimeoutMs,
    });
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
    input: {
      state?: "idle" | "busy" | "closed";
      allowInbound?: boolean;
      allowMidTurnSteer?: boolean;
      workspaceBoundary?: string;
    },
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

  override async whoami(): Promise<{ principalId: string; deviceId: string }> {
    const response = await this.requestJson<{
      principalId?: string;
      userId?: string;
      deviceId?: string | null;
    }>(`${LA}/whoami`);
    const principalId = response.principalId ?? response.userId;
    if (!principalId) {
      throw new ApiError(500, "invalid_response", response);
    }
    return { principalId, deviceId: response.deviceId ?? this.#deviceId };
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

  override async listCommunicationSessions(): Promise<CommunicationSession[]> {
    const rows = await this.requestJson<CommRow[]>(`${LA}/grants`);
    return rows.map(mapCommSession);
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

  override async delegateLocalAgentTask(
    input: LocalAgentDelegationInput,
    options: DelegationRequestOptions = {},
  ): Promise<LocalAgentDelegationResponse> {
    const response = await this.requestJson<unknown>(`${LA}/delegations`, {
      method: "POST",
      body: input,
      timeoutMs: options.timeoutMs ?? DEFAULT_DELEGATION_REQUEST_TIMEOUT_MS,
    });
    if (isCanonicalDelegationResponse(response)) return response;

    const row = hostedDelegationRow(response);
    if (row.status === "collaboration_requested") {
      return {
        status: "collaboration_requested",
        collaborationId: requiredDelegationString(row, "collaborationId"),
        clientMessageId: input.clientMessageId,
        ...(stringValue(row.correlationId) ?? input.correlationId
          ? { correlationId: stringValue(row.correlationId) ?? input.correlationId }
          : {}),
        duplicate: typeof row.duplicate === "boolean" ? row.duplicate : false,
      };
    }
    const communicationSessionId = requiredDelegationString(row, "communicationSessionId");
    const communicationSession = (await this.listCommunicationSessions())
      .find((session) => session.id === communicationSessionId);
    if (!communicationSession) {
      throw new ApiError(500, "invalid_response", {
        message: `Delegation response referenced unknown communication session ${communicationSessionId}`,
      });
    }

    const common = {
      communicationSession,
      ...(stringValue(row.collaborationId) ? { collaborationId: stringValue(row.collaborationId) } : {}),
      clientMessageId: input.clientMessageId,
      ...(stringValue(row.correlationId) ?? input.correlationId
        ? { correlationId: stringValue(row.correlationId) ?? input.correlationId }
        : {}),
      duplicate: typeof row.duplicate === "boolean" ? row.duplicate : false,
    };
    if (row.status === "grant_requested" || row.status === "folder_access_requested") {
      const approvalId = stringValue(row.approvalId);
      if (row.status === "folder_access_requested" && !approvalId) {
        throw new ApiError(500, "invalid_response", {
          message: "Folder-access response is missing approvalId",
        });
      }
      return {
        status: row.status,
        ...common,
        approvalKind: row.status === "folder_access_requested" || approvalId ? "folder" : "collaboration",
        ...(approvalId ? { approvalId } : {}),
      } as LocalAgentDelegationResponse;
    }

    const messageId = requiredDelegationString(row, "messageId");
    const deliveryId = requiredDelegationString(row, "deliveryId");
    const queuedAt = requiredDelegationString(row, "queuedAt");
    return {
      status: "delegated",
      ...common,
      receipt: {
        messageId,
        deliveryId,
        status: "queued",
        duplicate: common.duplicate,
        queuedAt,
      },
    };
  }

  override async acknowledgeDelivery(input: DeliveryAckInput): Promise<void> {
    const { messageId, ...body } = input;
    // Single attempt on purpose. Injector.ackReceived() awaits this serially for every message
    // still in 'received', so each attempt blocks the whole injector pass for its full cap —
    // an in-transport retry would double that stall for every stuck message. The injector is
    // already the retry loop: it re-drives this every runOnce with the same idempotent attemptId.
    await this.requestJson(`${LA}/messages/${encodeURIComponent(messageId)}/ack`, {
      method: "POST",
      body,
      attempts: 1,
    });
  }

  override async acknowledgeTrustedToolPolicy(input: {
    policyId: string;
    revision: number;
    canonicalFolder: string;
  }): Promise<void> {
    const { policyId, ...body } = input;
    await this.requestJson(`${LA}/trusted-tool-policies/${encodeURIComponent(policyId)}/ack`, {
      method: "POST",
      body,
    });
  }

  override async reportTrustedToolPolicyUsage(input: TrustedToolPolicyUsageInput): Promise<{
    acceptedThroughSequence: number;
    duplicate: boolean;
  }> {
    const { policyId, ...body } = input;
    return this.requestJson(`${LA}/trusted-tool-policies/${encodeURIComponent(policyId)}/usage`, {
      method: "POST",
      body,
    });
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
  ): Promise<{
    approvalId: string;
    status: string;
    decision: "allow" | "deny" | null;
    scope?: "once" | "session" | null;
  }> {
    return this.requestJson(`${LA}/tool-approvals`, { method: "POST", body: input });
  }

  async getToolApproval(approvalId: string): Promise<{
    status: string;
    decision: "allow" | "deny" | null;
    scope?: "once" | "session" | null;
  }> {
    return this.requestJson(`${LA}/tool-approvals/${encodeURIComponent(approvalId)}`);
  }

  override async getPairStatus(principalId: string): Promise<PairStatusResponse> {
    return this.requestJson<PairStatusResponse>(`${LA}/pair-status?principalId=${encodeURIComponent(principalId)}`);
  }

  override async resolvePerson(query: string): Promise<ResolvedPersonResponse> {
    const response = await this.requestJson<unknown>(`${LA}/resolve-person?q=${encodeURIComponent(query)}`);
    return parseResolvedPersonResponse(query, response);
  }

  override async startDeviceCode(input: StartDeviceCodeInput): Promise<StartDeviceCodeResponse> {
    return this.requestJson<StartDeviceCodeResponse>(`${LA}/device-code/start`, { method: "POST", body: input });
  }

  override async pollDeviceCode(pollToken: string): Promise<PollDeviceCodeResponse> {
    return this.requestJson<PollDeviceCodeResponse>(`${LA}/device-code/poll`, { method: "POST", body: { pollToken } });
  }
}

interface CommRow {
  commSessionId: string;
  requesterPrincipalId: string;
  requesterDeviceId?: string | null;
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

type HostedDelegationRow = Record<string, unknown> & {
  status: "collaboration_requested" | "grant_requested" | "folder_access_requested" | "delegated";
  communicationSessionId?: string;
};

function hostedDelegationRow(response: unknown): HostedDelegationRow {
  if (!response || typeof response !== "object") {
    throw new ApiError(500, "invalid_response", { message: "Delegation response must be an object" });
  }
  const row = response as Record<string, unknown>;
  if (
    row.status !== "collaboration_requested"
    && row.status !== "grant_requested"
    && row.status !== "folder_access_requested"
    && row.status !== "delegated"
  ) {
    throw new ApiError(500, "invalid_response", { message: "Delegation response has an invalid status" });
  }
  if (row.status !== "collaboration_requested" && !stringValue(row.communicationSessionId)) {
    throw new ApiError(500, "invalid_response", { message: "Delegation response is missing communicationSessionId" });
  }
  return row as HostedDelegationRow;
}

function isCanonicalDelegationResponse(response: unknown): response is LocalAgentDelegationResponse {
  if (!response || typeof response !== "object") return false;
  const row = response as Record<string, unknown>;
  const recognizedStatus = (
    row.status === "collaboration_requested"
    || row.status === "grant_requested"
    || row.status === "folder_access_requested"
    || row.status === "delegated"
  );
  if (!recognizedStatus) return false;
  if (row.status === "collaboration_requested") {
    return Boolean(stringValue(row.collaborationId) && stringValue(row.clientMessageId));
  }
  if (!row.communicationSession || typeof row.communicationSession !== "object") return false;
  return row.status !== "folder_access_requested" || Boolean(stringValue(row.approvalId));
}

function requiredDelegationString(row: Record<string, unknown>, key: string): string {
  const value = stringValue(row[key]);
  if (!value) throw new ApiError(500, "invalid_response", { message: `Delegation response is missing ${key}` });
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mapCommSession(row: CommRow): CommunicationSession {
  return {
    id: row.commSessionId,
    requester: {
      principalId: row.requesterPrincipalId,
      ...(row.requesterDeviceId ? { deviceId: row.requesterDeviceId } : {}),
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
  "collaboration.completed": "collaboration.completed",
  "collaboration.revoked": "collaboration.revoked",
  "collaboration.expired": "collaboration.expired",
  "message.dispatch": "message.dispatch",
  "relationship.policy_update": "relationship.policy_update",
  "trusted_tool_policy.upserted": "trusted_tool_policy.upserted",
  "trusted_tool_policy.revoked": "trusted_tool_policy.revoked",
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
