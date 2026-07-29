import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { Injector, MAX_INJECTION_ATTEMPTS } from "../../src/bridge/injector.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type { MessageEnvelope } from "../../src/shared/contracts.js";
import type { HttpMessageTransport } from "../../src/shared/http-client.js";

type DeliveryStatus = Awaited<ReturnType<RuntimeAdapter["deliverToSession"]>>["status"];

describe("injection retry ceiling", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("fails a permission_required message terminally instead of retrying it forever", async () => {
    const setup = makeInjector("permission_required");

    await setup.injector.runOnce();

    // The session binding is never cleared, so a retry can only get the same answer:
    // one attempt, terminal failure, and the sender is told.
    expect(setup.spool.getMessage("msg_1")?.status).toBe("failed");
    expect(setup.spool.attemptCount("msg_1")).toBe(1);
    expect(setup.acks.at(-1)).toMatchObject({ phase: "runtime_failed", retryable: false });
    expect(setup.spool.listInjectable()).toHaveLength(0);

    await setup.injector.runOnce();
    expect(setup.delivered).toBe(1);
  });

  it("dead-letters a genuinely retryable failure once the attempt ceiling is reached", async () => {
    const setup = makeInjector("runtime_unavailable");

    for (let round = 0; round < MAX_INJECTION_ATTEMPTS - 1; round += 1) {
      await setup.injector.runOnce();
      expect(setup.spool.getMessage("msg_1")?.status).toBe("runtime_pending");
    }

    // The ceiling is checked after the attempt is counted, so the MAX-th delivery is
    // the one that dead-letters — the message is tried exactly MAX times, never more.
    await setup.injector.runOnce();
    expect(setup.spool.attemptCount("msg_1")).toBe(MAX_INJECTION_ATTEMPTS);
    expect(setup.spool.getMessage("msg_1")?.status).toBe("failed");
    expect(setup.acks.at(-1)).toMatchObject({ phase: "runtime_failed", retryable: false });
    expect(setup.spool.listInjectable()).toHaveLength(0);

    const delivered = setup.delivered;
    await setup.injector.runOnce();
    expect(setup.delivered).toBe(delivered);
  });

  function makeInjector(status: DeliveryStatus) {
    const directory = mkdtempSync(join(tmpdir(), "ccd-retry-"));
    directories.push(directory);
    const spool = new BridgeSpool(join(directory, "test.spool"));
    spool.storeDispatch({
      id: "evt_1",
      type: "message.dispatch",
      seq: 1,
      data: { deliveryId: "dlv_1", envelope: envelope() },
    } as never);
    spool.markDeviceAcked("msg_1");

    const acks: Array<{ phase: string; retryable: boolean; resultCode?: string }> = [];
    const state = { delivered: 0 };
    const transport = {
      validateInjection: async () => ({ valid: true as const }),
      acknowledgeDelivery: async (input: { phase: string; retryable: boolean; resultCode?: string }) => {
        acks.push(input);
      },
    } as unknown as HttpMessageTransport;
    const adapter = {
      deliverToSession: async () => {
        state.delivered += 1;
        return { status } as never;
      },
    } as unknown as RuntimeAdapter;

    const injector = new Injector(transport, spool, adapter, "ep_b", new Map([["rs_b", "native-1"]]));
    return {
      spool,
      acks,
      injector,
      get delivered() {
        return state.delivered;
      },
    };
  }
});

function envelope(): MessageEnvelope {
  return {
    id: "msg_1",
    clientMessageId: "client_1",
    communicationSessionId: "comm_1",
    senderPrincipalId: "prn_a",
    target: { kind: "runtime_session", principalId: "prn_b", endpointId: "ep_b", sessionHandle: "rs_b" },
    kind: "text",
    payload: { text: "hello" },
    sequence: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  } as unknown as MessageEnvelope;
}
