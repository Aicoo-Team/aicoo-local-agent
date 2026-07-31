import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { FakeRuntimeAdapter } from "../adapters/fake/fake-adapter.js";
import type { RuntimeEvent } from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { id } from "../shared/ids.js";
import { Injector, noOpInjectionHooks, type InjectionHooks } from "./injector.js";
import { BridgeSpool } from "./spool.js";

export interface BridgeOptions {
  transport: HttpMessageTransport;
  spool: BridgeSpool;
  adapter: RuntimeAdapter;
  runtime?: "claude-code" | "codex";
  bridgeVersion?: string;
  adapterVersion?: string;
  heartbeatMs?: number;
  injectorMs?: number;
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

  async start(): Promise<{ endpointId: string; sessions: Array<{ nativeHandle: string; serverHandle: string }>; defaultRoute?: string }> {
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
    while (!this.#controller.signal.aborted) {
      const cursor = this.options.spool.cursor(serverKey);
      try {
        for await (const event of this.options.transport.subscribeEvents(cursor, this.#controller.signal)) {
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
          this.options.log?.(`event stream reconnecting: ${String(error)}`);
          await delay(50, this.#controller.signal);
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
      }
    } else if (event.type === "comm.expired") {
      const commSessionId = String(event.data.communicationSessionId ?? "");
      if (commSessionId) {
        this.options.spool.blockCommunicationSession(commSessionId, "communication_session_expired", "expired");
        await this.options.adapter.releaseCommunicationSession?.(commSessionId);
        const sessionHandle = typeof event.data.sessionHandle === "string" ? event.data.sessionHandle : undefined;
        if (sessionHandle && this.#serverToNative.has(sessionHandle)) this.#pendingDefaultRoute = sessionHandle;
      }
    } else if (event.type === "comm.activated") {
      const commSessionId = String(event.data.communicationSessionId ?? "");
      if (commSessionId) this.options.spool.setGrant(
        commSessionId,
        "active",
        typeof event.data.grantExpiresAt === "string" ? event.data.grantExpiresAt : undefined,
      );
      const sessionHandle = typeof event.data.sessionHandle === "string" ? event.data.sessionHandle : undefined;
      if (sessionHandle && this.#serverToNative.has(sessionHandle)) this.rotateDefaultRouteAfterActivation(sessionHandle);
    }
  }

  private async runHeartbeat(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await delay(this.options.heartbeatMs ?? 20_000, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      try {
        await this.options.transport.heartbeatEndpoint(this.requireEndpoint());
      } catch (error) {
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
