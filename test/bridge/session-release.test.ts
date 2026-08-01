import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type { RuntimeEvent } from "../../src/shared/contracts.js";
import type { HttpMessageTransport } from "../../src/shared/http-client.js";

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

  function setup(options?: {
    sessions?: Awaited<ReturnType<RuntimeAdapter["listSessions"]>>;
    transport?: HttpMessageTransport;
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
    subscribeEvents: vi.fn(async function* () {}),
    ...overrides,
  } as unknown as HttpMessageTransport;
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
