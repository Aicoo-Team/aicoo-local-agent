import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "../../src/adapters/fake/fake-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import type { MessageDelivery } from "../../src/shared/contracts.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("real-network bridge E2E", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("delivers person_default_runtime to two principals in under 3s with honest mock runtime ACK", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const a = makeBridge(server.baseUrl, TOKENS.a);
    const b = makeBridge(server.baseUrl, TOKENS.b);
    cleanup.push(() => a.spool.close(), () => b.spool.close(), () => a.bridge.stop(), () => b.bridge.stop());
    const startedA = await a.bridge.start();
    const startedB = await b.bridge.start();
    await b.client.setDefaultRoute(startedB.endpointId, startedB.sessions[0]!.serverHandle);
    const comm = await a.client.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: startedA.endpointId,
      replySessionHandle: startedA.sessions[0]!.serverHandle,
    });
    await b.client.acceptCommunicationSession(comm.id);
    const sentAt = Date.now();
    const receipt = await a.client.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "bridge-happy",
      kind: "text",
      payload: { text: "hello B" },
    });
    const status = await waitFor(
      () => a.client.getMessageStatus(receipt.messageId),
      (value) => value.status === "runtime_acked",
    );
    expect(Date.now() - sentAt).toBeLessThan(3_000);
    expect(status.adapterLabel).toBe("[MOCK: FakeRuntimeAdapter]");
    expect(status.deviceAckReceivedAt).toBeDefined();
    expect(status.runtimeAckReceivedAt).toBeDefined();
    expect(b.adapter.listDelivered("fake-session-1")).toHaveLength(1);
    expect(b.adapter.listDelivered("fake-session-1")[0]?.trust).toBe("untrusted_external_content");
  });

  it("reports busy as runtime_pending, then accepts exactly once when idle", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const a = makeBridge(server.baseUrl, TOKENS.a);
    const b = makeBridge(server.baseUrl, TOKENS.b);
    b.adapter.setBusy("fake-session-1");
    cleanup.push(() => a.spool.close(), () => b.spool.close(), () => a.bridge.stop(), () => b.bridge.stop());
    const startedA = await a.bridge.start();
    const startedB = await b.bridge.start();
    await b.client.setDefaultRoute(startedB.endpointId, startedB.sessions[0]!.serverHandle);
    const comm = await a.client.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: startedA.endpointId,
      replySessionHandle: startedA.sessions[0]!.serverHandle,
    });
    await b.client.acceptCommunicationSession(comm.id);
    const receipt = await a.client.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "busy",
      kind: "text",
      payload: { text: "wait" },
    });
    const pending = await waitFor(
      () => a.client.getMessageStatus(receipt.messageId),
      (value) => value.status === "runtime_pending",
    );
    expect(pending.runtimeAckReceivedAt).toBeUndefined();
    b.adapter.setBusy("fake-session-1", false);
    const accepted = await waitFor(
      () => a.client.getMessageStatus(receipt.messageId),
      (value: MessageDelivery) => value.status === "runtime_acked",
    );
    expect(accepted.attempts.some((attempt) => attempt.resultCode === "queued_busy")).toBe(true);
    expect(b.adapter.listDelivered("fake-session-1")).toHaveLength(1);
  });
});

function makeBridge(baseUrl: string, token: string, injectorMs = 20) {
  const client = new HttpMessageTransport({ baseUrl, token, minReconnectMs: 10, maxReconnectMs: 50 });
  const spool = new BridgeSpool(":memory:");
  const adapter = new FakeRuntimeAdapter();
  return {
    client,
    spool,
    adapter,
    bridge: new RuntimeBridge({ transport: client, spool, adapter, heartbeatMs: 50, injectorMs }),
  };
}
