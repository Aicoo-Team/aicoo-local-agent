import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { requestRuntimeDelegation, RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type {
  RegisterRuntimeSessionInput,
  RuntimeEvent,
  RuntimeSessionBinding,
} from "../../src/shared/contracts.js";
import { ApiError, type HttpMessageTransport } from "../../src/shared/http-client.js";
import { ContinuationStore } from "../../src/shared/continuation-store.js";
import {
  markTrustedToolPolicyUsed,
  readTrustedToolPolicies,
  upsertTrustedToolPolicy,
} from "../../src/security/trusted-tool-policy.js";

describe("RuntimeBridge communication session release", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.useRealTimers();
  });

  it("blocks local pending work and releases adapter context on revoke", async () => {
    const { bridge, spool, adapter } = setup();
    storeDeviceAckedMessage(spool, "comm_ended");

    await callHandleEvent(bridge, event("comm.revoked", "comm_ended"));

    expect(spool.getMessage("msg_ended")).toMatchObject({
      status: "blocked",
      lastResultCode: "communication_session_revoked",
    });
    expect(adapter.releaseCommunicationSession).toHaveBeenCalledWith("comm_ended");
  });

  it("blocks local pending work and releases adapter context on expiry", async () => {
    const { bridge, spool, adapter } = setup();
    storeDeviceAckedMessage(spool, "comm_ended");

    await callHandleEvent(bridge, event("comm.expired", "comm_ended"));

    expect(spool.getMessage("msg_ended")).toMatchObject({
      status: "blocked",
      lastResultCode: "communication_session_expired",
    });
    expect(adapter.releaseCommunicationSession).toHaveBeenCalledWith("comm_ended");
  });

  it("prepares the mapped runtime session when a new grant activates", async () => {
    const { bridge, adapter } = setup({
      sessions: [{ sessionHandle: "native-session", label: "Native session", state: "idle", allowInbound: true }],
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();
    await callHandleEvent(bridge, event("comm.activated", "comm_new", "server-session"));

    expect(adapter.prepareCommunicationSession).toHaveBeenCalledWith("native-session", "comm_new");
  });

  it("publishes the enforced workspace boundary with each managed session", async () => {
    const registerRuntimeSession = vi.fn(async (
      _endpointId: string,
      input: RegisterRuntimeSessionInput,
    ): Promise<RuntimeSessionBinding> => ({
      sessionHandle: "server-session",
      endpointId: "ep_b",
      principalId: "prn_b",
      label: input.label,
      ...(input.workspaceBoundary ? { workspaceBoundary: input.workspaceBoundary } : {}),
      state: input.state,
      deliveryMode: input.deliveryMode,
      capabilities: input.capabilities,
      allowInbound: input.allowInbound,
      allowMidTurnSteer: input.allowMidTurnSteer,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    }));
    const { bridge } = setup({
      sessions: [{ sessionHandle: "native-session", label: "Native session", state: "idle", allowInbound: true }],
      transport: transport({ registerRuntimeSession }),
      workspaceBoundary: "/srv/checkout",
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();

    expect(registerRuntimeSession).toHaveBeenCalledWith("ep_b", expect.objectContaining({
      workspaceBoundary: "/srv/checkout",
    }));
  });

  it("publishes a fresh bridge-run identity with endpoint capabilities", async () => {
    const registerEndpoint = vi.fn(async () => ({
      endpointId: "ep_b", principalId: "prn_b", deviceId: "device_b",
      runtime: "codex" as const,
      bridgeVersion: "0.1.0",
      adapterVersion: "0.1.0",
      capabilities: [],
      presence: "online" as const,
      lastSeenAt: new Date().toISOString(),
    }));
    const { bridge } = setup({
      bridgeInstanceId: "bridge-run-b",
      transport: transport({ registerEndpoint }),
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();

    expect(registerEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: expect.arrayContaining(["bridge-instance:bridge-run-b"]),
    }));
  });

  it("removes stale spool mappings when the configured session count shrinks", async () => {
    const updateRuntimeSession = vi.fn(async (
      endpointId: string,
      sessionHandle: string,
      input: { state?: "idle" | "busy" | "closed"; allowInbound?: boolean },
    ): Promise<RuntimeSessionBinding> => ({
      sessionHandle,
      endpointId,
      principalId: "prn_b",
      label: "Removed session",
      state: input.state ?? "idle",
      deliveryMode: "managed_stream",
      capabilities: { liveInject: true, midTurnSteer: false, replyEvents: true },
      allowInbound: input.allowInbound ?? true,
      allowMidTurnSteer: false,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    }));
    const { bridge, spool } = setup({
      sessions: [{ sessionHandle: "native-session", label: "Native session", state: "idle", allowInbound: true }],
      transport: transport({ updateRuntimeSession }),
    });
    spool.saveSessionMapping("removed-session", "server-removed", "Removed session");
    cleanups.push(() => void bridge.stop());

    const started = await bridge.start();

    expect(updateRuntimeSession).toHaveBeenCalledWith("ep_b", "server-removed", {
      state: "closed",
      allowInbound: false,
    });
    expect(spool.listSessionMappings()).toEqual([
      { nativeHandle: "native-session", serverHandle: "server-session", label: "Native session" },
    ]);
    expect(started.sessions).toEqual([
      { nativeHandle: "native-session", serverHandle: "server-session" },
    ]);
  });

  it("retries a parked local delegation when the peer approves the grant", async () => {
    const delegateLocalAgentTask = vi.fn(async () => ({
      status: "delegated" as const,
      communicationSession: communicationSession("comm_new", "active"),
      receipt: {
        messageId: "msg_delegate",
        deliveryId: "del_delegate",
        status: "queued" as const,
        duplicate: false,
        queuedAt: new Date().toISOString(),
      },
      clientMessageId: "delegate_1",
      correlationId: "corr_1",
      duplicate: false,
    }));
    const { bridge, spool } = setup({
      sessions: [{ sessionHandle: "native-session", label: "Native session", state: "idle", allowInbound: true }],
      transport: transport({ delegateLocalAgentTask }),
    });
    cleanups.push(() => void bridge.stop());
    await bridge.start();

    // Regression: a local-to-local task parked while waiting for approval must
    // resume from the bridge when the out-of-band grant activation arrives.
    spool.storePendingDelegation({
      clientMessageId: "delegate_1",
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "Summarize README",
      sessionHandle: "server-session",
      correlationId: "corr_1",
      communicationSessionId: "comm_new",
      status: "grant_requested",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await callHandleEvent(bridge, event("comm.activated", "comm_new", "server-session"));

    expect(delegateLocalAgentTask).toHaveBeenCalledTimes(1);
    expect(delegateLocalAgentTask).toHaveBeenCalledWith({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "Summarize README",
      sessionHandle: "server-session",
      clientMessageId: "delegate_1",
      correlationId: "corr_1",
    });
    expect(spool.listPendingDelegations("comm_new")).toEqual([]);
  });

  it("stores a local delegation for the running bridge to resume after approval", async () => {
    const delegateLocalAgentTask = vi.fn(async () => ({
      status: "grant_requested" as const,
      communicationSession: communicationSession("comm_waiting", "pending"),
      clientMessageId: "delegate_2",
      correlationId: "corr_2",
      duplicate: false,
    }));
    const spool = new BridgeSpool(":memory:");
    cleanups.push(() => spool.close());

    const result = await requestRuntimeDelegation({
      transport: transport({ delegateLocalAgentTask }),
      spool,
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "Deploy preview",
      sessionHandle: "server-session",
      clientMessageId: "delegate_2",
      correlationId: "corr_2",
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("grant_requested");
    expect(spool.listPendingDelegations("comm_waiting")).toMatchObject([{
      clientMessageId: "delegate_2",
      task: "Deploy preview",
      sessionHandle: "server-session",
      correlationId: "corr_2",
      status: "grant_requested",
    }]);
  });

  it("keeps HTTP submission and peer-reply timeouts independent", async () => {
    const delegateLocalAgentTask = vi.fn(async () => ({
      status: "grant_requested" as const,
      communicationSession: communicationSession("comm_timeout", "pending"),
      clientMessageId: "delegate_timeout",
      correlationId: "corr_timeout",
      duplicate: false,
    }));
    const spool = new BridgeSpool(":memory:");
    cleanups.push(() => spool.close());

    await requestRuntimeDelegation({
      transport: transport({ delegateLocalAgentTask }),
      spool,
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "Create a file",
      sessionHandle: "server-session",
      clientMessageId: "delegate_timeout",
      correlationId: "corr_timeout",
      timeoutMs: 300_000,
      requestTimeoutMs: 30_000,
    });

    expect(delegateLocalAgentTask).toHaveBeenCalledWith({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "Create a file",
      sessionHandle: "server-session",
      clientMessageId: "delegate_timeout",
      correlationId: "corr_timeout",
    }, { timeoutMs: 30_000 });
    expect(spool.listPendingDelegations("comm_timeout")[0]?.expiresAt).toBeTruthy();
    expect(new Date(spool.listPendingDelegations("comm_timeout")[0]!.expiresAt).getTime())
      .toBeGreaterThan(Date.now() + 250_000);
  });

  it("backs off event stream reconnect failures", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { bridge } = setup({
      transport: transport({
        subscribeEvents: vi.fn(async function* () {
          attempts += 1;
          throw new Error("stream failed fast");
        }),
      }),
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();
    await vi.advanceTimersByTimeAsync(49);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(4);
  });

  it("recovers a revoked token and re-subscribes instead of stopping", async () => {
    let attempts = 0;
    const recoverAuthentication = vi.fn(async () => ({ recovered: true as const, source: "credentials" as const }));
    const logs: string[] = [];
    const { bridge } = setup({
      log: (line) => logs.push(line),
      transport: transport({
        recoverAuthentication,
        subscribeEvents: vi.fn(async function* (_cursor?: string, signal?: AbortSignal) {
          attempts += 1;
          if (attempts === 1) throw new ApiError(401, "unauthorized", null);
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        }),
      }),
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();
    await vi.waitFor(() => expect(attempts).toBe(2));

    expect(recoverAuthentication).toHaveBeenCalledTimes(1);
    expect(logs).toContain("[bridge] Device token refreshed from credentials; reconnecting event stream.");
  });

  it("logs and backs off when an event stream ends normally", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    let attempts = 0;
    const { bridge } = setup({
      log: (line) => logs.push(line),
      transport: transport({
        subscribeEvents: vi.fn(async function* () {
          attempts += 1;
        }),
      }),
    });
    cleanups.push(() => void bridge.stop());

    await bridge.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(attempts).toBe(2);
    expect(logs[0]).toContain("event stream ended unexpectedly without events");
  });

  it("applies relationship policy updates from the app", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-policy-update-"));
    const policyFile = join(directory, "relationships.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    const { bridge } = setup({ relationshipPolicyFile: policyFile });

    await callHandleEvent(bridge, {
      cursor: "policy-1",
      type: "relationship.policy_update",
      endpointId: "ep_b",
      createdAt: new Date().toISOString(),
      data: {
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        access: "read-project",
        folderPath: folder,
      },
    });

    expect(JSON.parse(readFileSync(policyFile, "utf8"))).toEqual({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["GitDiff", "GitLog", "GitStatus", "Read"],
        folders: [realpathSync.native(folder)],
      }],
    });
  });

  it("ignores a folder policy event from an earlier bridge run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-stale-policy-update-"));
    const policyFile = join(directory, "relationships.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    const { bridge } = setup({ relationshipPolicyFile: policyFile, bridgeInstanceId: "bridge-run-new" });

    await callHandleEvent(bridge, {
      cursor: "policy-stale-1",
      type: "relationship.policy_update",
      endpointId: "ep_b",
      createdAt: new Date().toISOString(),
      data: {
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        access: "edit-project",
        folderPath: folder,
        bridgeInstanceId: "bridge-run-old",
      },
    });

    expect(() => readFileSync(policyFile, "utf8")).toThrow();
  });

  it("applies an exact trusted tool policy for the current owner bridge run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-trusted-policy-update-"));
    const trustedToolPolicyFile = join(directory, "trusted-tools.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    const acknowledgeTrustedToolPolicy = vi.fn(async () => undefined);
    const { bridge } = setup({
      trustedToolPolicyFile,
      bridgeInstanceId: "bridge-run-new",
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      transport: transport({ acknowledgeTrustedToolPolicy }),
    });

    await callHandleEvent(bridge, {
      cursor: "policy-trusted-1",
      type: "trusted_tool_policy.upserted",
      endpointId: "ep_b",
      createdAt: new Date().toISOString(),
      data: {
        policyId: "ttp_server_1",
        ownerPrincipalId: "prn_b",
        ownerDeviceId: "device_b",
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        canonicalFolder: folder,
        accessPreset: "read-project",
        scope: "bridge_run",
        bridgeInstanceId: "bridge-run-new",
        revision: 7,
        createdFrom: "settings",
        createdBy: "prn_b",
        createdAt: new Date().toISOString(),
      },
    });

    expect(readTrustedToolPolicies(trustedToolPolicyFile).policies).toEqual([
      expect.objectContaining({
        policyId: "ttp_server_1",
        accessPreset: "read-project",
        canonicalFolder: realpathSync.native(folder),
        scope: "bridge_run",
        status: "active",
      }),
    ]);
    expect(acknowledgeTrustedToolPolicy).toHaveBeenCalledWith({
      policyId: "ttp_server_1",
      revision: 7,
      canonicalFolder: realpathSync.native(folder),
    });
  });

  it("resumes an approved durable continuation when its trusted policy becomes active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-continuation-policy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const trustedToolPolicyFile = join(directory, "trusted-tools.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    const { bridge, spool, adapter } = setup({
      trustedToolPolicyFile,
      bridgeInstanceId: "bridge-run-new",
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      transport: transport({ acknowledgeTrustedToolPolicy: vi.fn(async () => undefined) }),
    });
    const store = new ContinuationStore(spool.db);
    const checkpoint = store.create({
      idempotencyKey: "comm_resume:msg_resume:tool_resume",
      correlationId: "corr_resume",
      communicationSessionId: "comm_resume",
      messageId: "msg_resume",
      sessionHandle: "native-session",
      runtimeTurnId: "turn_resume",
      originalMessage: { kind: "text", payload: { text: "Read the shared folder" } },
      requestedCapability: {
        toolName: "Read",
        canonicalResource: join(folder, "README.md"),
        summary: "Read the shared README",
      },
    });
    store.markApproved(checkpoint.continuationId, {
      grantId: "ttp_server_resume",
      grantRevision: 8,
      approvedCanonicalFolder: realpathSync.native(folder),
      approvedAccessPreset: "read-project",
      expectedBoundaryManifestHash: "manifest_resume",
    });
    adapter.quiesceContinuation = vi.fn(async () => undefined);
    adapter.rebuildContinuation = vi.fn(async () => ({ boundaryManifestHash: "manifest_resume" }));
    adapter.resumeContinuation = vi.fn(async () => ({ status: "runtime_acked", runtimeAckId: "ack_resume" }));

    const policyEvent: RuntimeEvent = {
      cursor: "policy-trusted-resume",
      type: "trusted_tool_policy.upserted",
      endpointId: "ep_b",
      createdAt: new Date().toISOString(),
      data: {
        policyId: "ttp_server_resume",
        ownerPrincipalId: "prn_b",
        ownerDeviceId: "device_b",
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        canonicalFolder: folder,
        accessPreset: "read-project",
        scope: "bridge_run",
        bridgeInstanceId: "bridge-run-new",
        revision: 8,
        createdFrom: "approval_prompt",
        createdBy: "prn_b",
        createdAt: new Date().toISOString(),
      },
    };
    await callHandleEvent(bridge, policyEvent);
    await callHandleEvent(bridge, policyEvent);

    expect(adapter.quiesceContinuation).toHaveBeenCalledOnce();
    expect(adapter.rebuildContinuation).toHaveBeenCalledOnce();
    expect(adapter.resumeContinuation).toHaveBeenCalledOnce();
    expect(store.find(checkpoint.continuationId)?.state).toBe("resuming");
  });

  it("reports durable trusted-policy usage and removes only acknowledged sequences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-trusted-usage-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const trustedToolPolicyFile = join(directory, "trusted-tools.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    upsertTrustedToolPolicy({
      file: trustedToolPolicyFile,
      policyId: "ttp_usage_1",
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      requesterPrincipalId: "prn_a",
      requesterDeviceId: "device-a1",
      folder,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "settings",
      createdBy: "prn_b",
      serverRevision: 9,
    });
    markTrustedToolPolicyUsed(trustedToolPolicyFile, "ttp_usage_1");
    const reportTrustedToolPolicyUsage = vi.fn(async () => ({
      acceptedThroughSequence: 1,
      duplicate: false,
    }));
    const { bridge } = setup({
      trustedToolPolicyFile,
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      transport: transport({ reportTrustedToolPolicyUsage }),
    });

    await (bridge as unknown as { flushTrustedToolUsageReports(): Promise<void> })
      .flushTrustedToolUsageReports();

    expect(reportTrustedToolPolicyUsage).toHaveBeenCalledWith({
      policyId: "ttp_usage_1",
      revision: 9,
      uses: [{ sequence: 1, usedAt: expect.any(String) }],
    });
    expect(readTrustedToolPolicies(trustedToolPolicyFile).policies[0]?.pendingUses).toEqual([]);
  });

  it("invalidates a stale local policy when hosted usage reports policy_not_found", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-missing-hosted-policy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const trustedToolPolicyFile = join(directory, "trusted-tools.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    upsertTrustedToolPolicy({
      file: trustedToolPolicyFile,
      policyId: "ttp_missing",
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      requesterPrincipalId: "prn_a",
      requesterDeviceId: "device-a1",
      folder,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "settings",
      createdBy: "prn_b",
      serverRevision: 2,
    });
    markTrustedToolPolicyUsed(trustedToolPolicyFile, "ttp_missing");
    const reportTrustedToolPolicyUsage = vi.fn(async () => {
      throw new ApiError(404, "policy_not_found", {});
    });
    const { bridge } = setup({
      trustedToolPolicyFile,
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      transport: transport({ reportTrustedToolPolicyUsage }),
    });

    await (bridge as unknown as { flushTrustedToolUsageReports(): Promise<void> })
      .flushTrustedToolUsageReports();

    expect(reportTrustedToolPolicyUsage).toHaveBeenCalledTimes(1);
    expect(readTrustedToolPolicies(trustedToolPolicyFile).policies[0]).toMatchObject({
      status: "invalid",
      pendingUses: [],
      invalidatedReason: "Hosted policy no longer exists",
    });
  });

  it("does not expand an explicit empty tool list from a folder-boundary update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-boundary-update-"));
    const policyFile = join(directory, "relationships.json");
    const folder = join(directory, "shared");
    mkdirSync(folder);
    const { bridge } = setup({ relationshipPolicyFile: policyFile });

    await callHandleEvent(bridge, {
      cursor: "policy-boundary-1",
      type: "relationship.policy_update",
      endpointId: "ep_b",
      createdAt: new Date().toISOString(),
      data: {
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        access: "edit-project",
        tools: [],
        folderPath: folder,
      },
    });

    expect(JSON.parse(readFileSync(policyFile, "utf8"))).toEqual({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: [],
        folders: [realpathSync.native(folder)],
      }],
    });
  });

  function setup(options?: {
    sessions?: Awaited<ReturnType<RuntimeAdapter["listSessions"]>>;
    transport?: HttpMessageTransport;
    relationshipPolicyFile?: string;
    trustedToolPolicyFile?: string;
    bridgeInstanceId?: string;
    ownerPrincipalId?: string;
    ownerDeviceId?: string;
    workspaceBoundary?: string;
    log?: (line: string) => void;
  }): {
    bridge: RuntimeBridge;
    spool: BridgeSpool;
    adapter: RuntimeAdapter & {
      releaseCommunicationSession: ReturnType<typeof vi.fn>;
      prepareCommunicationSession: ReturnType<typeof vi.fn>;
    };
  } {
    const spool = new BridgeSpool(":memory:");
    cleanups.push(() => spool.close());
    const adapter = {
      capabilities: vi.fn(async () => ({
        listSessions: true,
        startSession: true,
        resumeSession: true,
        liveInject: true,
        midTurnSteer: false,
        replyEvents: true,
      })),
      listSessions: vi.fn(async () => options?.sessions ?? []),
      subscribeSessionEvents: vi.fn(async function* () {}),
      deliverToSession: vi.fn(),
      releaseCommunicationSession: vi.fn(async () => undefined),
      prepareCommunicationSession: vi.fn(async () => undefined),
    } as unknown as RuntimeAdapter & {
      releaseCommunicationSession: ReturnType<typeof vi.fn>;
      prepareCommunicationSession: ReturnType<typeof vi.fn>;
    };
    const bridge = new RuntimeBridge({
      transport: options?.transport ?? transport(),
      spool,
      adapter,
      heartbeatMs: 60_000,
      injectorMs: 60_000,
      relationshipPolicyFile: options?.relationshipPolicyFile,
      trustedToolPolicyFile: options?.trustedToolPolicyFile,
      bridgeInstanceId: options?.bridgeInstanceId,
      ownerPrincipalId: options?.ownerPrincipalId,
      ownerDeviceId: options?.ownerDeviceId,
      workspaceBoundary: options?.workspaceBoundary,
      log: options?.log,
    });
    return { bridge, spool, adapter };
  }
});

