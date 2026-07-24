import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "../../src/adapters/fake/fake-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("offline durable replay and duplicate-event dedupe", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("stays queued offline, replays on reconnect, and never duplicates adapter side effects", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const aClient = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.a });
    const bClient1 = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.b });
    const aSpool = new BridgeSpool(":memory:");
    const bSpool = new BridgeSpool(":memory:");
    const aAdapter = new FakeRuntimeAdapter();
    const bAdapter = new FakeRuntimeAdapter();
    const aBridge = new RuntimeBridge({ transport: aClient, spool: aSpool, adapter: aAdapter, injectorMs: 20 });
    const bBridge1 = new RuntimeBridge({ transport: bClient1, spool: bSpool, adapter: bAdapter, injectorMs: 20 });
    cleanup.push(() => aSpool.close(), () => bSpool.close(), () => aBridge.stop());
    const a = await aBridge.start();
    const b = await bBridge1.start();
    await bClient1.setDefaultRoute(b.endpointId, b.sessions[0]!.serverHandle);
    await bBridge1.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const comm = await aClient.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: a.endpointId,
      replySessionHandle: a.sessions[0]!.serverHandle,
    });
    await bClient1.acceptCommunicationSession(comm.id);
    const receipt = await aClient.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "offline",
      kind: "text",
      payload: { text: "queued while offline" },
    });
    expect((await aClient.getMessageStatus(receipt.messageId)).status).toBe("queued");

    const bClient2 = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.b, minReconnectMs: 10 });
    const bBridge2 = new RuntimeBridge({ transport: bClient2, spool: bSpool, adapter: bAdapter, injectorMs: 20 });
    cleanup.push(() => bBridge2.stop());
    await bBridge2.start();
    await waitFor(() => aClient.getMessageStatus(receipt.messageId), (value) => value.status === "runtime_acked");
    expect(bAdapter.listDelivered("fake-session-1")).toHaveLength(1);
    await bBridge2.stop();

    bSpool.db.prepare("UPDATE cursors SET last_seq = 0").run();
    const bClient3 = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.b, minReconnectMs: 10 });
    const bBridge3 = new RuntimeBridge({ transport: bClient3, spool: bSpool, adapter: bAdapter, injectorMs: 20 });
    cleanup.push(() => bBridge3.stop());
    await bBridge3.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bSpool.count()).toBe(1);
    expect(bAdapter.listDelivered("fake-session-1")).toHaveLength(1);
  });
});
