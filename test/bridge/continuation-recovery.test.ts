import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeAdapter } from "../../src/adapters/runtime-adapter.js";
import { ContinuationRecovery } from "../../src/bridge/continuation-recovery.js";
import { ContinuationStore } from "../../src/shared/continuation-store.js";

function approved(store: ContinuationStore, suffix = "1") {
  const checkpoint = store.create({
    idempotencyKey: `comm_${suffix}:msg_${suffix}:tool_${suffix}`,
    correlationId: `corr_${suffix}`,
    communicationSessionId: `comm_${suffix}`,
    messageId: `msg_${suffix}`,
    sessionHandle: `native_${suffix}`,
    runtimeTurnId: `turn_${suffix}`,
    originalMessage: { kind: "task_invite", payload: { task: { text: "Inspect Project B" } } },
    requestedCapability: {
      toolName: "Read",
      canonicalResource: "/srv/project-b/README.md",
      summary: "Read Project B README",
    },
  });
  return store.markApproved(checkpoint.continuationId, {
    grantId: `grant_${suffix}`,
    grantRevision: 1,
    approvedCanonicalFolder: "/srv/project-b",
    approvedAccessPreset: "read-project",
    expectedBoundaryManifestHash: `manifest_${suffix}`,
  });
}

function adapter() {
  return {
    quiesceContinuation: vi.fn(async () => undefined),
    rebuildContinuation: vi.fn(async (checkpoint) => ({
      boundaryManifestHash: checkpoint.expectedBoundaryManifestHash!,
    })),
    resumeContinuation: vi.fn(async () => ({ status: "runtime_acked", runtimeAckId: "ack_1" })),
  } as unknown as RuntimeAdapter & {
    quiesceContinuation: ReturnType<typeof vi.fn>;
    rebuildContinuation: ReturnType<typeof vi.fn>;
    resumeContinuation: ReturnType<typeof vi.fn>;
  };
}

describe("bridge continuation recovery", () => {
  it("rebuilds each approved continuation once and completes it from the matching reply", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const checkpoint = approved(store);
    const runtime = adapter();
    const recovery = new ContinuationRecovery(store, runtime);

    await Promise.all([recovery.recover(), recovery.recover()]);

    expect(runtime.quiesceContinuation).toHaveBeenCalledOnce();
    expect(runtime.rebuildContinuation).toHaveBeenCalledOnce();
    expect(runtime.resumeContinuation).toHaveBeenCalledOnce();
    expect(store.find(checkpoint.continuationId)?.state).toBe("resuming");

    recovery.handleRuntimeEvent("native_1", {
      type: "reply",
      inReplyTo: "msg_1",
      correlationId: "corr_1",
      payload: { text: "Done" },
    });
    recovery.handleRuntimeEvent("native_1", {
      type: "reply",
      inReplyTo: "msg_1",
      correlationId: "corr_1",
      payload: { text: "Duplicate" },
    });

    expect(store.find(checkpoint.continuationId)?.state).toBe("completed");
  });

  it("records a matching resumed runtime failure without affecting another continuation", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const failed = approved(store, "failed");
    const other = approved(store, "other");
    store.markRebuilding(failed.continuationId);
    store.markAttested(failed.continuationId, "manifest_failed");
    store.markRebuilding(other.continuationId);
    store.markAttested(other.continuationId, "manifest_other");
    const recovery = new ContinuationRecovery(store, adapter());

    recovery.handleRuntimeEvent("native_failed", {
      type: "turn_failed",
      inReplyTo: "msg_failed",
      correlationId: "corr_failed",
      payload: { error: "runtime stopped" },
    });

    expect(store.find(failed.continuationId)).toMatchObject({
      state: "resume_failed",
      errorCode: "runtime_turn_failed",
    });
    expect(store.find(other.continuationId)?.state).toBe("resuming");
  });
});