async function callHandleEvent(bridge: RuntimeBridge, runtimeEvent: RuntimeEvent): Promise<void> {
  await (bridge as unknown as { handleEvent(event: RuntimeEvent): Promise<void> }).handleEvent(runtimeEvent);
}

function event(
  type: "comm.revoked" | "comm.expired" | "comm.activated",
  communicationSessionId: string,
  sessionHandle?: string,
): RuntimeEvent {
  return {
    cursor: "1",
    type,
    endpointId: "ep_b",
    createdAt: new Date().toISOString(),
    data: { communicationSessionId, ...(sessionHandle ? { sessionHandle } : {}) },
  };
}

function transport(overrides: Partial<HttpMessageTransport> = {}): HttpMessageTransport {
  return {
    registerEndpoint: vi.fn(async () => ({ endpointId: "ep_b", principalId: "prn_b", deviceId: "device_b" })),
    registerRuntimeSession: vi.fn(async () => ({ sessionHandle: "server-session" })),
    updateRuntimeSession: vi.fn(async () => undefined),
    heartbeatEndpoint: vi.fn(async () => undefined),
    setDefaultRoute: vi.fn(async () => undefined),
    delegateLocalAgentTask: vi.fn(async () => {
      throw new Error("delegateLocalAgentTask not mocked");
    }),
    subscribeEvents: vi.fn(async function* () {}),
    ...overrides,
  } as unknown as HttpMessageTransport;
}

