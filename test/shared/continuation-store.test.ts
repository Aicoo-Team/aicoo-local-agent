import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ContinuationStore } from "../../src/shared/continuation-store.js";

const checkpoint = {
  idempotencyKey: "comm_1:msg_1:tool_1",
  correlationId: "corr_1",
  communicationSessionId: "comm_1",
  messageId: "msg_1",
  sessionHandle: "claude-managed-1",
  runtimeTurnId: "turn_1",
  originalMessage: { kind: "task_invite", payload: { task: { text: "Inspect Project B" } } },
  requestedCapability: {
    toolName: "Read",
    canonicalResource: "/srv/project-b/README.md",
    summary: "Read Project B README",
  },
};

describe("durable C2C continuation store", () => {
  it("deduplicates the same paused tool attempt and rejects conflicting reuse", () => {
    const db = new DatabaseSync(":memory:");
    const store = new ContinuationStore(db);

    const first = store.create(checkpoint);
    expect(store.create(checkpoint)).toEqual(first);
    expect(() => store.create({
      ...checkpoint,
      requestedCapability: { ...checkpoint.requestedCapability, toolName: "Edit" },
    })).toThrow("continuation idempotency conflict");
    expect(store.list()).toHaveLength(1);
  });

  it("requires approve, rebuild, attest, and resume before completion", () => {
    const db = new DatabaseSync(":memory:");
    const store = new ContinuationStore(db);
    const pending = store.create(checkpoint);

    expect(() => store.markCompleted(pending.continuationId)).toThrow("invalid continuation transition");
    store.markApproved(pending.continuationId, {
      grantId: "grant_1",
      grantRevision: 3,
      expectedBoundaryManifestHash: "manifest_1",
    });
    store.markRebuilding(pending.continuationId);
    store.markAttested(pending.continuationId, "manifest_1");
    store.markResuming(pending.continuationId);
    const completed = store.markCompleted(pending.continuationId);

    expect(completed).toMatchObject({
      state: "completed",
      grantId: "grant_1",
      grantRevision: 3,
      boundaryManifestHash: "manifest_1",
    });
  });

  it("fails closed when the rebuilt kernel manifest does not match approval", () => {
    const db = new DatabaseSync(":memory:");
    const store = new ContinuationStore(db);
    const pending = store.create(checkpoint);
    store.markApproved(pending.continuationId, {
      grantId: "grant_1",
      grantRevision: 3,
      expectedBoundaryManifestHash: "expected",
    });
    store.markRebuilding(pending.continuationId);

    expect(store.markAttested(pending.continuationId, "different")).toMatchObject({
      state: "activation_failed",
      errorCode: "boundary_attestation_mismatch",
    });
    expect(() => store.markResuming(pending.continuationId)).toThrow("invalid continuation transition");
  });

  it("keeps terminal approval outcomes idempotent", () => {
    const db = new DatabaseSync(":memory:");
    const store = new ContinuationStore(db);
    const pending = store.create(checkpoint);

    expect(store.markApprovalExpired(pending.continuationId)).toMatchObject({ state: "approval_expired" });
    expect(store.markApprovalExpired(pending.continuationId)).toMatchObject({ state: "approval_expired" });
    expect(() => store.markApproved(pending.continuationId, {
      grantId: "late",
      grantRevision: 4,
      expectedBoundaryManifestHash: "late",
    })).toThrow("invalid continuation transition");
  });

  it("recovers approved and rebuilding continuations after process restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-continuation-"));
    const file = join(directory, "state.db");
    const firstDb = new DatabaseSync(file);
    const firstStore = new ContinuationStore(firstDb);
    const pending = firstStore.create(checkpoint);
    firstStore.markApproved(pending.continuationId, {
      grantId: "grant_1",
      grantRevision: 3,
      expectedBoundaryManifestHash: "manifest_1",
    });
    firstDb.close();

    const secondDb = new DatabaseSync(file);
    const secondStore = new ContinuationStore(secondDb);
    expect(secondStore.listRecoverable()).toEqual([
      expect.objectContaining({
        continuationId: pending.continuationId,
        state: "approved_pending_activation",
      }),
    ]);
    secondStore.markActivationFailed(pending.continuationId, "session_launch_failed");
    expect(secondStore.listRecoverable()).toEqual([]);
    secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
