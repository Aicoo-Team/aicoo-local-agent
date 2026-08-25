import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/codex/codex-adapter.js";
import type {
  CodexDriver,
  CodexThreadEvent,
  CodexTurn,
  CodexTurnStartInput,
} from "../../src/adapters/codex/driver.js";
import { AsyncMessageQueue } from "../../src/adapters/claude-code/message-queue.js";
import { FakeRuntimeAdapter } from "../../src/adapters/fake/fake-adapter.js";
import { RuntimeBridge } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { upsertRelationshipPreset } from "../../src/security/relationship-policy.js";
import { createBoundaryManifest } from "../../src/shared/boundary-manifest.js";
import { ContinuationStore } from "../../src/shared/continuation-store.js";
import type { RuntimeEvent } from "../../src/shared/contracts.js";
import { HttpMessageTransport } from "../../src/shared/http-client.js";
import type { ToolApprovalRequest } from "../../src/shared/aicoo-transport.js";
import type { ToolApprovalGateway } from "../../src/shared/tool-approval.js";
import { startTestServer, TOKENS, waitFor } from "../helpers/harness.js";

describe("two-bridge boundary rebuild E2E", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
  });

  it("continues the original task after an out-of-boundary approval activates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-boundary-e2e-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const project = join(directory, "project");
    const outside = join(directory, "outside");
    const config = join(directory, "config");
    mkdirSync(project);
    mkdirSync(outside);
    mkdirSync(config);
    const requestedFile = join(outside, "result.ts");
    const relationshipPolicyFile = join(config, "relationships.json");
    const trustedToolPolicyFile = join(config, "trusted-tools.json");
    upsertRelationshipPreset({
      file: relationshipPolicyFile,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: project,
    });

    const server = await startTestServer({ pingMs: 50 });
    cleanup.push(server.close);
    const aClient = new HttpMessageTransport({
      baseUrl: server.baseUrl,
      token: TOKENS.a,
      minReconnectMs: 10,
      maxReconnectMs: 50,
    });
    const bClient = new HttpMessageTransport({
      baseUrl: server.baseUrl,
      token: TOKENS.b,
      minReconnectMs: 10,
      maxReconnectMs: 50,
    });
    // The reference control plane has no hosted trusted-policy endpoint. The event below is the
    // authoritative server delivery; only its HTTP acknowledgement is stubbed in this E2E.
    bClient.acknowledgeTrustedToolPolicy = async () => undefined;
    const approval = new HeldBoundaryApproval();
    const driver = new BoundaryRequestCodexDriver(requestedFile, "BOUNDARY_REBUILD_COMPLETE");
    const aSpool = new BridgeSpool(":memory:");
    const bSpool = new BridgeSpool(":memory:");
    const bridgeInstanceId = "bridge-boundary-e2e";
    const aAdapter = new FakeRuntimeAdapter();
    const bAdapter = new CodexAdapter({
      stateFile: ":memory:",
      cwd: project,
      relationshipPolicyFile,
      trustedToolPolicyFile,
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device-b1",
      bridgeInstanceId,
      approvalGateway: approval,
      driver,
      turnAckTimeoutMs: 500,
    });
    const aBridge = new RuntimeBridge({
      transport: aClient,
      spool: aSpool,
      adapter: aAdapter,
      heartbeatMs: 50,
      injectorMs: 20,
    });
    const bBridge = new RuntimeBridge({
      transport: bClient,
      spool: bSpool,
      adapter: bAdapter,
      adapterVersion: CodexAdapter.adapterVersion,
      runtime: "codex",
      relationshipPolicyFile,
      trustedToolPolicyFile,
      ownerPrincipalId: "prn_b",
      ownerDeviceId: "device-b1",
      bridgeInstanceId,
      heartbeatMs: 50,
      injectorMs: 20,
    });
    cleanup.push(
      () => aSpool.close(),
      () => bSpool.close(),
      () => aBridge.stop(),
      () => bBridge.stop(),
    );

    const startedA = await aBridge.start();
    const startedB = await bBridge.start();
    const routeA = startedA.sessions[0]!;
    const routeB = startedB.sessions[0]!;
    await bClient.setDefaultRoute(startedB.endpointId, routeB.serverHandle);
    const comm = await aClient.requestCommunicationSession({
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: startedA.endpointId,
      replySessionHandle: routeA.serverHandle,
    });
    await bClient.acceptCommunicationSession(comm.id);

    const initial = await aClient.sendMessage({
      communicationSessionId: comm.id,
      clientMessageId: "boundary-e2e-task",
      kind: "task_invite",
      payload: {
        task: {
          text: `Update ${requestedFile} and report completion`,
          projectAccessId: realpathSync.native(project),
        },
      },
      correlationId: "boundary-e2e-correlation",
    });
    const approvalRequest = await approval.waitForRequest();
    const canonicalRequestedFile = join(realpathSync.native(outside), "result.ts");
    expect(approvalRequest.boundaryExpansion).toMatchObject({
      canonicalResource: canonicalRequestedFile,
      requestedAccessPreset: "edit-project",
      requiresSessionRebuild: true,
    });

    const grantId = "grant-boundary-e2e";
    const grantRevision = 3;
    const canonicalProject = realpathSync.native(project);
    const canonicalOutside = realpathSync.native(outside);
    const { hash: expectedBoundaryManifestHash } = createBoundaryManifest({
      runtime: "codex",
      adapterVersion: CodexAdapter.adapterVersion,
      bridgeInstanceId,
      requesterPrincipalId: "prn_a",
      requesterDeviceId: "device-a1",
      grantId,
      grantRevision,
      preset: "edit-project",
      folders: [canonicalProject, canonicalOutside],
      writableFolders: [canonicalProject, canonicalOutside],
    });
    // Exercise the harder ordering: the policy event lands before the waiting adapter records
    // the human decision. Periodic durable recovery must still notice it afterward.
    await handleBridgeEvent(bBridge, {
      cursor: "trusted-boundary-e2e",
      type: "trusted_tool_policy.upserted",
      endpointId: startedB.endpointId,
      createdAt: new Date().toISOString(),
      data: {
        policyId: grantId,
        ownerPrincipalId: "prn_b",
        ownerDeviceId: "device-b1",
        requesterPrincipalId: "prn_a",
        requesterDeviceId: "device-a1",
        canonicalFolder: canonicalOutside,
        accessPreset: "edit-project",
        scope: "bridge_run",
        bridgeInstanceId,
        revision: grantRevision,
        createdFrom: "approval_prompt",
        createdBy: "prn_b",
        createdAt: new Date().toISOString(),
      },
    });
    approval.allow({
      grantId,
      grantRevision,
      canonicalFolder: canonicalOutside,
      accessPreset: "edit-project",
      expectedBoundaryManifestHash,
    });

    const reply = await waitFor(
      () => server.db.prepare(
        `SELECT message_id, reply_to, correlation_id, payload_json
         FROM messages WHERE comm_session_id = ? AND reply_to = ?`,
      ).get(comm.id, initial.messageId) as ReplyRow | undefined,
      (row) => Boolean(row),
      5_000,
    );
    expect(reply).toMatchObject({
      reply_to: initial.messageId,
      correlation_id: "boundary-e2e-correlation",
    });
    expect(JSON.parse(reply!.payload_json)).toMatchObject({
      text: "BOUNDARY_REBUILD_COMPLETE",
      source: "codex",
    });
    await waitFor(
      () => bClient.getMessageStatus(reply!.message_id),
      (status) => status.status === "runtime_acked",
    );

    expect(driver.turns).toHaveLength(2);
    expect(driver.turns[1]?.prompt).toContain('"boundaryRebuild":true');
    const profile = readFileSync(join(driver.turns[1]!.permissionProfile!.codexHome, "config.toml"), "utf8");
    expect(profile).toContain(JSON.stringify(canonicalProject));
    expect(profile).toContain(JSON.stringify(canonicalOutside));
    expect(new ContinuationStore(bSpool.db).list()).toEqual([
      expect.objectContaining({
        messageId: initial.messageId,
        correlationId: "boundary-e2e-correlation",
        state: "completed",
        grantId,
        boundaryManifestHash: expectedBoundaryManifestHash,
      }),
    ]);
  });
});

