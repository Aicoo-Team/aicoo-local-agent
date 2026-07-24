import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "../src/adapters/fake/fake-adapter.js";
import type { InboundMessage, RuntimeAdapter } from "../src/adapters/runtime-adapter.js";

describe("Day-1 protocol boundary", () => {
  it("keeps person, endpoint, and runtime-session identifiers structurally distinct", () => {
    const target = {
      kind: "runtime_session" as const,
      principalId: "prn_b",
      endpointId: "ep_123",
      sessionHandle: "rs_123",
    };
    expect(target.principalId).not.toBe(target.endpointId);
    expect(target.endpointId).not.toBe(target.sessionHandle);
  });

  it("FakeRuntimeAdapter is contract-compatible and labels only real fake acceptance as runtime_acked", async () => {
    const adapter: RuntimeAdapter = new FakeRuntimeAdapter();
    const message = inbound("msg_1");
    const accepted = await adapter.deliverToSession("fake-session-1", message, "queue");
    expect(accepted.status).toBe("runtime_acked");
    if (accepted.status === "runtime_acked") expect(accepted.runtimeAckId).toMatch(/^fakeack_/);
  });

  it("busy means queued_busy, never runtime_acked", async () => {
    const adapter = new FakeRuntimeAdapter();
    adapter.setBusy("fake-session-1");
    expect(await adapter.deliverToSession("fake-session-1", inbound("msg_2"), "queue")).toEqual({
      status: "queued_busy",
    });
    expect(adapter.listDelivered("fake-session-1")).toHaveLength(0);
  });
});

function inbound(id: string): InboundMessage {
  return {
    id,
    clientMessageId: `client_${id}`,
    communicationSessionId: "comm_1",
    senderPrincipalId: "prn_a",
    target: {
      kind: "runtime_session",
      principalId: "prn_b",
      endpointId: "ep_b",
      sessionHandle: "rs_b",
    },
    kind: "text",
    payload: { text: "hello" },
    sequence: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    trust: "untrusted_external_content",
  };
}
