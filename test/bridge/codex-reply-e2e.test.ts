import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/claude-code-adapter.js";
import { CodexAdapter } from "../../src/adapters/codex/codex-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { FakeClaudeAgentDriver } from "../helpers/fake-claude-driver.js";
import { FakeCodexDriver } from "../helpers/fake-codex-driver.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("P1 Claude-to-Codex managed-session reply path", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("routes Codex B's correlated reply to Claude A's frozen originating session without ping-pong", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const a = makeClaudeBridge(server.baseUrl, TOKENS.a, "A should not auto-answer a reply");
    const b = makeCodexBridge(server.baseUrl, TOKENS.b, "P1_REPLY_FROM_CODEX_B");
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
    expect(routeB.nativeHandle).toBe("codex-managed-1");
    const endpointRow = server.db.prepare(
      "SELECT runtime, adapter_version FROM endpoints WHERE endpoint_id = ?",
    ).get(startedB.endpointId) as { runtime: string; adapter_version: string };
    expect(endpointRow).toMatchObject({ runtime: "codex", adapter_version: CodexAdapter.adapterVersion });

    await b.client.setDefaultRoute(startedB.endpointId, routeB.serverHandle);
    const comm = await a.client.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: startedA.endpointId,
      replySessionHandle: routeA.serverHandle,
    });
    await b.client.acceptCommunicationSession(comm.id);

    const initial = await a.client.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "p1-codex-initial",
      kind: "text",
      payload: { text: "Reply exactly P1_REPLY_FROM_CODEX_B; do not use tools." },
      correlationId: "p1-codex-correlation",
    });
    await waitFor(
      () => a.client.getMessageStatus(initial.messageId),
      (status) => status.status === "runtime_acked",
    );

    const reply = await waitFor(
      () => server.db.prepare(
        `SELECT message_id, target_endpoint_id, target_session_handle, reply_to, correlation_id, payload_json
         FROM messages WHERE comm_session_id = ? AND reply_to = ?`,
      ).get(comm.id, initial.messageId) as ReplyRow | undefined,
      (row) => Boolean(row),
    );
    expect(reply).toMatchObject({
      target_endpoint_id: startedA.endpointId,
      target_session_handle: routeA.serverHandle,
      reply_to: initial.messageId,
      correlation_id: "p1-codex-correlation",
    });
    expect(JSON.parse(reply!.payload_json)).toMatchObject({
      text: "P1_REPLY_FROM_CODEX_B",
      source: "codex",
    });
    await waitFor(
      () => b.client.getMessageStatus(reply!.message_id),
      (status) => status.status === "runtime_acked",
    );

    // B's codex session ran exactly one non-context turn for the inbound message.
    expect(b.driver.turns).toHaveLength(1);
    expect(b.driver.turns[0]?.prompt).toContain("[Aicoo untrusted external message]");
    // A received the reply as context only, so no automatic answer went back out.
    expect(a.driver.received).toHaveLength(1);
    expect(a.driver.received[0]?.shouldQuery).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const messageCount = server.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE comm_session_id = ?",
    ).get(comm.id) as { count: number };
    expect(Number(messageCount.count)).toBe(2);
  });
});

interface ReplyRow {
  message_id: string;
  target_endpoint_id: string;
  target_session_handle: string;
  reply_to: string;
  correlation_id: string;
  payload_json: string;
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
      runtime: "claude-code",
      heartbeatMs: 50,
      injectorMs: 20,
    }),
  };
}

function makeCodexBridge(baseUrl: string, token: string, reply: string) {
  const client = new HttpMessageTransport({ baseUrl, token, minReconnectMs: 10, maxReconnectMs: 50 });
  const spool = new BridgeSpool(":memory:");
  const driver = new FakeCodexDriver(reply);
  const adapter = new CodexAdapter({
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
      adapterVersion: CodexAdapter.adapterVersion,
      runtime: "codex",
      heartbeatMs: 50,
      injectorMs: 20,
    }),
  };
}
