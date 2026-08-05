import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { requestRuntimeDelegation, RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type { RuntimeEvent } from "../../src/shared/contracts.js";
import { ApiError, type HttpMessageTransport } from "../../src/shared/http-client.js";

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
        tools: ["Read"],
        folders: [realpathSync.native(folder)],
      }],
    });
  });

  function setup(options?: {
    sessions?: Awaited<ReturnType<RuntimeAdapter["listSessions"]>>;
    transport?: HttpMessageTransport;
    relationshipPolicyFile?: string;
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
