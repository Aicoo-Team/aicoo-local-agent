import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "../../src/adapters/fake/fake-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("revoke and fail-closed injection races", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("revoke blocks a device-acked local spool before injection; late ACK is audit-only", async () => {
    const setup = await setupDelayedInjector();
    const receipt = await setup.aClient.sendMessage({
      communicationSessionId: setup.commId,
      clientMessageId: "revoke-race",
      kind: "text",
      payload: { text: "must not inject" },
    });
    await waitFor(() => setup.aClient.getMessageStatus(receipt.messageId), (value) => value.status === "device_acked");
    await setup.bClient.revokeCommunicationSession(setup.commId);
    await waitFor(() => setup.bSpool.getMessage(receipt.messageId), (value) => value?.status === "blocked");
    await setup.bBridge.injectOnce();
    expect(setup.bAdapter.listDelivered("fake-session-1")).toHaveLength(0);
    const late = await setup.bClient.requestJson<{ recorded: string }>(`/api/v1/messages/${receipt.messageId}/ack`, {
      method: "POST",
      body: { phase: "runtime_ack", attemptId: "late", runtimeAckId: "late-fact" },
    });
    expect(late.recorded).toBe("audit_only");
    expect((await setup.aClient.getMessageStatus(receipt.messageId)).status).toBe("revoked");
  });

  it("control-plane loss after durable receive fails closed and performs no adapter injection", async () => {
    const setup = await setupDelayedInjector();
    const receipt = await setup.aClient.sendMessage({
      communicationSessionId: setup.commId,
      clientMessageId: "offline-validation",
      kind: "text",
      payload: { text: "validate first" },
    });
    await waitFor(() => setup.aClient.getMessageStatus(receipt.messageId), (value) => value.status === "device_acked");
    await setup.aBridge.stop();
    await setup.bBridge.stop();
    await setup.closeServer();
    await setup.bBridge.injectOnce();
    expect(setup.bSpool.getMessage(receipt.messageId)?.status).toBe("blocked_offline");
    expect(setup.bAdapter.listDelivered("fake-session-1")).toHaveLength(0);
  });

  async function setupDelayedInjector() {
    const server = await startTestServer({ pingMs: 50 });
    let serverClosed = false;
    const closeServer = async () => {
      if (!serverClosed) {
        serverClosed = true;
        await server.close();
      }
    };
    cleanup.push(closeServer);
    const aClient = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.a, timeoutMs: 300 });
    const bClient = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.b, timeoutMs: 300 });
    const aSpool = new BridgeSpool(":memory:");
    const bSpool = new BridgeSpool(":memory:");
    const aAdapter = new FakeRuntimeAdapter();
    const bAdapter = new FakeRuntimeAdapter();
    const aBridge = new RuntimeBridge({ transport: aClient, spool: aSpool, adapter: aAdapter, injectorMs: 100_000 });
    const bBridge = new RuntimeBridge({ transport: bClient, spool: bSpool, adapter: bAdapter, injectorMs: 100_000 });
    cleanup.push(() => aSpool.close(), () => bSpool.close(), () => aBridge.stop(), () => bBridge.stop());
    const a = await aBridge.start();
    const b = await bBridge.start();
    await bClient.setDefaultRoute(b.endpointId, b.sessions[0]!.serverHandle);
    const comm = await aClient.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: a.endpointId,
      replySessionHandle: a.sessions[0]!.serverHandle,
    });
    await bClient.acceptCommunicationSession(comm.id);
    return { aClient, bClient, aBridge, bBridge, bSpool, bAdapter, commId: comm.id, closeServer };
  }
});
