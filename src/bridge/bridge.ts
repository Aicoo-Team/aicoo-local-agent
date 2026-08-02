import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { FakeRuntimeAdapter } from "../adapters/fake/fake-adapter.js";
import { upsertRelationshipPreset, type RelationshipAccessPreset } from "../security/relationship-policy.js";
import type { LocalAgentDelegationInput, LocalAgentDelegationResponse, RuntimeEvent } from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { id } from "../shared/ids.js";
import { Injector, noOpInjectionHooks, type InjectionHooks } from "./injector.js";
import { BridgeSpool } from "./spool.js";

/**
 * The control plane declares an endpoint unreachable once lastSeenAt is older than 60s
 * (LOCAL_AGENT_ENDPOINT_STALE_MS), and lastSeenAt only advances on a *successful* heartbeat.
 * runHeartbeat is serial, so the worst gap between successful beats is
 * DEFAULT_HEARTBEAT_MS + attempts * (heartbeatCap + defaultRouteCap) = 10s + 2*(5s+5s) = 30s.
 * At the previous 20s this was 50s — one bad beat away from the endpoint being dropped from
 * routing, which presents to the sender as "their local agent is not running".
 */
const DEFAULT_HEARTBEAT_MS = 10_000;

export interface BridgeOptions {
  transport: HttpMessageTransport;
  spool: BridgeSpool;
  adapter: RuntimeAdapter;
  runtime?: "claude-code" | "codex";
  bridgeVersion?: string;
  adapterVersion?: string;
  heartbeatMs?: number;
  injectorMs?: number;
  relationshipPolicyFile?: string;
  hooks?: InjectionHooks;
  log?: (line: string) => void;
}

export class RuntimeBridge {
  readonly #controller = new AbortController();
  readonly #serverToNative = new Map<string, string>();
  #endpointId?: string;
  #loops: Promise<void>[] = [];
  #injector?: Injector;
  #pendingDefaultRoute?: string;
  #publishedDefaultRoute?: string;

  constructor(private readonly options: BridgeOptions) {}

  get endpointId(): string | undefined {
    return this.#endpointId;
  }

  get sessionMappings(): Array<{ nativeHandle: string; serverHandle: string; label: string }> {
    return this.options.spool.listSessionMappings();
  }