interface ReplyRow {
  message_id: string;
  reply_to: string;
  correlation_id: string;
  payload_json: string;
}

class HeldBoundaryApproval implements ToolApprovalGateway {
  #request?: ToolApprovalRequest;
  #notifyRequest?: () => void;
  #resolve?: (activation: Parameters<HeldBoundaryApproval["allow"]>[0]) => void;
  readonly #decision = new Promise<Parameters<HeldBoundaryApproval["allow"]>[0]>((resolve) => {
    this.#resolve = resolve;
  });

  async requestToolApproval(input: ToolApprovalRequest) {
    this.#request = input;
    this.#notifyRequest?.();
    const activation = await this.#decision;
    return { approvalId: "approval-boundary-e2e", status: "allow", decision: "allow" as const, activation };
  }

  async getToolApproval() {
    return { status: "pending", decision: null };
  }

  async waitForRequest(): Promise<ToolApprovalRequest> {
    if (!this.#request) await new Promise<void>((resolve) => { this.#notifyRequest = resolve; });
    return this.#request!;
  }

  allow(activation: {
    grantId: string;
    grantRevision: number;
    canonicalFolder: string;
    accessPreset: "read-project" | "edit-project";
    expectedBoundaryManifestHash: string;
  }): void {
    this.#resolve?.(activation);
  }
}

