import { readFileSync } from "node:fs";
import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { BoundaryTelemetry } from "../adapters/boundary-telemetry.js";
import { FakeRuntimeAdapter } from "../adapters/fake/fake-adapter.js";
import {
  setRelationshipMcpGrants,
  upsertRelationshipPolicy,
  upsertRelationshipPreset,
  type RelationshipAccessPreset,
} from "../security/relationship-policy.js";
import {
  invalidateTrustedToolPolicy,
  markTrustedToolPolicyUsesReported,
  pendingTrustedToolPolicyUses,
  revokeTrustedToolPolicy,
  upsertTrustedToolPolicy,
} from "../security/trusted-tool-policy.js";
import { isFileAccessPreset } from "../security/relationship-access.js";
import { parseRemoteMcpGrants } from "../security/mcp-capability-grant.js";
import type {
  CollaborationTurnInput,
  LocalAgentDelegationInput,
  LocalAgentDelegationResponse,
  RuntimeEvent,
} from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { id } from "../shared/ids.js";
import { ContinuationStore } from "../shared/continuation-store.js";
import type { CapabilitySurface } from "../shared/capability-rollout.js";
import {
  GOVERNED_AGENT_CAPABILITIES,
  GOVERNED_AGENT_SURFACE,
} from "../shared/governed-agent-access.js";
import type { ToolApprovalGateway } from "../shared/tool-approval.js";
import { ContinuationRecovery } from "./continuation-recovery.js";
import { Injector, noOpInjectionHooks, type InjectionHooks } from "./injector.js";
import { HeartbeatWatchdog } from "./health.js";
import { BridgeSpool } from "./spool.js";

/**
 * The control plane declares an endpoint unreachable once lastSeenAt is older than 60s
 * (LOCAL_AGENT_ENDPOINT_STALE_MS), and lastSeenAt only advances on a *successful* heartbeat.
 * runHeartbeat is serial, so the worst gap between successful beats is
 * DEFAULT_HEARTBEAT_MS + attempts * (heartbeatCap + defaultRouteCap) = 10s + 2*(10s+5s) = 40s.
 * At the previous 20s this was 50s — one bad beat away from the endpoint being dropped from
 * routing, which presents to the sender as "their local agent is not running".
 */
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_HEARTBEAT_FAILURE_THRESHOLD = 3;
const DEFAULT_HEARTBEAT_MAX_BACKOFF_MS = 60_000;

export interface BridgeOptions {
  transport: HttpMessageTransport;
  spool: BridgeSpool;
  adapter: RuntimeAdapter;
  runtime?: "claude-code" | "codex";
  bridgeVersion?: string;
  adapterVersion?: string;
  workspaceBoundary?: string;
  capabilitySurface?: CapabilitySurface;
  heartbeatMs?: number;
  heartbeatFailureThreshold?: number;
  heartbeatMaxBackoffMs?: number;
  injectorMs?: number;
  relationshipPolicyFile?: string;
  trustedToolPolicyFile?: string;
  ownerPrincipalId?: string;
  ownerDeviceId?: string;
  /** Fresh for each bridge process. Folder grants are valid only while this instance is alive. */
  bridgeInstanceId?: string;
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
  readonly #pendingRelationshipMcpAcks = new Map<
    string,
    { policyIds: string[]; revision: number }
  >();
  #beforeExitHandler?: (code: number) => void;
  readonly #bridgeInstanceId: string;
  readonly #continuationRecovery: ContinuationRecovery;
  readonly #boundaryTelemetry: BoundaryTelemetry;
  readonly #heartbeatWatchdog: HeartbeatWatchdog;

