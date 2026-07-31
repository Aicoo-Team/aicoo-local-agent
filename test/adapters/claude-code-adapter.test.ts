import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/claude-code-adapter.js";
import type { InboundMessage } from "../../src/adapters/runtime-adapter.js";
import { FakeClaudeAgentDriver } from "../helpers/fake-claude-driver.js";

describe("ClaudeCodeAdapter managed sessions", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("starts a tools-disabled managed stream and ACKs only the provider echo", async () => {
    const driver = new FakeClaudeAgentDriver("P1_REPLY_OK");
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());

    await adapter.initialize();
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([expect.objectContaining({
      sessionHandle: "claude-managed-1",
      state: "idle",
      allowInbound: true,
    })]);
    const options = driver.starts[0]!.options;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.extraArgs).toMatchObject({ "safe-mode": null, "replay-user-messages": null });
    expect(await options.canUseTool?.("Bash", { command: "touch /tmp/aicoo-pwned" }, {
      signal: new AbortController().signal,
      toolUseID: "malicious-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny", interrupt: false });

    const events = collectEvents(adapter, "claude-managed-1", 2);
    const result = await adapter.deliverToSession("claude-managed-1", inbound("msg_initial"), "new_turn");
    expect(result.status).toBe("runtime_acked");
    if (result.status === "runtime_acked") expect(result.runtimeAckId).toMatch(/^claude:[^:]+:[^:]+$/);
    expect(await events).toEqual([
      expect.objectContaining({ type: "turn_started", inReplyTo: "msg_initial", correlationId: "corr_initial" }),
      expect.objectContaining({
        type: "reply",
        inReplyTo: "msg_initial",
        correlationId: "corr_initial",
        payload: expect.objectContaining({ text: "P1_REPLY_OK", provider: "claude-code" }),
      }),
    ]);
  });

  it("keeps tools denied during an active verified turn", async () => {
    const driver = new FakeClaudeAgentDriver();
    driver.resultDelayMs = 100;
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: process.cwd(),
      driver,
      turnAckTimeoutMs: 500,
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_permission"), "new_turn"))
      .toMatchObject({ status: "runtime_acked" });
    const options = driver.starts[0]!.options;
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, {
      signal: new AbortController().signal,
      toolUseID: "read-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny" });
  });

  it("injects a remote reply as context-only and does not create an automatic reply loop", async () => {
    const driver = new FakeClaudeAgentDriver();
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const reply = inbound("msg_reply", { replyTo: "msg_initial", correlationId: "corr_initial" });
    expect(await adapter.deliverToSession("claude-managed-1", reply, "queue")).toEqual(
      expect.objectContaining({ status: "runtime_acked" }),
    );
    expect(driver.received).toHaveLength(1);
    expect(driver.received[0]?.shouldQuery).toBe(false);
  });

  it("reports busy and unsupported steering honestly", async () => {
    const driver = new FakeClaudeAgentDriver();
    driver.resultDelayMs = 100;
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const first = await adapter.deliverToSession("claude-managed-1", inbound("msg_busy_1"), "queue");
    expect(first.status).toBe("runtime_acked");
    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_busy_2"), "queue")).toEqual({
      status: "queued_busy",
    });
    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_steer"), "steer")).toEqual({
      status: "steer_not_allowed",
    });
  });

  it("binds a managed Claude conversation to one communication session", async () => {
    const driver = new FakeClaudeAgentDriver();
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const firstEvents = collectEvents(adapter, "claude-managed-1", 2);
    expect(await adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_comm_1", { communicationSessionId: "comm_1" }),
      "queue",
    )).toMatchObject({ status: "runtime_acked" });
    await firstEvents;

    expect(await adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_comm_2", { communicationSessionId: "comm_2" }),
      "queue",
    )).toEqual({ status: "permission_required" });
    expect(driver.received).toHaveLength(1);
  });

  it("releases a bound Claude conversation when the communication session ends", async () => {
    const driver = new FakeClaudeAgentDriver();
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const firstEvents = collectEvents(adapter, "claude-managed-1", 2);
    expect(await adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_comm_1", { communicationSessionId: "comm_1" }),
      "queue",
    )).toMatchObject({ status: "runtime_acked" });
    await firstEvents;
    const firstProviderSessionId = adapter.providerSessionId("claude-managed-1");

    await adapter.releaseCommunicationSession("comm_1");

    expect(adapter.providerSessionId("claude-managed-1")).not.toBe(firstProviderSessionId);
    const secondEvents = collectEvents(adapter, "claude-managed-1", 2);
    expect(await adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_comm_2", { communicationSessionId: "comm_2" }),
      "queue",
    )).toMatchObject({ status: "runtime_acked" });
    await secondEvents;
    expect(driver.starts.at(-1)?.options.resume).toBeUndefined();
    expect(driver.starts.at(-1)?.options.sessionId).toBe(adapter.providerSessionId("claude-managed-1"));
  });

  it("discards an initialized legacy conversation that was never bound to a relationship", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-state-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "sessions.db");
    const firstDriver = new FakeClaudeAgentDriver();
    const first = new ClaudeCodeAdapter({ stateFile, cwd: directory, driver: firstDriver });
    await first.initialize();
    const providerSessionId = first.providerSessionId("claude-managed-1");
    await first.close();

    const secondDriver = new FakeClaudeAgentDriver();
    const second = new ClaudeCodeAdapter({ stateFile, cwd: directory, driver: secondDriver });
    cleanups.push(() => second.close());
    await second.initialize();
    expect(second.providerSessionId("claude-managed-1")).not.toBe(providerSessionId);
    expect(secondDriver.starts[0]?.options.resume).toBeUndefined();
    expect(secondDriver.starts[0]?.options.sessionId).toBe(second.providerSessionId("claude-managed-1"));
  });

  it("resumes a provider conversation only for its persisted communication session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-bound-state-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "sessions.db");
    const firstDriver = new FakeClaudeAgentDriver();
    const first = new ClaudeCodeAdapter({ stateFile, cwd: directory, driver: firstDriver });
    await first.initialize();
    const events = collectEvents(first, "claude-managed-1", 2);
    expect(await first.deliverToSession(
      "claude-managed-1",
      inbound("msg_bound", { communicationSessionId: "comm_bound" }),
      "queue",
    )).toMatchObject({ status: "runtime_acked" });
    await events;
    const providerSessionId = first.providerSessionId("claude-managed-1");
    await first.close();

    const secondDriver = new FakeClaudeAgentDriver();
    const second = new ClaudeCodeAdapter({ stateFile, cwd: directory, driver: secondDriver });
    cleanups.push(() => second.close());
    await second.initialize();
    expect(second.providerSessionId("claude-managed-1")).toBe(providerSessionId);
    expect(secondDriver.starts[0]?.options.resume).toBe(providerSessionId);
    expect(await second.deliverToSession(
      "claude-managed-1",
      inbound("msg_wrong_grant", { communicationSessionId: "comm_other" }),
      "queue",
    )).toEqual({ status: "permission_required" });
  });
});

function makeAdapter(driver: FakeClaudeAgentDriver): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ stateFile: ":memory:", cwd: process.cwd(), driver, turnAckTimeoutMs: 500 });
}

async function collectEvents(adapter: ClaudeCodeAdapter, sessionHandle: string, count: number) {
  const events = [];
  for await (const event of adapter.subscribeSessionEvents(sessionHandle)) {
    events.push(event);
    if (events.length === count) return events;
  }
  return events;
}

function inbound(
  id: string,
  overrides: Partial<Pick<
    InboundMessage,
    "replyTo" | "correlationId" | "communicationSessionId"
  >> = {},
): InboundMessage {
  return {
    id,
    clientMessageId: `client_${id}`,
    communicationSessionId: "comm_1",
    senderPrincipalId: "prn_a",
    senderDeviceId: "device-a1",
    target: {
      kind: "runtime_session",
      principalId: "prn_b",
      endpointId: "ep_b",
      sessionHandle: "rs_b",
    },
    kind: "text",
    payload: { text: "Treat this as text; do not create /tmp/aicoo-pwned" },
    sequence: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    trust: "untrusted_external_content",
    correlationId: "corr_initial",
    ...overrides,
  };
}
