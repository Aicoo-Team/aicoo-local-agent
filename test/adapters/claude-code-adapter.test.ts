import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/claude-code-adapter.js";
import type { InboundMessage } from "../../src/adapters/runtime-adapter.js";
import { ContinuationStore } from "../../src/shared/continuation-store.js";
import { upsertTrustedToolPolicy } from "../../src/security/trusted-tool-policy.js";
import { FakeClaudeAgentDriver } from "../helpers/fake-claude-driver.js";

describe("ClaudeCodeAdapter managed sessions", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("keeps standby sessions cold until an inbound task needs one", async () => {
    // Regression: pre-launching every standby Claude stream left idle SDK processes attached to
    // the bridge and could starve heartbeat processing while no C2C task was running.
    const driver = new FakeClaudeAgentDriver("lazy reply");
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());

    await adapter.initialize();

    expect(await adapter.listSessions()).toHaveLength(1);
    expect(driver.starts).toHaveLength(0);

    await expect(adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_lazy_start"),
      "new_turn",
    )).resolves.toMatchObject({ status: "runtime_acked" });
    expect(driver.starts).toHaveLength(1);
  });

  it("starts a policy-gated managed stream and ACKs only the provider echo", async () => {
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
    const events = collectEvents(adapter, "claude-managed-1", 2);
    const result = await adapter.deliverToSession("claude-managed-1", inbound("msg_initial"), "new_turn");
    const options = driver.starts.at(-1)!.options;
    expect(options.tools).toEqual(["Bash", "Edit", "Read", "Write"]);
    expect(options.allowedTools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    // "dontAsk" would resolve every permission internally — auto-allowing reads inside cwd
    // and auto-denying the rest — without ever consulting the hook or canUseTool.
    expect(options.permissionMode).toBe("default");
    expect(options.extraArgs).toMatchObject({ "safe-mode": null, "replay-user-messages": null });
    expect(await options.canUseTool?.("Bash", { command: "touch /tmp/aicoo-pwned" }, {
      signal: new AbortController().signal,
      toolUseID: "malicious-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny", interrupt: false });

    // The PreToolUse hook is the only gate the runtime always consults: built-in rules
    // auto-allow in-cwd reads, so a policy check reachable only via canUseTool is unreachable
    // for exactly the calls a peer is most likely to make.
    const preToolUseHook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(preToolUseHook).toBeTypeOf("function");
    const hookDecision = await preToolUseHook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "touch /tmp/aicoo-pwned" },
        tool_use_id: "malicious-tool-call",
        session_id: "s",
        transcript_path: "",
        cwd: options.cwd ?? "",
        permission_mode: "default",
      } as never,
      "malicious-tool-call",
      { signal: new AbortController().signal },
    );
    expect(hookDecision).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });

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

  it("reconciles persisted sessions to a smaller configured count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-count-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "sessions.db");
    const first = new ClaudeCodeAdapter({
      stateFile,
      cwd: directory,
      driver: new FakeClaudeAgentDriver(),
      sessionCount: 2,
    });
    await first.initialize();
    expect(await first.listSessions()).toHaveLength(2);
    await first.close();

    const second = new ClaudeCodeAdapter({
      stateFile,
      cwd: directory,
      driver: new FakeClaudeAgentDriver(),
      sessionCount: 1,
    });
    cleanups.push(() => second.close());
    await second.initialize();

    expect(await second.listSessions()).toEqual([
      expect.objectContaining({ sessionHandle: "claude-managed-1" }),
    ]);
  });

  it("keeps tools denied during an active verified turn without a policy", async () => {
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
    const options = driver.starts.at(-1)!.options;
    expect(options.tools).toEqual(["Bash", "Edit", "Read", "Write"]);
    expect(options.allowedTools).toEqual([]);
    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, {
      signal: new AbortController().signal,
      toolUseID: "read-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny" });
  });

  it("allows Claude file tools only for the verified relationship and granted folder", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-tools-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const project = join(directory, "project");
    const otherProject = join(directory, "other-project");
    const policyFile = join(directory, "relationships.json");
    mkdirSync(project);
    mkdirSync(otherProject);
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read", "Write"],
        folders: [project],
      }, {
        principalId: "prn_other",
        deviceId: "device-other",
        tools: ["Read", "Write"],
        folders: [otherProject],
      }],
    }));
    writeFileSync(join(directory, "outside.txt"), "secret");

    const driver = new FakeClaudeAgentDriver();
    driver.resultDelayMs = 100;
    const asked: string[] = [];
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: directory,
      relationshipPolicyFile: policyFile,
      driver,
      turnAckTimeoutMs: 500,
      approvalGateway: {
        async requestToolApproval(input) {
          asked.push(input.toolName);
          const decision = input.toolName === "Read" ? "allow" : "deny";
          return { approvalId: `appr-${asked.length}`, status: decision, decision };
        },
        async getToolApproval() {
          return { status: "deny", decision: "deny" };
        },
      },
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_tools"), "new_turn"))
      .toMatchObject({ status: "runtime_acked" });
    const options = driver.starts.at(-1)!.options;
    expect(options.cwd).toBe(realpathSync.native(project));
    expect(options.additionalDirectories).toEqual([realpathSync.native(project)]);
    expect(options.additionalDirectories).not.toContain(realpathSync.native(otherProject));
    expect(options.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: expect.arrayContaining([join(realpathSync.native(project), ".env")]),
        denyWrite: expect.arrayContaining([join(realpathSync.native(project), "package.json")]),
      },
    });

    expect(await options.canUseTool?.("Read", { file_path: join(project, "README.md") }, {
      signal: new AbortController().signal,
      toolUseID: "read-tool-call",
      requestId: "permission-request",
    })).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: join(realpathSync.native(directory), "project", "README.md") },
    });
    // Do not ask the owner to approve a path or write level that this immutable session boundary
    // cannot honor. The request must be reissued with the wider boundary selected up front.
    expect(await options.canUseTool?.("Read", { file_path: join(directory, "outside.txt") }, {
      signal: new AbortController().signal,
      toolUseID: "outside-read",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny" });
    expect(await options.canUseTool?.("Edit", { file_path: join(project, "README.md") }, {
      signal: new AbortController().signal,
      toolUseID: "edit-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny" });
    expect(await options.canUseTool?.("Bash", { command: "cat README.md" }, {
      signal: new AbortController().signal,
      toolUseID: "bash-tool-call",
      requestId: "permission-request",
    })).toMatchObject({ behavior: "deny" });
    expect(asked).toEqual(["Read", "Edit"]);
  });

  it("creates a durable rebuild continuation for an out-of-boundary file request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-boundary-expansion-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const project = join(directory, "project");
    const outside = join(directory, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    const requestedFile = join(outside, "README.md");
    writeFileSync(requestedFile, "outside project");
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [project],
      }],
    }));
    const requests: Array<Record<string, unknown>> = [];
    const driver = new FakeClaudeAgentDriver();
    driver.resultDelayMs = 5_000;
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: project,
      relationshipPolicyFile: policyFile,
      driver,
      turnAckTimeoutMs: 500,
      approvalGateway: {
        async requestToolApproval(input) {
          requests.push(input as unknown as Record<string, unknown>);
          return {
            approvalId: "appr_expand",
            status: "allow",
            decision: "allow",
            activation: {
              grantId: "grant_expand",
              grantRevision: 2,
              canonicalFolder: realpathSync.native(outside),
              accessPreset: "read-project",
              expectedBoundaryManifestHash: "manifest_expand",
            },
          };
        },
        async getToolApproval() {
          return { status: "pending", decision: null };
        },
      },
    });
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    adapter.configureContinuationStore(store);
    cleanups.push(() => adapter.close());
    await adapter.initialize();
    await adapter.deliverToSession("claude-managed-1", inbound("msg_expand"), "new_turn");

    const decision = await driver.starts.at(-1)!.options.canUseTool?.(
      "Read",
      { file_path: requestedFile },
      { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
    );

    expect(decision).toMatchObject({ behavior: "deny" });
    expect(requests).toEqual([expect.objectContaining({
      communicationSessionId: "comm_1",
      sessionHandle: "claude-managed-1",
      messageId: "msg_expand",
      boundaryExpansion: expect.objectContaining({
        attemptId: "t1",
        canonicalResource: realpathSync.native(requestedFile),
        requestedAccessPreset: "read-project",
        requiresSessionRebuild: true,
      }),
    })]);
    expect(store.list()).toEqual([expect.objectContaining({
      state: "approved_pending_activation",
      messageId: "msg_expand",
      runtimeTurnId: expect.any(String),
      approvedCanonicalFolder: realpathSync.native(outside),
    })]);
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

  it("queries Claude for a reply turn only when the server marks expectsReply", async () => {
    const driver = new FakeClaudeAgentDriver();
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const reply = inbound("msg_turn_2", {
      replyTo: "msg_turn_1",
      collaborationId: "collab-1",
      collaborationTurn: collaborationTurn("turn-2", "turn-1", true),
    });
    await adapter.deliverToSession("claude-managed-1", reply, "queue");

    expect(driver.received[0]?.shouldQuery).toBe(true);
    expect(JSON.stringify(driver.received[0]?.message)).toContain("bounded agent collaboration turn");
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

  it("fails closed for ambiguous project tasks and launches the explicitly selected folder", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-project-selection-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = join(directory, "first-project");
    const second = join(directory, "second-project");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(config);
    const policyFile = join(config, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    }));
    const driver = new FakeClaudeAgentDriver("Selected project inspected.");
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: directory,
      relationshipPolicyFile: policyFile,
      driver,
      turnAckTimeoutMs: 500,
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_ambiguous", {
      kind: "task_invite",
    }), "queue")).toEqual({ status: "project_selection_required" });

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_selected", {
      kind: "task_invite",
      payload: {
        task: { text: "Inspect this project", projectAccessId: second },
      },
    }), "queue")).toMatchObject({ status: "runtime_acked" });
    const options = driver.starts.at(-1)!.options;
    expect(options.cwd).toBe(realpathSync.native(second));
    expect(options.additionalDirectories).toEqual([realpathSync.native(second)]);
  });

  it("rejects a project-scoped task before Claude starts when the peer has no project grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-no-project-access-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{ principalId: "prn_a", deviceId: "device-a1", tools: [], folders: [] }],
    }));
    const driver = new FakeClaudeAgentDriver("must not run");
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: directory,
      relationshipPolicyFile: policyFile,
      driver,
      turnAckTimeoutMs: 500,
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_no_access", {
      kind: "task_invite",
      payload: { task: "Summarize the project and explain its current state." },
    }), "queue")).toEqual({ status: "project_access_required" });
    expect(driver.starts).toHaveLength(0);
  });

  it("reuses one Claude boundary for the same objective-preflight project set", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-multi-project-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = join(directory, "first-project");
    const second = join(directory, "second-project");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(config);
    const policyFile = join(config, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    }));
    const driver = new FakeClaudeAgentDriver("Both projects inspected.");
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: directory,
      relationshipPolicyFile: policyFile,
      driver,
      turnAckTimeoutMs: 500,
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const multiProject = (id: string) => inbound(id, {
      kind: "task_invite",
      payload: {
        task: { text: "Compare first-project with second-project" },
      },
    });
    expect(await adapter.deliverToSession("claude-managed-1", multiProject("msg_multi_1"), "queue"))
      .toMatchObject({ status: "runtime_acked" });
    const startsAfterFirstTurn = driver.starts.length;
    expect(driver.starts.at(-1)!.options.additionalDirectories).toEqual(
      [realpathSync.native(first), realpathSync.native(second)].sort(),
    );

    expect(await adapter.deliverToSession("claude-managed-1", multiProject("msg_multi_2"), "queue"))
      .toMatchObject({ status: "runtime_acked" });
    expect(driver.starts).toHaveLength(startsAfterFirstTurn);
    expect(adapter.boundaryMetrics()).toMatchObject({
      eligibleTasks: 2,
      initialBoundaryBuilds: 1,
      postStartRebuildTasks: 0,
      totalPostStartRebuilds: 0,
    });

    expect(await adapter.deliverToSession("claude-managed-1", inbound("msg_multi_3", {
      kind: "task_invite",
      payload: {
        task: { text: "Inspect only the first", projectAccessId: first },
      },
    }), "queue")).toMatchObject({ status: "runtime_acked" });
    expect(adapter.boundaryMetrics()).toMatchObject({
      eligibleTasks: 3,
      initialBoundaryBuilds: 1,
      postStartRebuildTasks: 1,
      totalPostStartRebuilds: 1,
      failedBoundaryBuilds: 0,
    });
  });

  it("quiesces an old turn, rebuilds its approved boundary, and resumes on the original correlation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-continuation-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = join(directory, "first");
    const second = join(directory, "second");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(config);
    const policyFile = join(config, "relationships.json");
    const trustedToolPolicyFile = join(config, "trusted-tools.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    }));
    upsertTrustedToolPolicy({
      file: trustedToolPolicyFile,
      policyId: "grant_2",
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      requesterPrincipalId: "prn_a",
      requesterDeviceId: "device-a1",
      folder: second,
      accessPreset: "read-project",
      scope: "bridge_run",
      bridgeInstanceId: "bridge_1",
      createdFrom: "approval_prompt",
      createdBy: "prn_b",
      serverRevision: 2,
    });
    const driver = new FakeClaudeAgentDriver("resumed answer");
    driver.resultDelayMs = 50;
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: directory,
      relationshipPolicyFile: policyFile,
      trustedToolPolicyFile,
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device_b",
      bridgeInstanceId: "bridge_1",
      driver,
      turnAckTimeoutMs: 500,
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();
    const original = inbound("msg_continuation", {
      kind: "task_invite",
      correlationId: "corr_continuation",
      payload: { task: { text: "Compare first and second", projectAccessId: first } },
    });
    const events = collectEvents(adapter, "claude-managed-1", 3);
    expect(await adapter.deliverToSession("claude-managed-1", original, "queue"))
      .toMatchObject({ status: "runtime_acked" });
    const checkpoint = {
      continuationId: "cont_1",
      idempotencyKey: "comm_1:msg_continuation:tool_1",
      correlationId: "corr_continuation",
      communicationSessionId: "comm_1",
      messageId: original.id,
      sessionHandle: "claude-managed-1",
      runtimeTurnId: "tool_1",
      originalMessage: original,
      requestedCapability: {
        toolName: "Read",
        canonicalResource: join(second, "README.md"),
        summary: "Read second README",
      },
      state: "rebuilding_session" as const,
      grantId: "grant_2",
      grantRevision: 2,
      approvedCanonicalFolder: realpathSync.native(second),
      approvedAccessPreset: "read-project" as const,
      expectedBoundaryManifestHash: "set by server",
    };

    await adapter.quiesceContinuation(checkpoint);
    const attestation = await adapter.rebuildContinuation(checkpoint);
    expect(attestation.boundaryManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(driver.starts.at(-1)?.options.additionalDirectories).toEqual(
      [realpathSync.native(first), realpathSync.native(second)].sort(),
    );
    await expect(adapter.resumeContinuation(checkpoint)).resolves.toMatchObject({ status: "runtime_acked" });

    const delivered = await events;
    expect(delivered.filter((event) => event.type === "reply")).toEqual([
      expect.objectContaining({
        inReplyTo: original.id,
        correlationId: "corr_continuation",
        payload: expect.objectContaining({ text: "resumed answer" }),
      }),
    ]);
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

  it("invalidates a Claude conversation only for the exact relationship device", async () => {
    const driver = new FakeClaudeAgentDriver();
    const adapter = makeAdapter(driver);
    cleanups.push(() => adapter.close());
    await adapter.initialize();

    const events = collectEvents(adapter, "claude-managed-1", 2);
    await adapter.deliverToSession("claude-managed-1", inbound("msg_policy"), "queue");
    await events;
    const providerSessionId = adapter.providerSessionId("claude-managed-1");

    await adapter.invalidateRelationshipSessions("prn_other", "device-a1");
    expect(adapter.providerSessionId("claude-managed-1")).toBe(providerSessionId);

    await adapter.invalidateRelationshipSessions("prn_a", "device-a1");
    expect(adapter.providerSessionId("claude-managed-1")).not.toBe(providerSessionId);
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
    const legacyDb = new DatabaseSync(stateFile);
    legacyDb.prepare(
      "UPDATE managed_sessions SET initialized = 1, bound_comm_session_id = NULL WHERE local_handle = ?",
    ).run("claude-managed-1");
    legacyDb.close();

    const secondDriver = new FakeClaudeAgentDriver();
    const second = new ClaudeCodeAdapter({ stateFile, cwd: directory, driver: secondDriver });
    cleanups.push(() => second.close());
    await second.initialize();
    expect(second.providerSessionId("claude-managed-1")).not.toBe(providerSessionId);
    expect(secondDriver.starts).toHaveLength(0);
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
    expect(secondDriver.starts).toHaveLength(0);
    expect(await second.deliverToSession(
      "claude-managed-1",
      inbound("msg_wrong_grant", { communicationSessionId: "comm_other" }),
      "queue",
    )).toEqual({ status: "permission_required" });
    const resumedEvents = collectEvents(second, "claude-managed-1", 2);
    expect(await second.deliverToSession(
      "claude-managed-1",
      inbound("msg_resume", { communicationSessionId: "comm_bound" }),
      "queue",
    )).toMatchObject({ status: "runtime_acked" });
    await resumedEvents;
    expect(secondDriver.starts[0]?.options.resume).toBe(providerSessionId);
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
    "replyTo" | "correlationId" | "communicationSessionId" | "collaborationId" | "collaborationTurn"
    | "payload" | "kind"
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

function collaborationTurn(turnId: string, parentTurnId: string, expectsReply: boolean) {
  return {
    turnId,
    clientTurnId: `client-${turnId}`,
    parentTurnId,
    sequence: 2,
    type: "question" as const,
    expectsReply,
    outcome: "respond" as const,
  };
}

describe("CodeAdapter just-in-time tool approval", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function permissionContext() {
    return { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" };
  }

  /** Records what the owner would have been shown, and answers with `decision`. */
  function gateway(decision: "allow" | "deny") {
    const asked: Array<{ toolName: string; toolInputSummary: string; communicationSessionId: string }> = [];
    return {
      asked,
      async requestToolApproval(input: {
        toolName: string;
        toolInputSummary: string;
        communicationSessionId: string;
      }) {
        asked.push(input);
        return { approvalId: `appr_${asked.length}`, status: decision, decision };
      },
      async getToolApproval() {
        return { status: decision, decision } as { status: string; decision: "allow" | "deny" | null };
      },
    };
  }

  /** A relationship with no tools: policy denies everything, so every call reaches the gateway. */
  function chatOnlyPolicyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-appr-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{ principalId: "prn_a", deviceId: "device-a1", tools: [], folders: [] }],
    }));
    return policyFile;
  }

  /** The state a brand-new user is in: nobody has written a policy file yet. */
  function missingPolicyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-nopolicy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "relationships.json");
  }

  function readPolicyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-read-policy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [process.cwd()],
      }],
    }));
    return policyFile;
  }

  function editPolicyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-edit-policy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read", "Write", "Edit"],
        folders: [process.cwd()],
      }],
    }));
    return policyFile;
  }

  function mcpOnlyPolicyFile(bearerTokenEnvVar: string): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-mcp-policy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: [],
        folders: [],
        mcpServers: [{
          name: "docs",
          url: "https://mcp.example.com/v1",
          enabledTools: ["read"],
          bearerTokenEnvVar,
          startupTimeoutSec: 10,
          toolTimeoutSec: 60,
        }],
      }],
    }));
    return policyFile;
  }

  function folderBoundaryPolicyFile(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-folder-boundary-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: [],
        folders: [process.cwd()],
      }],
    }));
    return policyFile;
  }

  async function startedAdapter(
    approvalGateway?: ReturnType<typeof gateway>,
    policyFile?: string,
    collaborationId?: string,
    capabilitySurface: "restricted" | "full-agent" = "restricted",
  ) {
    const driver = new FakeClaudeAgentDriver();
    // canUseTool fires mid-turn; hold the turn open so the active message (and its
    // communicationSessionId) is still there, as it is in a real session.
    driver.resultDelayMs = 5_000;
    const adapter = new ClaudeCodeAdapter({
      stateFile: ":memory:",
      cwd: process.cwd(),
      relationshipPolicyFile: policyFile ?? chatOnlyPolicyFile(),
      driver,
      turnAckTimeoutMs: 500,
      capabilitySurface,
      ...(approvalGateway ? { approvalGateway } : {}),
    });
    cleanups.push(() => adapter.close());
    await adapter.initialize();
    await adapter.deliverToSession(
      "claude-managed-1",
      inbound("msg_appr", { ...(collaborationId ? { collaborationId } : {}) }),
      "new_turn",
    );
    return driver.starts.at(-1)!.options;
  }

  it("still denies outright when no approval gateway is wired", async () => {
    // Regression guard: the ask-the-owner path must be additive, never a new way to say yes.
    const options = await startedAdapter();
    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext()))
      .toMatchObject({ behavior: "deny" });
  });

  it("asks the owner when policy does not cover the call, and allows on approval", async () => {
    const g = gateway("allow");
    const options = await startedAdapter(g, folderBoundaryPolicyFile());

    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext()))
      .toMatchObject({ behavior: "allow" });
    // The owner sees one line, so it has to name the file — "Read" alone is not decidable.
    expect(g.asked).toHaveLength(1);
    expect(g.asked[0]!.toolInputSummary).toBe("Read README.md");
    expect(g.asked[0]!.communicationSessionId).toBe("comm_1");
  });

  it("denies when the owner declines", async () => {
    const g = gateway("deny");
    const options = await startedAdapter(g, folderBoundaryPolicyFile());
    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext()))
      .toMatchObject({ behavior: "deny", interrupt: false });
    // Must be a deny the owner chose, not the old deny-before-asking path.
    expect(g.asked).toHaveLength(1);
  });

  it("does not widen Allow once into a local turn-wide permission", async () => {
    const g = gateway("allow");
    const options = await startedAdapter(g, folderBoundaryPolicyFile());

    await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext());
    await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext());
    expect(g.asked).toHaveLength(2);

    // Pulse decides whether either request can auto-resolve from a collaboration-scoped
    // allowance. The bridge must not silently broaden a one-time decision by itself.
    await options.canUseTool?.("Read", { file_path: "package.json" }, permissionContext());
    expect(g.asked).toHaveLength(3);
  });

  it("routes relationship-covered tools through the hosted precedent decision", async () => {
    const g = gateway("allow");
    const options = await startedAdapter(g, readPolicyFile(), "collab-1");

    expect(await options.canUseTool?.("Read", { file_path: "README.md" }, permissionContext()))
      .toMatchObject({ behavior: "allow" });
    expect(g.asked).toHaveLength(1);
  });

  it("maps a safe Git command to a dedicated approval and keeps raw shell blocked", async () => {
    const g = gateway("allow");
    const options = await startedAdapter(g, readPolicyFile(), "collab-1");

    const allowed = await options.canUseTool?.("Bash", { command: "git status --short" }, permissionContext());
    expect(allowed).toMatchObject({
      behavior: "allow",
      updatedInput: { command: expect.stringContaining("core.hooksPath=/dev/null") },
    });
    expect(g.asked).toEqual([
      expect.objectContaining({ toolName: "GitStatus", toolInputSummary: expect.stringContaining("GitStatus") }),
    ]);

    expect(await options.canUseTool?.("Bash", { command: "git reset --hard" }, permissionContext()))
      .toMatchObject({ behavior: "deny", interrupt: false });
    expect(g.asked).toHaveLength(1);
  });

  it("exposes the full tool surface only in full-agent mode and governs raw shell", async () => {
    const g = gateway("allow");
    const options = await startedAdapter(g, editPolicyFile(), "collab-full", "full-agent");

    // Full-agent must not cap the provider's capability surface before PreToolUse can
    // turn an attempted call into an owner-resolvable permission decision.
    expect(options.tools).toBeUndefined();
    expect(options.disallowedTools).toEqual([]);
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.skills).toBe("all");
    expect(options.extraArgs).not.toHaveProperty("safe-mode");
    expect(options.extraArgs).toMatchObject({ "replay-user-messages": null });
    expect(options.mcpServers).toHaveProperty("aicoo_capabilities");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.managedSettings).toMatchObject({
      disableSkillShellExecution: true,
      allowManagedHooksOnly: true,
      allowManagedPermissionRulesOnly: true,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [], allowManagedDomainsOnly: true },
        filesystem: {
          allowRead: [realpathSync.native(process.cwd())],
          allowManagedReadPathsOnly: true,
        },
      },
    });
    expect(options.systemPrompt).toContain("Requestable capability catalogue:");
    expect(options.systemPrompt).toContain("network.search (WebSearch)");
    expect(options.systemPrompt).toContain("request_capability");

    expect(await options.canUseTool?.("Bash", {
      command: "npm test",
      timeout: 900_000,
      dangerouslyDisableSandbox: true,
    }, permissionContext())).toMatchObject({
      behavior: "allow",
      updatedInput: {
        command: "npm test",
        timeout: 120_000,
        dangerouslyDisableSandbox: false,
      },
    });
    expect(g.asked).toEqual([
      expect.objectContaining({ toolName: "Bash", toolInputSummary: "Bash npm test" }),
    ]);

    expect(await options.canUseTool?.(
      "mcp__aicoo_capabilities__request_capability",
      { capability: "mcp.lark.search_messages", reason: "Find the requested message" },
      permissionContext(),
    )).toMatchObject({ behavior: "allow" });
    expect(g.asked.at(-1)).toMatchObject({
      toolName: "mcp__aicoo_capabilities__request_capability",
      toolInputSummary: expect.stringContaining("mcp.lark.search_messages"),
    });

    // A provider-added tool must reach the same approval loop instead of becoming a capability
    // refusal merely because this adapter version predates the tool. The edit boundary and
    // kernel sandbox remain authoritative even after the owner allows the attempt.
    expect(await options.canUseTool?.(
      "FutureDangerousTool",
      { target: "owner-account" },
      permissionContext(),
    )).toMatchObject({ behavior: "allow" });
    expect(g.asked.at(-1)).toMatchObject({
      toolName: "FutureDangerousTool",
      toolInputSummary: expect.stringContaining("owner-account"),
    });
    expect(g.asked).toHaveLength(3);

    const preToolUseHook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(await preToolUseHook?.({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test", dangerouslyDisableSandbox: true },
      tool_use_id: "full-bash-hook",
      session_id: "s",
      transcript_path: "",
      cwd: options.cwd ?? "",
      permission_mode: "default",
    } as never, "full-bash-hook", { signal: new AbortController().signal })).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { dangerouslyDisableSandbox: false, timeout: 120_000 },
      },
    });

    const postToolUseHook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    expect(await postToolUseHook?.({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { output: "leaked ghp_abcdefghijklmnopqrstuvwxyz123456" },
      tool_use_id: "full-bash-hook",
      session_id: "s",
      transcript_path: "",
      cwd: options.cwd ?? "",
      permission_mode: "default",
    } as never, "full-bash-hook", { signal: new AbortController().signal })).toMatchObject({
      hookSpecificOutput: {
        updatedToolOutput: { output: "leaked [REDACTED]" },
      },
    });
  });

  it("projects only exact MCP grants into an MCP-only full-agent session", async () => {
    const tokenVariable = "AICOO_TEST_CLAUDE_MCP_TOKEN";
    process.env[tokenVariable] = "test-token";
    cleanups.push(() => { delete process.env[tokenVariable]; });
    const g = gateway("allow");
    const options = await startedAdapter(g, mcpOnlyPolicyFile(tokenVariable), "collab-mcp", "full-agent");

    expect(options.mcpServers).toEqual({
      aicoo_capabilities: expect.anything(),
      docs: {
        type: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer test-token" },
        tools: [{
          name: "read",
          permission_policy: "always_ask",
          org_max_permission: "ask",
        }],
        timeout: 60_000,
        alwaysLoad: true,
      },
    });
    expect(options.systemPrompt).toContain("mcp.docs.read");
    expect(options.systemPrompt).not.toContain("mcp.docs.search");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.additionalDirectories).toBeUndefined();

    expect(await options.canUseTool?.(
      "mcp__docs__read",
      { query: "release notes" },
      permissionContext(),
    )).toMatchObject({ behavior: "allow" });
    expect(await options.canUseTool?.(
      "mcp__docs__write",
      { content: "not granted" },
      permissionContext(),
    )).toMatchObject({ behavior: "deny" });
    expect(g.asked).toEqual([
      expect.objectContaining({ toolName: "mcp__docs__read" }),
    ]);
  });

  it("does not offer approval when no active boundary can honor the path", async () => {
    // Regression: an owner approval cannot widen an already-running kernel sandbox. Prompting
    // here would record an allow that the runtime must still refuse.
    const g = gateway("allow");
    const options = await startedAdapter(g, missingPolicyFile());

    expect(await options.canUseTool?.("Read", { file_path: "/srv/a.ts" }, permissionContext()))
      .toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("outside the active session boundary"),
      });
    expect(g.asked).toHaveLength(0);
  });

  it("does not treat a policy update as an in-place kernel boundary widening", async () => {
    // Regression: the relationship file can change while Claude is running, but its kernel
    // additionalDirectories cannot. Approval must not claim that the old session can use it.
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-fixed-boundary-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const first = join(directory, "first");
    const second = join(directory, "second");
    mkdirSync(first);
    mkdirSync(second);
    const policyFile = join(directory, "relationships.json");
    const relationship = (folders: string[]) => ({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: [],
        folders,
      }],
    });
    writeFileSync(policyFile, JSON.stringify(relationship([first])));
    const g = gateway("allow");
    const options = await startedAdapter(g, policyFile);

    writeFileSync(policyFile, JSON.stringify(relationship([first, second])));
    expect(await options.canUseTool?.("Read", { file_path: join(second, "README.md") }, permissionContext()))
      .toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("outside the active session boundary"),
      });
    expect(g.asked).toHaveLength(0);
  });

  it("denies without asking when the policy file is present but corrupt", async () => {
    // A broken policy is not an absent one: we cannot tell what the owner authorized, so the
    // fail-closed path must win and the owner must not be prompted to rubber-stamp it.
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-badpolicy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, "{ not json");

    const g = gateway("allow");
    const options = await startedAdapter(g, policyFile);

    expect(await options.canUseTool?.("Read", { file_path: "/srv/a.ts" }, permissionContext()))
      .toMatchObject({ behavior: "deny" });
    expect(g.asked).toHaveLength(0);
  });
});