class BoundaryRequestCodexDriver implements CodexDriver {
  readonly turns: CodexTurnStartInput[] = [];

  constructor(
    private readonly requestedFile: string,
    private readonly finalAnswer: string,
  ) {}

  startTurn(input: CodexTurnStartInput): CodexTurn {
    this.turns.push(input);
    return new BoundaryRequestCodexTurn(
      input,
      this.turns.length === 1 ? this.requestedFile : undefined,
      this.finalAnswer,
    );
  }
}

class BoundaryRequestCodexTurn implements CodexTurn {
  readonly #events = new AsyncMessageQueue<CodexThreadEvent>();
  #closed = false;
  #releaseClose?: () => void;
  readonly #closedPromise = new Promise<void>((resolve) => { this.#releaseClose = resolve; });

  constructor(
    private readonly input: CodexTurnStartInput,
    private readonly requestedFile: string | undefined,
    private readonly finalAnswer: string,
  ) {
    void this.run();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseClose?.();
    this.#events.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexThreadEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  private async run(): Promise<void> {
    try {
      await this.push({ type: "thread.started", thread_id: `boundary-thread-${this.requestedFile ? "old" : "new"}` });
      await this.push({ type: "turn.started" });
      if (this.requestedFile) {
        await this.input.onApproval?.({
          kind: "fileChange",
          summary: `Modify: ${this.requestedFile}`,
          paths: [this.requestedFile],
        });
        await this.#closedPromise;
        return;
      }
      await this.push({
        type: "item.completed",
        item: { id: "answer", type: "agent_message", text: this.finalAnswer },
      });
      await this.push({ type: "turn.completed" });
    } finally {
      this.#events.close();
    }
  }

  private async push(event: CodexThreadEvent): Promise<void> {
    if (!this.#closed) await this.#events.push(event);
  }
}

async function handleBridgeEvent(bridge: RuntimeBridge, event: RuntimeEvent): Promise<void> {
  await (bridge as unknown as { handleEvent(value: RuntimeEvent): Promise<void> }).handleEvent(event);
}
