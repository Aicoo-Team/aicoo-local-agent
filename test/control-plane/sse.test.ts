import { afterEach, describe, expect, it } from "vitest";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import type { RuntimeEvent } from "../../src/shared/contracts.js";
import { startTestServer, TOKENS } from "../helpers/harness.js";

describe("endpoint-scoped SSE and cursor replay", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("streams durable events, marks dispatch honestly, and replays after a cursor", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanups.push(server.close);
    const a = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.a });
    const b = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.b });
    const endpointA = await a.registerEndpoint(endpointInput());
    const endpointB = await b.registerEndpoint(endpointInput());
    const sessionA = await a.registerRuntimeSession(endpointA.endpointId, sessionInput("A"));
    const sessionB = await b.registerRuntimeSession(endpointB.endpointId, sessionInput("B"));
    await b.setDefaultRoute(endpointB.endpointId, sessionB.sessionHandle);
    const request = await a.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: endpointA.endpointId,
      replySessionHandle: sessionA.sessionHandle,
    });
    await b.acceptCommunicationSession(request.id);

    const controller = new AbortController();
    const iterator = b.subscribeEvents("0", controller.signal)[Symbol.asyncIterator]();
    const sent = await a.sendMessage({
      communicationSessionId: request.id,
      clientMessageId: "sse-1",
      kind: "text",
      payload: { text: "stream me" },
    });
    const dispatch = await nextType(iterator, "message.dispatch");
    expect((dispatch.data.envelope as { id: string }).id).toBe(sent.messageId);
    expect((await a.getMessageStatus(sent.messageId)).status).toBe("dispatched");
    controller.abort();
    await iterator.return?.();

    const replay = await b.fetchInbox("0");
    expect(replay.some((event) => event.type === "message.dispatch")).toBe(true);
    const cursor = replay.at(-1)?.cursor ?? "0";
    expect(await b.fetchInbox(cursor)).toEqual([]);

    const c = new HttpMessageTransport({ baseUrl: server.baseUrl, token: TOKENS.c });
    await expect(c.requestJson(`/api/v1/events/poll?endpointId=${endpointB.endpointId}&cursor=0`)).rejects.toMatchObject({
      status: 403,
      code: "endpoint_not_owned",
    });
  });
});

async function nextType(
  iterator: AsyncIterator<RuntimeEvent>,
  type: RuntimeEvent["type"],
): Promise<RuntimeEvent> {
  for (let index = 0; index < 20; index += 1) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value.type === type) return next.value;
  }
  throw new Error(`SSE event ${type} not received`);
}

function endpointInput() {
  return {
    runtime: "claude-code" as const,
    bridgeVersion: "test",
    adapterVersion: "fake-0.1.0",
    capabilities: ["liveInject"],
  };
}

function sessionInput(label: string) {
  return {
    label,
    state: "idle" as const,
    deliveryMode: "managed_stream" as const,
    capabilities: { liveInject: true, midTurnSteer: false, replyEvents: false },
    allowInbound: true,
    allowMidTurnSteer: false,
  };
}