  constructor(private readonly options: BridgeOptions) {
    this.#bridgeInstanceId = options.bridgeInstanceId ?? id("bridge");
    const continuationStore = new ContinuationStore(options.spool.db);
    this.#boundaryTelemetry = new BoundaryTelemetry(options.spool.db);
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#heartbeatWatchdog = new HeartbeatWatchdog({
      heartbeatMs,
      maxBackoffMs: options.heartbeatMaxBackoffMs ?? DEFAULT_HEARTBEAT_MAX_BACKOFF_MS,
      failureThreshold: options.heartbeatFailureThreshold ?? DEFAULT_HEARTBEAT_FAILURE_THRESHOLD,
      persist: (state) => options.spool.setIdentity("bridgeHealth", JSON.stringify(state)),
    });
    options.adapter.configureContinuationStore?.(continuationStore);
    this.#continuationRecovery = new ContinuationRecovery(
      continuationStore,
      options.adapter,
      options.log,
      this.#boundaryTelemetry,
      isToolApprovalGateway(options.transport) ? options.transport : undefined,
    );
  }

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
      capabilities: [
        ...Object.entries(adapterCapabilities).filter(([, value]) => value).map(([key]) => key),
        ...(this.options.capabilitySurface === "full-agent"
          ? [GOVERNED_AGENT_SURFACE, ...GOVERNED_AGENT_CAPABILITIES]
          : []),
        `bridge-instance:${this.#bridgeInstanceId}`,
      ],
    });
    this.#endpointId = endpoint.endpointId;
    this.options.spool.setIdentity("endpointId", endpoint.endpointId);
    this.options.spool.setIdentity("principalId", endpoint.principalId);
    this.options.spool.setIdentity("serverKey", endpoint.endpointId);

    const sessions = await this.options.adapter.listSessions();
    const activeNativeHandles = new Set(sessions.map((session) => session.sessionHandle));
    for (const stale of this.options.spool.listSessionMappings()) {
      if (activeNativeHandles.has(stale.nativeHandle)) continue;
      try {
        await this.options.transport.updateRuntimeSession(endpoint.endpointId, stale.serverHandle, {
          state: "closed",
          allowInbound: false,
        });
      } catch (error) {
        this.options.log?.(`stale runtime session could not be closed remotely: ${String(error)}`);
      }
      this.options.spool.deleteSessionMapping(stale.nativeHandle);
      this.options.log?.(`[bridge] removed stale session mapping ${stale.nativeHandle}`);
    }
    for (const descriptor of sessions) {
      const existing = this.options.spool.getSessionMapping(descriptor.sessionHandle);
      let serverHandle = existing?.serverHandle;
      if (serverHandle) {
        try {
          await this.options.transport.updateRuntimeSession(endpoint.endpointId, serverHandle, {
            state: descriptor.state,
            allowInbound: descriptor.allowInbound,
            ...(this.options.workspaceBoundary ? { workspaceBoundary: this.options.workspaceBoundary } : {}),
          });
        } catch {
          serverHandle = undefined;
        }
      }
      if (!serverHandle) {
        const binding = await this.options.transport.registerRuntimeSession(endpoint.endpointId, {
          label: descriptor.label,
          ...(this.options.workspaceBoundary ? { workspaceBoundary: this.options.workspaceBoundary } : {}),
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
    await this.#continuationRecovery.recover();
    this.#beforeExitHandler = (code) => {
      if (!this.#controller.signal.aborted) {
        (this.options.log ?? console.error)(
          `[bridge] FATAL: event loop drained while bridge was active (beforeExit code=${code})`,
        );
      }
    };
    process.on("beforeExit", this.#beforeExitHandler);
    this.#loops = [
      this.runEvents(),
      this.runHeartbeat(),
      this.runInjector(),
      this.runPendingDelegations(),
      this.runOutboundReplies(),
      this.runTrustedToolUsageReports(),
      this.runContinuationRecovery(),
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
    this.#heartbeatWatchdog.stop();
    if (this.#beforeExitHandler) {
      process.off("beforeExit", this.#beforeExitHandler);
      this.#beforeExitHandler = undefined;
    }
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
        let receivedEvent = false;
        for await (const event of this.options.transport.subscribeEvents(cursor, this.#controller.signal)) {
          receivedEvent = true;
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
        if (!this.#controller.signal.aborted) {
          reconnectFailures += 1;
          if (shouldLogReconnect(reconnectFailures)) {
            this.options.log?.(
              `event stream ended unexpectedly${receivedEvent ? " after receiving events" : " without events"}; `
                + `reconnecting in ${reconnectDelayMs}ms (attempt ${reconnectFailures})`,
            );
          }
          await delay(reconnectDelayMs, this.#controller.signal);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
        }
      } catch (error) {
        if (!this.#controller.signal.aborted) {
          if (error instanceof ApiError && error.status === 401) {
            const recovered = await this.options.transport.recoverAuthentication();
            if (recovered.recovered) {
              reconnectDelayMs = 50;
              reconnectFailures = 0;
              this.options.log?.(`[bridge] Device token refreshed from ${recovered.source}; reconnecting event stream.`);
              continue;
            }
            reconnectFailures += 1;
            if (shouldLogReconnect(reconnectFailures)) {
              this.options.log?.(
                `[bridge] Device token rejected (401); recovery pending: ${recovered.reason}. `
                  + `Retrying in ${reconnectDelayMs}ms.`,
              );
            }
            await delay(reconnectDelayMs, this.#controller.signal);
            reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
            continue;
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

  private async runTrustedToolUsageReports(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      await this.flushTrustedToolUsageReports();
      await delay(1_000, this.#controller.signal);
    }
  }

  private async runContinuationRecovery(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        await this.#continuationRecovery.recover();
      } catch (error) {
        this.options.log?.(`[bridge] continuation recovery deferred: ${String(error)}`);
      }
      await delay(250, this.#controller.signal);
    }
  }

  private async flushTrustedToolUsageReports(): Promise<void> {
    const file = this.options.trustedToolPolicyFile;
    const ownerPrincipalId = this.options.ownerPrincipalId;
    const ownerDeviceId = this.options.ownerDeviceId;
    if (!file || !ownerPrincipalId || !ownerDeviceId) return;
    try {
      const pending = pendingTrustedToolPolicyUses(file, ownerPrincipalId, ownerDeviceId);
      for (const { policy, serverRevision, uses } of pending) {
        try {
          const result = await this.options.transport.reportTrustedToolPolicyUsage({
            policyId: policy.policyId,
            revision: serverRevision,
            uses,
          });
          markTrustedToolPolicyUsesReported(file, policy.policyId, result.acceptedThroughSequence);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404 && error.code === "policy_not_found") {
            invalidateTrustedToolPolicy(file, policy.policyId, "Hosted policy no longer exists");
            this.options.log?.(`trusted tool policy invalidated after hosted deletion: ${policy.policyId}`);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      this.options.log?.(`trusted tool usage report deferred: ${String(error)}`);
    }
  }

  private async handleEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === "message.dispatch") {
      const envelope = (event.data as { envelope?: { target?: { endpointId?: string } } }).envelope;
      if (envelope?.target?.endpointId !== this.requireEndpoint()) {
        throw new Error("Received an event for a different endpoint");
      }
      const stored = this.options.spool.storeDispatch(event);
      if (stored.inserted && stored.message.envelope.kind === "task_invite") {
        const localHandle = this.#serverToNative.get(stored.message.sessionHandle)
          ?? stored.message.sessionHandle;
        this.#boundaryTelemetry.recordEligibleTask({
          messageId: stored.message.messageId,
          localHandle,
          correlationId: stored.message.envelope.correlationId ?? stored.message.messageId,
        });
      }
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
      }
      if (commSessionId) await this.retryPendingDelegations(commSessionId);
    } else if (
      event.type === "collaboration.completed"
      || event.type === "collaboration.revoked"
      || event.type === "collaboration.expired"
    ) {
      const collaborationId = stringField(event.data, "collaborationId");
      if (collaborationId) {
        const commSessionIds = this.options.spool.blockCollaboration(
          collaborationId,
          event.type.replace(".", "_"),
        );
        for (const commSessionId of commSessionIds) {
          await this.options.adapter.releaseCommunicationSession?.(commSessionId);
        }
      }
    } else if (event.type === "relationship.policy_update") {
      await this.applyRelationshipPolicyUpdate(event.data);
    } else if (event.type === "trusted_tool_policy.upserted") {
      await this.applyTrustedToolPolicyUpdate(event.data);
    } else if (event.type === "trusted_tool_policy.revoked") {
      this.applyTrustedToolPolicyRevocation(event.data);
    }
  }

  private async applyTrustedToolPolicyUpdate(data: Record<string, unknown>): Promise<void> {
    const file = this.options.trustedToolPolicyFile;
    const policyId = stringField(data, "policyId");
    const ownerPrincipalId = stringField(data, "ownerPrincipalId");
    const ownerDeviceId = stringField(data, "ownerDeviceId");
    const requesterPrincipalId = stringField(data, "requesterPrincipalId");
    const requesterDeviceId = stringField(data, "requesterDeviceId");
    const folder = stringField(data, "canonicalFolder");
    const accessPreset = stringField(data, "accessPreset");
    const scope = stringField(data, "scope");
    const createdFrom = stringField(data, "createdFrom");
    const createdBy = stringField(data, "createdBy");
    const createdAtValue = stringField(data, "createdAt");
    const bridgeInstanceId = stringField(data, "bridgeInstanceId");
    const revision = numberField(data, "revision");
    if (
      !file || !policyId || !ownerPrincipalId || !ownerDeviceId || !requesterPrincipalId
      || !requesterDeviceId || !folder || !accessPreset || !isFileAccessPreset(accessPreset) || revision === undefined
      || (createdFrom !== "settings" && createdFrom !== "approval_prompt") || !createdBy
      || (scope !== "bridge_run" && scope !== "persistent")
      || ownerPrincipalId !== this.options.ownerPrincipalId
      || ownerDeviceId !== this.options.ownerDeviceId
      || (scope === "bridge_run" && bridgeInstanceId !== this.#bridgeInstanceId)
    ) {
      this.options.log?.("trusted tool policy update ignored: invalid identity, tool, folder, or bridge run");
      return;
    }
    try {
      const policy = upsertTrustedToolPolicy({
        file,
        policyId,
        ownerPrincipalId,
        ownerDeviceId,
        requesterPrincipalId,
        requesterDeviceId,
        folder,
        accessPreset,
        scope,
        ...(scope === "bridge_run" ? { bridgeInstanceId } : {}),
        createdFrom,
        createdBy,
        ...(createdAtValue ? { createdAt: new Date(createdAtValue) } : {}),
        serverRevision: revision,
      });
      const expansion = recordField(data, "boundaryExpansion");
      const continuationId = expansion ? stringField(expansion, "continuationId") : undefined;
      const boundaryManifestHash = continuationId
        ? await this.options.adapter.attestBoundaryActivation?.({
            continuationId,
            grantId: policyId,
            grantRevision: revision,
            canonicalFolder: policy.canonicalFolder,
            accessPreset,
          })
        : undefined;
      if (continuationId && !boundaryManifestHash) {
        throw new Error("approved boundary could not be attested for its paused continuation");
      }
      await this.options.transport.acknowledgeTrustedToolPolicy({
        policyId,
        revision,
        canonicalFolder: policy.canonicalFolder,
        ...(boundaryManifestHash ? { boundaryManifestHash } : {}),
      });
      this.options.log?.(`trusted tool policy applied: ${accessPreset} for ${requesterPrincipalId}`);
      await this.#continuationRecovery.recover();
    } catch (error) {
      this.options.log?.(`trusted tool policy update failed: ${String(error)}`);
    }
  }

  private applyTrustedToolPolicyRevocation(data: Record<string, unknown>): void {
    const file = this.options.trustedToolPolicyFile;
    const policyId = stringField(data, "policyId");
    const revokedBy = stringField(data, "revokedBy") ?? this.options.ownerPrincipalId;
    const revision = numberField(data, "revision");
    if (!file || !policyId || !revokedBy || revision === undefined) return;
    try {
      revokeTrustedToolPolicy({ file, policyId, revokedBy, serverRevision: revision });
      this.options.log?.(`trusted tool policy revoked: ${policyId}`);
    } catch (error) {
      this.options.log?.(`trusted tool policy revocation failed: ${String(error)}`);
    }
  }

  private async applyRelationshipPolicyUpdate(data: Record<string, unknown>): Promise<void> {
    if (!this.options.relationshipPolicyFile) {
      this.options.log?.("relationship policy update ignored: no relationship policy file configured");
      return;
    }
    const principalId = stringField(data, "requesterPrincipalId") ?? stringField(data, "principalId");
    const deviceId = stringField(data, "requesterDeviceId") ?? stringField(data, "deviceId");
    const preset = stringField(data, "access") ?? stringField(data, "preset");
    const folder = stringField(data, "folderPath") ?? stringField(data, "folder");
    const bridgeInstanceId = stringField(data, "bridgeInstanceId");
    if (bridgeInstanceId && bridgeInstanceId !== this.#bridgeInstanceId) {
      this.options.log?.("relationship policy update ignored: it belongs to an earlier bridge run");
      return;
    }
    const hasExplicitTools = Object.prototype.hasOwnProperty.call(data, "tools");
    const hasMcpServers = Object.prototype.hasOwnProperty.call(data, "mcpServers");
    const hasMcpPolicyIds = Object.prototype.hasOwnProperty.call(data, "mcpPolicyIds");
    const mcpPolicyIds = Array.isArray(data.mcpPolicyIds)
      && data.mcpPolicyIds.length <= 16
      && data.mcpPolicyIds.every((policyId) => typeof policyId === "string" && policyId.trim())
      ? data.mcpPolicyIds.map((policyId) => String(policyId).trim())
      : undefined;
    const revision = numberField(data, "revision");
    const explicitTools = Array.isArray(data.tools)
      && data.tools.every((tool) => typeof tool === "string" && tool.trim())
      ? data.tools.map((tool) => String(tool).trim())
      : undefined;
    if (
      !principalId
      || !deviceId
      || (hasMcpPolicyIds && mcpPolicyIds === undefined)
      || (hasMcpPolicyIds && revision === undefined)
      || (hasExplicitTools && explicitTools === undefined)
      || (preset !== undefined && !isRelationshipAccessPreset(preset))
      || (!hasExplicitTools && !hasMcpServers && !isRelationshipAccessPreset(preset))
    ) {
      this.options.log?.("relationship policy update ignored: missing or invalid principal, device, tools, MCP grants, or preset");
      return;
    }
    try {
      // Validate every part before the first write so a malformed MCP grant cannot
      // partially apply an otherwise valid folder/tool update.
      const mcpServers = hasMcpServers ? parseRemoteMcpGrants(data.mcpServers) : undefined;
      const before = relationshipPolicyContents(this.options.relationshipPolicyFile);
      if (explicitTools !== undefined) {
        upsertRelationshipPolicy({
          file: this.options.relationshipPolicyFile,
          principalId,
          deviceId,
          tools: explicitTools,
          folders: folder ? [folder] : [],
        });
        this.options.log?.(
          `relationship policy updated for ${principalId} (tools: ${explicitTools.join(", ") || "none"})`,
        );
      } else if (isRelationshipAccessPreset(preset)) {
        upsertRelationshipPreset({
          file: this.options.relationshipPolicyFile,
          principalId,
          deviceId,
          preset: preset as RelationshipAccessPreset,
          ...(folder ? { folder } : {}),
        });
        this.options.log?.(`relationship policy updated for ${principalId} (${preset})`);
      }
      if (hasMcpServers) {
        setRelationshipMcpGrants({
          file: this.options.relationshipPolicyFile,
          principalId,
          deviceId,
          grants: mcpServers,
        });
        this.options.log?.(`relationship MCP grants updated for ${principalId}`);
      }
      if (before !== relationshipPolicyContents(this.options.relationshipPolicyFile)) {
        await this.options.adapter.invalidateRelationshipSessions?.(principalId, deviceId);
      }
      if (hasMcpServers && mcpPolicyIds && mcpPolicyIds.length > 0 && revision !== undefined) {
        const acknowledgement = {
          policyIds: mcpPolicyIds,
          revision,
        };
        this.#pendingRelationshipMcpAcks.set(
          `${revision}:${mcpPolicyIds.join(",")}`,
          acknowledgement,
        );
        await this.flushRelationshipMcpAcknowledgements();
      }
    } catch (error) {
      this.options.log?.(`relationship policy update failed: ${String(error)}`);
    }
  }

  private async flushRelationshipMcpAcknowledgements(): Promise<void> {
    for (const [key, acknowledgement] of this.#pendingRelationshipMcpAcks) {
      try {
        await this.options.transport.acknowledgeRelationshipMcpPolicies(acknowledgement);
        this.#pendingRelationshipMcpAcks.delete(key);
      } catch (error) {
        this.options.log?.(`relationship MCP acknowledgement deferred: ${String(error)}`);
      }
    }
  }

  private async runHeartbeat(): Promise<void> {
    let nextHeartbeatInMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let unhealthyReported = false;
    while (!this.#controller.signal.aborted) {
      const delayStartedAt = Date.now();
      await delay(nextHeartbeatInMs, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      const eventLoopLagMs = Math.max(0, Date.now() - delayStartedAt - nextHeartbeatInMs);
      try {
        await this.options.transport.heartbeatEndpoint(this.requireEndpoint());
        const health = this.#heartbeatWatchdog.recordSuccess(eventLoopLagMs);
        nextHeartbeatInMs = health.nextHeartbeatInMs;
        if (health.status === "healthy" && unhealthyReported) {
          this.options.log?.("[bridge] HEALTHY: heartbeat recovered; C2C presence is online again.");
          unhealthyReported = false;
        } else if (health.status === "degraded") {
          this.options.log?.(
            `[bridge] DEGRADED: heartbeat succeeded, but the event loop was delayed by ${eventLoopLagMs}ms.`,
          );
        }
      } catch (error) {
        let authenticationFailure = false;
        if (error instanceof ApiError && error.status === 401) {
          authenticationFailure = true;
          const recovered = await this.options.transport.recoverAuthentication();
          if (recovered.recovered) {
            this.options.log?.(`[bridge] Device token refreshed from ${recovered.source}; heartbeat will resume.`);
          } else {
            this.options.log?.(`[bridge] Device token rejected (401); recovery pending: ${recovered.reason}.`);
          }
        }
        const health = this.#heartbeatWatchdog.recordFailure(error, eventLoopLagMs);
        nextHeartbeatInMs = health.nextHeartbeatInMs;
        this.options.log?.(`heartbeat failed: ${String(error)}`);
        if (health.status === "unhealthy" && !unhealthyReported) {
          unhealthyReported = true;
          this.options.log?.(
            `[bridge] UNHEALTHY: ${health.consecutiveHeartbeatFailures} consecutive heartbeat failures; `
              + `presence is offline. Retrying with ${health.nextHeartbeatInMs}ms backoff. `
              + `Run 'ccd doctor --spool ${this.options.spool.getIdentity("spoolFile") ?? "<bridge.spool>"}' `
              + "and inspect bridge.log.",
          );
        }
        if (authenticationFailure) continue;
      }
      await this.flushRelationshipMcpAcknowledgements();
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
          ...(pending.context ? { context: pending.context } : {}),
          sessionHandle: pending.sessionHandle,
          clientMessageId: pending.clientMessageId,
          ...(pending.correlationId ? { correlationId: pending.correlationId } : {}),
          ...(pending.requestedTtlMinutes ? { requestedTtlMinutes: pending.requestedTtlMinutes } : {}),
        });
        recordDelegationResult(this.options.spool, result, {
          target: pending.target,
          task: pending.task,
          context: pending.context,
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
          if (event.type === "turn_failed") {
            this.#continuationRecovery.handleRuntimeEvent(nativeHandle, event);
          }
          if (event.type === "reply" && event.inReplyTo) {
            const original = this.options.spool.getMessage(event.inReplyTo);
            if (!original) {
              this.options.log?.(`adapter reply ignored: inbound message ${event.inReplyTo} is not in the spool`);
            } else if (
              !original.envelope.replyTo
              || original.envelope.collaborationTurn?.expectsReply === true
            ) {
              const runtimeEventId = typeof event.payload?.runtimeEventId === "string"
                ? event.payload.runtimeEventId
                : `${nativeHandle}:${event.cursor ?? id("runtime_event")}`;
              const rawText = typeof event.payload?.text === "string"
                ? event.payload.text
                : JSON.stringify(event.payload ?? {});
              const collaborationReply = original.envelope.collaborationTurn
                ? parseCollaborationRuntimeReply(rawText, runtimeEventId, original.envelope.collaborationTurn.turnId)
                : undefined;
              const text = collaborationReply?.text ?? rawText;
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
                ...(collaborationReply ? { collaborationTurn: collaborationReply.turn } : {}),
              });
              // Completion follows durable reply storage. A crash can replay an unsent reply,
              // but must never leave a completed continuation with no answer to deliver.
              this.#continuationRecovery.handleRuntimeEvent(nativeHandle, event);
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
            ...(reply.collaborationTurn ? { collaborationTurn: reply.collaborationTurn } : {}),
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

}

function relationshipPolicyContents(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseCollaborationRuntimeReply(
  rawText: string,
  runtimeEventId: string,
  parentTurnId: string,
): { text: string; turn: CollaborationTurnInput } {
  const fallback = {
    text: rawText,
    turn: {
      clientTurnId: `runtime-turn:${runtimeEventId}`,
      parentTurnId,
      type: "response" as const,
      expectsReply: false,
      outcome: "respond" as const,
    },
  };
  try {
    const parsed = JSON.parse(rawText.trim()) as Record<string, unknown>;
    const outcomes = new Set(["respond", "needs_owner", "propose_complete", "failed"]);
    if (typeof parsed.text !== "string" || typeof parsed.outcome !== "string" || !outcomes.has(parsed.outcome)) {
      return fallback;
    }
    const outcome = parsed.outcome as CollaborationTurnInput["outcome"];
    const expectsReply = (outcome === "respond" || outcome === "propose_complete")
      && parsed.expectsReply === true;
    return {
      text: parsed.text,
      turn: {
        clientTurnId: `runtime-turn:${runtimeEventId}`,
        parentTurnId,
        type: expectsReply ? "question" : "response",
        expectsReply,
        outcome,
      },
    };
  } catch {
    return fallback;
  }
}

export async function requestRuntimeDelegation(input: {
  transport: BridgeOptions["transport"];
  spool: BridgeSpool;
  target: LocalAgentDelegationInput["target"];
  task: LocalAgentDelegationInput["task"];
  context?: LocalAgentDelegationInput["context"];
  sessionHandle: string;
  clientMessageId: string;
  correlationId?: string;
  requestedTtlMinutes?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<LocalAgentDelegationResponse> {
  const expiresAt = new Date(Date.now() + (input.timeoutMs ?? 30 * 60_000)).toISOString();
  const delegation = {
    target: input.target,
    task: input.task,
    ...(input.context ? { context: input.context } : {}),
    sessionHandle: input.sessionHandle,
    clientMessageId: input.clientMessageId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.requestedTtlMinutes ? { requestedTtlMinutes: input.requestedTtlMinutes } : {}),
  };
  const result = input.requestTimeoutMs === undefined
    ? await input.transport.delegateLocalAgentTask(delegation)
    : await input.transport.delegateLocalAgentTask(delegation, { timeoutMs: input.requestTimeoutMs });
  recordDelegationResult(input.spool, result, {
    target: input.target,
    task: input.task,
    context: input.context,
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
    context?: LocalAgentDelegationInput["context"];
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
      ...(input.context ? { context: input.context } : {}),
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

  if (result.status === "collaboration_requested") {
    spool.storePendingDelegation({
      clientMessageId: result.clientMessageId,
      target: input.target,
      task: input.task,
      ...(input.context ? { context: input.context } : {}),
      sessionHandle: input.sessionHandle,
      ...(result.correlationId ? { correlationId: result.correlationId } : {}),
      ...(input.requestedTtlMinutes ? { requestedTtlMinutes: input.requestedTtlMinutes } : {}),
      status: "grant_requested",
      expiresAt: input.expiresAt,
    });
    return;
  }

  spool.storePendingDelegation({
    clientMessageId: result.clientMessageId,
    target: input.target,
    task: input.task,
    ...(input.context ? { context: input.context } : {}),
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

function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function recordField(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isRelationshipAccessPreset(value: string | undefined): value is RelationshipAccessPreset {
  return value === "chat-only" || value === "read-project" || value === "edit-project";
}

function isToolApprovalGateway(value: unknown): value is ToolApprovalGateway {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ToolApprovalGateway>;
  return typeof candidate.requestToolApproval === "function"
    && typeof candidate.getToolApproval === "function";
}