function communicationSession(id: string, status: "pending" | "active") {
  return {
    id,
    requester: {
      principalId: "prn_a",
      deviceId: "device-a1",
      replyEndpointId: "ep_a",
      replySessionHandle: "server-session",
    },
    recipient: {
      principalId: "prn_b",
      targetKind: "person_default_runtime" as const,
      endpointId: "ep_b",
      sessionHandle: "server-session-b",
    },
    status,
    capabilities: ["message:send", "message:reply"] as ["message:send", "message:reply"],
    requestedAt: new Date().toISOString(),
    requestExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(status === "active"
      ? {
          activatedAt: new Date().toISOString(),
          grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
      : {}),
  };
}

function storeDeviceAckedMessage(spool: BridgeSpool, communicationSessionId: string): void {
  const now = new Date().toISOString();
  spool.storeDispatch({
    cursor: "1",
    type: "message.dispatch",
    endpointId: "ep_b",
    createdAt: now,
    data: {
      deliveryId: "del_ended",
      envelope: {
        id: "msg_ended",
        clientMessageId: "client_ended",
        communicationSessionId,
        senderPrincipalId: "prn_a",
        senderDeviceId: "device-a1",
        target: {
          kind: "runtime_session",
          principalId: "prn_b",
          endpointId: "ep_b",
          sessionHandle: "server-session",
        },
        kind: "text",
        payload: { text: "hello" },
        sequence: 1,
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  spool.markDeviceAcked("msg_ended");
}
