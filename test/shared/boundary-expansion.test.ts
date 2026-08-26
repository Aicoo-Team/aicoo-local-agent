import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BoundaryExpansionCoordinator } from "../../src/shared/boundary-expansion.js";
import { requestBoundaryExpansionForTool } from "../../src/shared/boundary-expansion-request.js";
import { ContinuationStore } from "../../src/shared/continuation-store.js";

const base = {
  idempotencyKey: "comm_1:msg_1:tool_1",
  correlationId: "corr_1",
  communicationSessionId: "comm_1",
  messageId: "msg_1",
  sessionHandle: "claude-managed-1",
  runtimeTurnId: "turn_1",
  originalMessage: { kind: "task_invite", payload: { task: { text: "Inspect B" } } },
  requestedCapability: {
    toolName: "Read",
    canonicalResource: "/srv/project-b/README.md",
    summary: "Read Project B README",
  },
  attemptId: "tool_1",
  requestedAccessPreset: "read-project" as const,
  currentBoundaryManifestHash: "manifest_6",
  approval: {
    communicationSessionId: "comm_1",
    sessionHandle: "claude-managed-1",
    messageId: "msg_1",
    toolName: "Read",
    toolInputSummary: "Read Project B README",
  },
};

describe("boundary expansion coordinator", () => {
  it("persists an exact activatable approval before rebuild begins", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    let request: unknown;
    const coordinator = new BoundaryExpansionCoordinator(store, {
      async requestToolApproval(input) {
        request = input;
        return {
          approvalId: "appr_7",
          status: "allow",
          decision: "allow",
          activation: {
            grantId: "grant_7",
            grantRevision: 7,
            canonicalFolder: "/srv/project-b",
            accessPreset: "read-project",
            expectedBoundaryManifestHash: "manifest_7",
          },
        };
      },
      async getToolApproval() {
        return { status: "pending", decision: null };
      },
    });

    await expect(coordinator.request(base)).resolves.toMatchObject({
      state: "approved_pending_activation",
      grantId: "grant_7",
      grantRevision: 7,
      approvedCanonicalFolder: "/srv/project-b",
      approvedAccessPreset: "read-project",
      expectedBoundaryManifestHash: "manifest_7",
    });
    expect(request).toMatchObject({
      boundaryExpansion: {
        continuationId: expect.stringMatching(/^cont_/),
        canonicalResource: "/srv/project-b/README.md",
        requiresSessionRebuild: true,
      },
    });
  });

  it("fails activation when the approved folder does not cover the requested resource", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const coordinator = new BoundaryExpansionCoordinator(store, {
      async requestToolApproval() {
        return {
          approvalId: "appr_bad",
          status: "allow",
          decision: "allow",
          activation: {
            grantId: "grant_bad",
            grantRevision: 8,
            canonicalFolder: "/srv/other",
            accessPreset: "read-project",
            expectedBoundaryManifestHash: "manifest_bad",
          },
        };
      },
      async getToolApproval() {
        return { status: "pending", decision: null };
      },
    });

    await expect(coordinator.request(base)).resolves.toMatchObject({
      state: "activation_failed",
      errorCode: "approved_boundary_does_not_cover_request",
    });
  });

  it("still accepts a human boundary decision after the old five-minute window", async () => {
    // Regression: slow approvals became stale even though the continuation was durable.
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    let clock = 0;
    const coordinator = new BoundaryExpansionCoordinator(store, {
      async requestToolApproval() {
        return { approvalId: "appr_slow", status: "pending", decision: null };
      },
      async getToolApproval() {
        if (clock < 7 * 60_000) return { status: "pending", decision: null };
        return {
          status: "allow",
          decision: "allow",
          activation: {
            grantId: "grant_slow",
            grantRevision: 9,
            canonicalFolder: "/srv/project-b",
            accessPreset: "read-project",
            expectedBoundaryManifestHash: "manifest_slow",
          },
        };
      },
    });

    await expect(coordinator.request(base, {
      now: () => clock,
      sleep: async () => { clock += 60_000; },
    })).resolves.toMatchObject({
      state: "approved_pending_activation",
      grantId: "grant_slow",
    });
  });

  it("never offers a boundary expansion for credential files", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    let asked = false;
    const result = await requestBoundaryExpansionForTool({
      store,
      gateway: {
        async requestToolApproval() {
          asked = true;
          return { approvalId: "must_not_ask", status: "pending", decision: null };
        },
        async getToolApproval() {
          return { status: "pending", decision: null };
        },
      },
      message: {
        id: "msg_secret",
        clientMessageId: "client_secret",
        communicationSessionId: "comm_secret",
        senderPrincipalId: "prn_a",
        senderDeviceId: "device_a",
        target: { kind: "runtime_session", principalId: "prn_b", endpointId: "ep_b", sessionHandle: "rs_b" },
        kind: "task_invite",
        payload: { task: { text: "Read .env" } },
        sequence: 1,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        trust: "untrusted_external_content",
      },
      sessionHandle: "claude-managed-1",
      runtimeTurnId: "turn_secret",
      attemptId: "tool_secret",
      toolName: "Read",
      toolInput: { file_path: "/srv/project/.env" },
      cwd: "/srv/project",
      summary: "Read /srv/project/.env",
    });

    expect(result).toBeUndefined();
    expect(asked).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