  async start(): Promise<{
    endpointId: string;
    principalId: string;
    deviceId: string;
    sessions: Array<{ nativeHandle: string; serverHandle: string }>;
    defaultRoute?: string;
  }> {
    await this.options.adapter.initialize?.();
    const adapterCapabilities = await this.options.adapter.capabilities();
    const endpoint = await this.options.transport.registerEndpoint({
      runtime: this.options.runtime ?? "claude-code",
      bridgeVersion: this.options.bridgeVersion ?? "0.1.0",
      adapterVersion: this.options.adapterVersion
        ?? (this.options.adapter instanceof FakeRuntimeAdapter ? FakeRuntimeAdapter.adapterVersion : "unknown"),
      capabilities: Object.entries(adapterCapabilities).filter(([, value]) => value).map(([key]) => key),
    });
    this.#endpointId = endpoint.endpointId;
    this.options.spool.setIdentity("endpointId", endpoint.endpointId);
    this.options.spool.setIdentity("principalId", endpoint.principalId);
    this.options.spool.setIdentity("serverKey", endpoint.endpointId);

    const sessions = await this.options.adapter.listSessions();
    for (const descriptor of sessions) {
      const existing = this.options.spool.getSessionMapping(descriptor.sessionHandle);
      let serverHandle = existing?.serverHandle;
      if (serverHandle) {
        try {
          await this.options.transport.updateRuntimeSession(endpoint.endpointId, serverHandle, {
            state: descriptor.state,
            allowInbound: descriptor.allowInbound,
          });
        } catch {
          serverHandle = undefined;
        }
      }
      if (!serverHandle) {
        const binding = await this.options.transport.registerRuntimeSession(endpoint.endpointId, {
          label: descriptor.label,
          state: descriptor.state === "closed" ? "idle" : descriptor.state,
          deliveryMode: "managed_stream",
          capabilities: {
            liveInject: adapterCapabilities.liveInject,
            midTurnSteer: adapterCapabilities.midTurnSteer,
            replyEvents: Boolean(adapterCapabilities.replyEvents),
          },
          allowInbound: descriptor.allowInbound && descriptor.state !== "closed",
          allowMidTurnSteer: false,
        });
        serverHandle = binding.sessionHandle;
        this.options.spool.saveSessionMapping(descriptor.sessionHandle, serverHandle, descriptor.label);
      }
      this.#serverToNative.set(serverHandle, descriptor.sessionHandle);
    }

    this.#injector = new Injector(
      this.options.transport,
      this.options.spool,
      this.options.adapter,
      endpoint.endpointId,
      this.#serverToNative,
      this.options.hooks ?? noOpInjectionHooks,
    );
    this.#loops = [
      this.runEvents(),
      this.runHeartbeat(),
      this.runInjector(),
      this.runPendingDelegations(),
      this.runOutboundReplies(),
      ...this.options.spool.listSessionMappings().map(({ nativeHandle, serverHandle }) =>
        this.runAdapterEvents(nativeHandle, serverHandle)),
    ];
    for (const loop of this.#loops) loop.catch((error) => this.options.log?.(`bridge loop stopped: ${String(error)}`));

    // Designate the primary session as the owner's person-default-runtime (device-token only;
    // a user-key CLI gets 401). Do NOT publish it here: creating the managed session can starve
    // the event loop for tens of seconds, during which this request's abort timer fires
    // spuriously (the endpoint itself answers in <1s). The heartbeat loop publishes it once,
    // after startup congestion clears — see runHeartbeat().
    const mappings = this.options.spool.listSessionMappings();
    this.#pendingDefaultRoute = mappings[0]?.serverHandle;

    return {
      endpointId: endpoint.endpointId,
      principalId: endpoint.principalId,
      deviceId: endpoint.deviceId,
      sessions: mappings.map(({ nativeHandle, serverHandle }) => ({ nativeHandle, serverHandle })),
      defaultRoute: this.#pendingDefaultRoute,
    };
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.options.adapter.close?.();
    await Promise.allSettled(this.#loops);
  }

  async injectOnce(): Promise<void> {
    await this.#injector?.runOnce();
  }

  private async runEvents(): Promise<void> {
    const endpointId = this.requireEndpoint();
    const serverKey = this.options.spool.getIdentity("serverKey") ?? endpointId;
    let reconnectDelayMs = 50;
    let reconnectFailures = 0;
    while (!this.#controller.signal.aborted) {
      const cursor = this.options.spool.cursor(serverKey);
      try {
        for await (const event of this.options.transport.subscribeEvents(cursor, this.#controller.signal)) {
          reconnectDelayMs = 50;
          reconnectFailures = 0;
          try {
            await this.handleEvent(event);
          } catch (error) {
            // A single bad event must never wedge the stream: if handleEvent throws, the cursor
            // would stall and the control plane would replay the same event forever. Log + advance.
            this.options.log?.(`event ${event.cursor} skipped: ${String(error)}`);
          }
          this.options.spool.saveCursor(serverKey, event.cursor);
        }
      } catch (error) {
        if (!this.#controller.signal.aborted) {
          if (error instanceof ApiError && error.status === 401) {
            this.options.log?.("\n[bridge] Device token revoked or invalid (401 Unauthorized). Stopping bridge.");
            this.options.log?.("Please run 'ccd login' to re-authenticate this machine.");
            await this.stop();
            return;
          }
          reconnectFailures += 1;
          if (shouldLogReconnect(reconnectFailures)) {
            this.options.log?.(
              `event stream reconnecting after ${reconnectFailures} failed attempt(s); retrying in ${reconnectDelayMs}ms: ${String(error)}`,
            );
          }
          await delay(reconnectDelayMs, this.#controller.signal);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
        }
      }
    }
  }

  private async handleEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === "message.dispatch") {
      const envelope = (event.data as { envelope?: { target?: { endpointId?: string } } }).envelope;
      if (envelope?.target?.endpointId !== this.requireEndpoint()) {
        throw new Error("Received an event for a different endpoint");
      }
      const stored = this.options.spool.storeDispatch(event);
      // Prompt best-effort device-ack — but NON-FATAL: on failure/timeout we leave the message
      // 'received' and the injector re-acks it (see Injector.ackReceived), so a slow ack can
      // never throw out of here and wedge the stream / stall the cursor. Skip expired messages
      // (the injector drops them) so we never ack a dead letter.
      if (new Date(stored.message.envelope.expiresAt).getTime() > Date.now()) {
        try {
          await this.options.transport.acknowledgeDelivery({
            messageId: stored.message.messageId,
            phase: "device_ack",
            attemptId: `device_ack:${stored.message.messageId}`,
            retryable: false,
          });
          this.options.spool.markDeviceAcked(stored.message.messageId);
        } catch (error) {
          this.options.log?.(`device-ack deferred to injector for ${stored.message.messageId}: ${String(error)}`);
        }
      }
    } else if (event.type === "comm.revoked") {
      const commSessionId = String(event.data.communicationSessionId ?? "");
      if (commSessionId) {
        this.options.spool.blockCommunicationSession(commSessionId, "communication_session_revoked", "revoked");
        await this.options.adapter.releaseCommunicationSession?.(commSessionId);
        const sessionHandle = typeof event.data.sessionHandle === "string" ? event.data.sessionHandle : undefined;
        if (sessionHandle && this.#serverToNative.has(sessionHandle)) this.#pendingDefaultRoute = sessionHandle;
        this.options.spool.markDelegationsFailed(commSessionId, "communication_session_revoked");
      }
    } else if (event.type === "comm.expired") {
      const commSessionId = String(event.data.communicationSessionId ?? "");
      if (commSessionId) {
        this.options.spool.blockCommunicationSession(commSessionId, "communication_session_expired", "expired");
        await this.options.adapter.releaseCommunicationSession?.(commSessionId);
        const sessionHandle = typeof event.data.sessionHandle === "string" ? event.data.sessionHandle : undefined;
        if (sessionHandle && this.#serverToNative.has(sessionHandle)) this.#pendingDefaultRoute = sessionHandle;
        this.options.spool.markDelegationsFailed(commSessionId, "communication_session_expired");
      }
    } else if (event.type === "comm.activated") {
      const commSessionId = String(event.data.communicationSessionId ?? "");
      if (commSessionId) this.options.spool.setGrant(
        commSessionId,
        "active",
        typeof event.data.grantExpiresAt === "string" ? event.data.grantExpiresAt : undefined,
      );
      const sessionHandle = typeof event.data.sessionHandle === "string" ? event.data.sessionHandle : undefined;
      if (sessionHandle && this.#serverToNative.has(sessionHandle)) {
        const nativeHandle = this.#serverToNative.get(sessionHandle);
        if (nativeHandle && commSessionId) {
          await this.options.adapter.prepareCommunicationSession?.(nativeHandle, commSessionId);
        }
        this.rotateDefaultRouteAfterActivation(sessionHandle);
      }
      if (commSessionId) await this.retryPendingDelegations(commSessionId);
    } else if (event.type === "relationship.policy_update") {
      this.applyRelationshipPolicyUpdate(event.data);
    }
  }

  private applyRelationshipPolicyUpdate(data: Record<string, unknown>): void {
    if (!this.options.relationshipPolicyFile) {
      this.options.log?.("relationship policy update ignored: no relationship policy file configured");
      return;
    }
    const principalId = stringField(data, "requesterPrincipalId") ?? stringField(data, "principalId");
    const deviceId = stringField(data, "requesterDeviceId") ?? stringField(data, "deviceId");
    const preset = stringField(data, "access") ?? stringField(data, "preset");
    const folder = stringField(data, "folderPath") ?? stringField(data, "folder");
    if (!principalId || !deviceId || !isRelationshipAccessPreset(preset)) {
      this.options.log?.("relationship policy update ignored: missing principalId, deviceId, or valid access preset");
      return;
    }
    try {
      upsertRelationshipPreset({
        file: this.options.relationshipPolicyFile,
        principalId,
        deviceId,
        preset,
        ...(folder ? { folder } : {}),
      });
      this.options.log?.(`relationship policy updated for ${principalId} (${preset})`);
    } catch (error) {
      this.options.log?.(`relationship policy update failed: ${String(error)}`);
    }
  }

  private async runHeartbeat(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await delay(this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      try {
        await this.options.transport.heartbeatEndpoint(this.requireEndpoint());
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.options.log?.("\n[bridge] Device token revoked or invalid (401 Unauthorized). Stopping bridge.");
          this.options.log?.("Please run 'ccd login' to re-authenticate this machine.");
          await this.stop();
          return;
        }
        this.options.log?.(`heartbeat failed: ${String(error)}`);
      }
      // Publish the default route from here, not start(): by the first heartbeat the
      // session-creation congestion that starves the event loop has cleared, so the request
      // no longer aborts spuriously. Attempt once per beat until it lands, then stop.
      if (this.#pendingDefaultRoute && !this.#controller.signal.aborted) {
        const handle = this.#pendingDefaultRoute;
        try {
          await this.options.transport.setDefaultRoute(this.requireEndpoint(), handle);
          this.#publishedDefaultRoute = handle;
          this.#pendingDefaultRoute = undefined;
          this.options.log?.(`[bridge] default route -> ${handle}`);
        } catch (error) {
          this.options.log?.(`default route not set yet, retrying next heartbeat: ${String(error)}`);
        }
      }
    }
  }

  private async runInjector(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await this.#injector?.runOnce();
      await delay(this.options.injectorMs ?? 100, this.#controller.signal);
    }
  }

  private async runPendingDelegations(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await this.retryPendingDelegations();
      await delay(this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, this.#controller.signal);
    }
  }

  private async retryPendingDelegations(commSessionId?: string): Promise<void> {
    for (const pending of this.options.spool.listPendingDelegations(commSessionId)) {
      if (Date.parse(pending.expiresAt) <= Date.now()) {
        if (pending.communicationSessionId) {
          this.options.spool.markDelegationsFailed(pending.communicationSessionId, "delegation_timeout");
        } else {
          this.options.spool.markDelegationAttempt(pending.clientMessageId, "delegation_timeout");
        }
        this.options.log?.(`delegation ${pending.clientMessageId} timed out before dispatch`);
        continue;
      }

      try {
        const result = await this.options.transport.delegateLocalAgentTask({
          target: pending.target,
          task: pending.task,
          sessionHandle: pending.sessionHandle,
          clientMessageId: pending.clientMessageId,
          ...(pending.correlationId ? { correlationId: pending.correlationId } : {}),
          ...(pending.requestedTtlMinutes ? { requestedTtlMinutes: pending.requestedTtlMinutes } : {}),
        });
        recordDelegationResult(this.options.spool, result, {
          target: pending.target,
          task: pending.task,
          sessionHandle: pending.sessionHandle,
          expiresAt: pending.expiresAt,
          requestedTtlMinutes: pending.requestedTtlMinutes,
        });
      } catch (error) {
        const terminal = error instanceof ApiError
          && error.status >= 400
          && error.status < 500
          && error.status !== 408
          && error.status !== 409
          && error.status !== 429;
        const message = error instanceof ApiError ? error.code : String(error);
        if (terminal && pending.communicationSessionId) {
          this.options.spool.markDelegationsFailed(pending.communicationSessionId, message);
        } else {
          this.options.spool.markDelegationAttempt(pending.clientMessageId, message);
        }
        if (terminal) this.options.log?.(`delegation ${pending.clientMessageId} failed: ${message}`);
      }
    }
  }

  private async runAdapterEvents(nativeHandle: string, serverHandle: string): Promise<void> {
    let cursor = this.options.spool.adapterCursor(nativeHandle);
    while (!this.#controller.signal.aborted) {
      try {
        for await (const event of this.options.adapter.subscribeSessionEvents(nativeHandle, cursor)) {
          if (this.#controller.signal.aborted) return;
          if (event.type === "reply" && event.inReplyTo) {
            const original = this.options.spool.getMessage(event.inReplyTo);
            if (!original) {
              this.options.log?.(`adapter reply ignored: inbound message ${event.inReplyTo} is not in the spool`);
            } else if (!original.envelope.replyTo) {
              const runtimeEventId = typeof event.payload?.runtimeEventId === "string"
                ? event.payload.runtimeEventId
                : `${nativeHandle}:${event.cursor ?? id("runtime_event")}`;
              const text = typeof event.payload?.text === "string"
                ? event.payload.text
                : JSON.stringify(event.payload ?? {});
              const correlationId = event.correlationId
                ?? original.envelope.correlationId
                ?? original.messageId;
              await (this.options.hooks ?? noOpInjectionHooks).beforeMessageEgress(
                { text, inReplyTo: original.messageId, correlationId },
                {
                  nativeSessionHandle: nativeHandle,
                  serverSessionHandle: serverHandle,
                  communicationSessionId: original.communicationSessionId,
                },
              );
              this.options.spool.storeOutboundReply({
                eventId: runtimeEventId,
                communicationSessionId: original.communicationSessionId,
                clientMessageId: `runtime-reply:${serverHandle}:${runtimeEventId}`,
                payload: { text, source: this.options.runtime ?? "claude-code" },
                replyTo: original.messageId,
                correlationId,
              });
            }
          }
          if (event.cursor) {
            cursor = event.cursor;
            this.options.spool.saveAdapterCursor(nativeHandle, cursor);
          }
        }
        if (!this.#controller.signal.aborted) {
          await delay(50, this.#controller.signal);
        }
      } catch (error) {
        if (this.#controller.signal.aborted) return;
        this.options.log?.(`adapter event stream reconnecting: ${String(error)}`);
        await delay(50, this.#controller.signal);
      }
    }
  }

  private async runOutboundReplies(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      for (const reply of this.options.spool.listPendingOutboundReplies()) {
        try {
          await this.options.transport.sendMessage({
            communicationSessionId: reply.communicationSessionId,
            clientMessageId: reply.clientMessageId,
            kind: "text",
            payload: reply.payload,
            replyTo: reply.replyTo,
            correlationId: reply.correlationId,
          });
          this.options.spool.markOutboundSent(reply.eventId);
        } catch (error) {
          const terminal = error instanceof ApiError
            && error.status >= 400
            && error.status < 500
            && error.status !== 408
            && error.status !== 429;
          this.options.spool.markOutboundAttempt(reply.eventId, error instanceof ApiError ? error.code : String(error), terminal);
          if (!terminal) break;
        }
      }
      await delay(this.options.injectorMs ?? 100, this.#controller.signal);
    }
  }

  private requireEndpoint(): string {
    if (!this.#endpointId) throw new Error("Bridge is not started");
    return this.#endpointId;
  }

  private rotateDefaultRouteAfterActivation(activatedServerHandle: string): void {
    const currentDefault = this.#pendingDefaultRoute ?? this.#publishedDefaultRoute;
    if (currentDefault && currentDefault !== activatedServerHandle) return;
    const replacement = this.options.spool.listSessionMappings()
      .map((mapping) => mapping.serverHandle)
      .find((serverHandle) => serverHandle !== activatedServerHandle);
    if (replacement) this.#pendingDefaultRoute = replacement;
  }
}

export async function requestRuntimeDelegation(input: {
  transport: BridgeOptions["transport"];
  spool: BridgeSpool;
  target: LocalAgentDelegationInput["target"];
  task: LocalAgentDelegationInput["task"];
  sessionHandle: string;
  clientMessageId: string;
  correlationId?: string;
  requestedTtlMinutes?: number;
  timeoutMs?: number;
}): Promise<LocalAgentDelegationResponse> {
  const expiresAt = new Date(Date.now() + (input.timeoutMs ?? 30 * 60_000)).toISOString();
  const result = await input.transport.delegateLocalAgentTask({
    target: input.target,
    task: input.task,
    sessionHandle: input.sessionHandle,
    clientMessageId: input.clientMessageId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.requestedTtlMinutes ? { requestedTtlMinutes: input.requestedTtlMinutes } : {}),
  });
  recordDelegationResult(input.spool, result, {
    target: input.target,
    task: input.task,
    sessionHandle: input.sessionHandle,
    expiresAt,
    requestedTtlMinutes: input.requestedTtlMinutes,
  });
  return result;
}

function recordDelegationResult(
  spool: BridgeSpool,
  result: LocalAgentDelegationResponse,
  input: {
    target: LocalAgentDelegationInput["target"];
    task: LocalAgentDelegationInput["task"];
    sessionHandle: string;
    expiresAt: string;
    requestedTtlMinutes?: number;
  },
): void {
  if (result.status === "delegated") {
    spool.storePendingDelegation({
      clientMessageId: result.clientMessageId,
      target: input.target,
      task: input.task,
      sessionHandle: input.sessionHandle,
      ...(result.correlationId ? { correlationId: result.correlationId } : {}),
      ...(input.requestedTtlMinutes ? { requestedTtlMinutes: input.requestedTtlMinutes } : {}),
      communicationSessionId: result.communicationSession.id,
      messageId: result.receipt.messageId,
      status: "delegated",
      expiresAt: input.expiresAt,
    });
    spool.markDelegationDelegated(result.clientMessageId, result.receipt.messageId, result.communicationSession.id);
    return;
  }

  spool.storePendingDelegation({
    clientMessageId: result.clientMessageId,
    target: input.target,
    task: input.task,
    sessionHandle: input.sessionHandle,
    ...(result.correlationId ? { correlationId: result.correlationId } : {}),
    ...(input.requestedTtlMinutes ? { requestedTtlMinutes: input.requestedTtlMinutes } : {}),
    communicationSessionId: result.communicationSession.id,
    status: "grant_requested",
    expiresAt: input.expiresAt,
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function shouldLogReconnect(failures: number): boolean {
  return failures <= 3 || (failures & (failures - 1)) === 0;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRelationshipAccessPreset(value: string | undefined): value is RelationshipAccessPreset {
  return value === "chat-only" || value === "read-project" || value === "edit-project";
}
