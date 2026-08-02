import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/claude-code-adapter.js";
import { CodexAdapter } from "../../src/adapters/codex/codex-adapter.js";
import { requestRuntimeDelegation, RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import { FakeClaudeAgentDriver } from "../helpers/fake-claude-driver.js";
import { FakeCodexDriver } from "../helpers/fake-codex-driver.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("local-to-local delegation E2E", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("parks before approval, dispatches after Collaborate approval, and returns the peer runtime answer", async () => {
    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const a = makeClaudeBridge(server.baseUrl, TOKENS.a, "A must treat replies as context only");
    const b = makeCodexBridge(server.baseUrl, TOKENS.b, "B is working on the Aicoo local-to-local demo.");
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

    const requested = await requestRuntimeDelegation({
      transport: a.client,
      spool: a.spool,
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      task: "What are you working on?",
      sessionHandle: routeA.serverHandle,
      clientMessageId: "demo-local-to-local",
      correlationId: "demo-correlation",
      timeoutMs: 60_000,
    });
    expect(requested.status).toBe("grant_requested");
    expect(a.spool.listPendingDelegations(requested.communicationSession.id)).toHaveLength(1);

    await b.client.acceptCommunicationSession(requested.communicationSession.id);

    const task = await waitFor(
      () => server.db.prepare(
        `SELECT message_id, kind, target_endpoint_id, target_session_handle, correlation_id, payload_json
         FROM messages WHERE client_message_id = ?`,
      ).get("demo-local-to-local") as TaskRow | undefined,
      (row) => Boolean(row),
    );
    expect(task).toMatchObject({
      kind: "task_invite",
      target_endpoint_id: startedB.endpointId,
      target_session_handle: routeB.serverHandle,
      correlation_id: "demo-correlation",
    });
    expect(JSON.parse(task!.payload_json)).toMatchObject({
      task: "What are you working on?",
      delegation: {
        clientMessageId: "demo-local-to-local",
        correlationId: "demo-correlation",
        untrustedExternalContent: true,
      },
    });

    await waitFor(
      () => a.client.getMessageStatus(task!.message_id),
      (status) => status.status === "runtime_acked",
    );
    const reply = await waitFor(
      () => server.db.prepare(
        `SELECT message_id, target_endpoint_id, target_session_handle, reply_to, correlation_id, payload_json
         FROM messages WHERE reply_to = ?`,
      ).get(task!.message_id) as ReplyRow | undefined,
      (row) => Boolean(row),
    );

    expect(JSON.parse(reply!.payload_json)).toMatchObject({
      text: "B is working on the Aicoo local-to-local demo.",
      source: "codex",
    });
    expect(reply).toMatchObject({
      target_endpoint_id: startedA.endpointId,
      target_session_handle: routeA.serverHandle,
      reply_to: task!.message_id,
      correlation_id: "demo-correlation",
    });

    await waitFor(
      () => b.client.getMessageStatus(reply!.message_id),
      (status) => status.status === "runtime_acked",
    );
    expect(b.driver.turns).toHaveLength(1);
    expect(b.driver.turns[0]?.prompt).toContain("[Aicoo untrusted external message]");
    expect(a.driver.received).toHaveLength(1);
    expect(a.driver.received[0]?.shouldQuery).toBe(false);
    expect(a.spool.listPendingDelegations(requested.communicationSession.id)).toEqual([]);
  });
});

interface TaskRow {
  message_id: string;
  kind: string;
  target_endpoint_id: string;
  target_session_handle: string;
  correlation_id: string;
  payload_json: string;
}

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
