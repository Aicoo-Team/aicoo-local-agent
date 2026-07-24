import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/claude-code-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { FakeClaudeAgentDriver } from "../helpers/fake-claude-driver.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("P1 Claude managed-session reply path", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("routes B's correlated reply to A's frozen originating session without ping-pong", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const a = makeClaudeBridge(server.baseUrl, TOKENS.a, "A should not auto-answer a reply");
    const b = makeClaudeBridge(server.baseUrl, TOKENS.b, "P1_REPLY_FROM_B");
    cleanup.push(
      () => a.spool.close(),
      () => b.spool.close(),
      () => a.bridge.stop(),
      () => b.bridge.stop(),
    );

    const startedA = await a.bridge.start();
    const startedB = await b.bridge.start();
    const routeA = startedA.sessions[0]!;
    const routeB = startedB.sessions[0]!;
    await b.client.setDefaultRoute(startedB.endpointId, routeB.serverHandle);
    const comm = await a.client.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: startedA.endpointId,
      replySessionHandle: routeA.serverHandle,
    });
    await b.client.acceptCommunicationSession(comm.id);

    const initial = await a.client.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "p1-initial",
      kind: "text",
      payload: { text: "Reply exactly P1_REPLY_FROM_B; do not use tools." },
      correlationId: "p1-correlation",
    });
    await waitFor(
      () => a.client.getMessageStatus(initial.messageId),
      (status) => status.status === "runtime_acked",
    );

    const reply = await waitFor(
      () => server.db.prepare(
        `SELECT message_id, target_endpoint_id, target_session_handle, reply_to, correlation_id
         FROM messages WHERE comm_session_id = ? AND reply_to = ?`,
      ).get(comm.id, initial.messageId) as ReplyRow | undefined,
      (row) => Boolean(row),
    );
    expect(reply).toMatchObject({
      target_endpoint_id: startedA.endpointId,
      target_session_handle: routeA.serverHandle,
      reply_to: initial.messageId,
      correlation_id: "p1-correlation",
    });
    await waitFor(
      () => b.client.getMessageStatus(reply!.message_id),
      (status) => status.status === "runtime_acked",
    );

    expect(b.driver.received).toHaveLength(1);
    expect(b.driver.received[0]?.shouldQuery).toBe(true);
    expect(a.driver.received).toHaveLength(1);
    expect(a.driver.received[0]?.shouldQuery).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const messageCount = server.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE comm_session_id = ?",
    ).get(comm.id) as { count: number };
    expect(Number(messageCount.count)).toBe(2);
  });

  it("persists adapter cursor and reply outbox across a bridge crash without duplicates", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-reply-outbox-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "bridge.spool.db");
    const input = {
      eventId: "provider-result-1",
      communicationSessionId: "comm_1",
      clientMessageId: "runtime-reply:session:provider-result-1",
      payload: { text: "durable reply" },
      replyTo: "msg_1",
      correlationId: "corr_1",
    };
    const first = new BridgeSpool(file);
    first.storeOutboundReply(input);
    first.storeOutboundReply(input);
    first.saveAdapterCursor("claude-managed-1", "7");
    first.close();

    const recovered = new BridgeSpool(file);
    expect(recovered.adapterCursor("claude-managed-1")).toBe("7");
    expect(recovered.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ eventId: "provider-result-1", attemptCount: 0, status: "pending" }),
    ]);
    recovered.markOutboundSent("provider-result-1");
    recovered.close();

    const final = new BridgeSpool(file);
    expect(final.listPendingOutboundReplies()).toHaveLength(0);
    expect(final.getOutboundReply("provider-result-1")).toMatchObject({ status: "sent", attemptCount: 1 });
    final.close();
  });
});

interface ReplyRow {
  message_id: string;
  target_endpoint_id: string;
  target_session_handle: string;
  reply_to: string;
  correlation_id: string;
}

function makeClaudeBridge(baseUrl: string, token: string, reply: string) {
  const client = new HttpMessageTransport({ baseUrl, token, minReconnectMs: 10, maxReconnectMs: 50 });
  const spool = new BridgeSpool(":memory:");
  const driver = new FakeClaudeAgentDriver(reply);
  const adapter = new ClaudeCodeAdapter({
    stateFile: ":memory:",
    cwd: process.cwd(),
    driver,
    turnAckTimeoutMs: 500,
  });
  return {
    client,
    spool,
    driver,
    bridge: new RuntimeBridge({
      transport: client,
      spool,
      adapter,
      adapterVersion: ClaudeCodeAdapter.adapterVersion,
      heartbeatMs: 50,
      injectorMs: 20,
    }),
  };
}
