import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { Injector, MAX_INJECTION_ATTEMPTS } from "../../src/bridge/injector.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type { RuntimeEvent } from "../../src/shared/contracts.js";
import type { HttpMessageTransport } from "../../src/shared/http-client.js";

describe("Injector retry classification", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  it("treats permission_required as terminal instead of retrying forever", async () => {
    const spool = new BridgeSpool(":memory:");
    cleanups.push(() => spool.close());
    spool.storeDispatch(dispatchEvent());
    spool.markDeviceAcked("msg_permission");

    const transport = {
      validateInjection: vi.fn(async () => ({ valid: true as const })),
      acknowledgeDelivery: vi.fn(async () => undefined),
    } as unknown as HttpMessageTransport;
    const adapter = {
      deliverToSession: vi.fn(async () => ({ status: "permission_required" as const })),
    } as unknown as RuntimeAdapter;
    const injector = new Injector(
      transport,
      spool,
      adapter,
      "ep_b",
      new Map([["server-session", "native-session"]]),
    );

    await injector.runOnce();

    expect(spool.getMessage("msg_permission")).toMatchObject({
      status: "failed",
      lastResultCode: "permission_required",
      attemptCount: 1,
    });
    expect(spool.listInjectable()).toEqual([]);
    expect(transport.acknowledgeDelivery).toHaveBeenCalledWith(expect.objectContaining({
      phase: "runtime_failed",
      resultCode: "permission_required",
      retryable: false,
    }));
  });

  it("dead-letters retryable runtime failures after the max injection attempts", async () => {
    const spool = new BridgeSpool(":memory:");
    cleanups.push(() => spool.close());
    spool.storeDispatch(dispatchEvent());
    spool.markDeviceAcked("msg_permission");

    const transport = {
      validateInjection: vi.fn(async () => ({ valid: true as const })),
      acknowledgeDelivery: vi.fn(async () => undefined),
    } as unknown as HttpMessageTransport;
    const adapter = {
      deliverToSession: vi.fn(async () => ({ status: "runtime_unavailable" as const })),
    } as unknown as RuntimeAdapter;
    const injector = new Injector(
      transport,
      spool,
      adapter,
      "ep_b",
      new Map([["server-session", "native-session"]]),
    );

    for (let index = 0; index < MAX_INJECTION_ATTEMPTS + 1; index += 1) {
      await injector.runOnce();
    }

    expect(adapter.deliverToSession).toHaveBeenCalledTimes(MAX_INJECTION_ATTEMPTS);
    expect(spool.getMessage("msg_permission")).toMatchObject({
      status: "failed",
      lastResultCode: "max_injection_attempts_exceeded",
      attemptCount: MAX_INJECTION_ATTEMPTS,
    });
    expect(spool.listInjectable()).toEqual([]);
    expect(transport.acknowledgeDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "runtime_failed",
      resultCode: "max_injection_attempts_exceeded",
      retryable: false,
    }));
  });
});

function dispatchEvent(): RuntimeEvent {
  const now = new Date().toISOString();
  return {
    cursor: "1",
    type: "message.dispatch",
    endpointId: "ep_b",
    createdAt: now,
    data: {
      deliveryId: "del_permission",
      envelope: {
        id: "msg_permission",
        clientMessageId: "client_permission",
        communicationSessionId: "comm_1",
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
  };
}
