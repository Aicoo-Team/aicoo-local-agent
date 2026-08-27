import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ContinuationStore } from "../../src/shared/continuation-store.js";
import { SessionRebuildCoordinator } from "../../src/shared/session-rebuild.js";

function approved(store: ContinuationStore) {
  const checkpoint = store.create({
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
  });
  return store.markApproved(checkpoint.continuationId, {
    grantId: "grant_7",
    grantRevision: 7,
    approvedCanonicalFolder: "/srv/project-b",
    approvedAccessPreset: "read-project",
    expectedBoundaryManifestHash: "manifest_7",
  });
}

describe("session rebuild coordinator", () => {
  it("quiesces, rebuilds, attests, and resumes in order", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const checkpoint = approved(store);
    const calls: string[] = [];
    const coordinator = new SessionRebuildCoordinator(store);

    const result = await coordinator.execute(checkpoint.continuationId, {
      async quiesce() { calls.push("quiesce"); },
      async rebuildAndAttest() { calls.push("rebuild"); return "manifest_7"; },
      async resume() { calls.push("resume"); },
    });

    expect(calls).toEqual(["quiesce", "rebuild", "resume"]);
    expect(result).toMatchObject({ state: "resuming", boundaryManifestHash: "manifest_7" });
    expect(coordinator.complete(checkpoint.continuationId)).toMatchObject({ state: "completed" });
  });

  it("never resumes a boundary whose attestation mismatches approval", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const checkpoint = approved(store);
    const resume = vi.fn(async () => undefined);
    const coordinator = new SessionRebuildCoordinator(store);

    await expect(coordinator.execute(checkpoint.continuationId, {
      async quiesce() {},
      async rebuildAndAttest() { return "wrong_manifest"; },
      resume,
    })).resolves.toMatchObject({
      state: "activation_failed",
      errorCode: "boundary_attestation_mismatch",
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("records launch and continuation-injection failures separately", async () => {
    const quiesceStore = new ContinuationStore(new DatabaseSync(":memory:"));
    const quiescence = approved(quiesceStore);
    const quiesceCoordinator = new SessionRebuildCoordinator(quiesceStore);
    await expect(quiesceCoordinator.execute(quiescence.continuationId, {
      async quiesce() { throw new Error("still running"); },
      async rebuildAndAttest() { return "manifest_7"; },
      async resume() {},
    })).resolves.toMatchObject({ state: "activation_failed", errorCode: "session_quiesce_failed" });

    const activationStore = new ContinuationStore(new DatabaseSync(":memory:"));
    const activation = approved(activationStore);
    const activationCoordinator = new SessionRebuildCoordinator(activationStore);
    await expect(activationCoordinator.execute(activation.continuationId, {
      async quiesce() {},
      async rebuildAndAttest() { throw new Error("launch failed"); },
      async resume() {},
    })).resolves.toMatchObject({ state: "activation_failed", errorCode: "session_launch_failed" });

    const resumeStore = new ContinuationStore(new DatabaseSync(":memory:"));
    const resumption = approved(resumeStore);
    const resumeCoordinator = new SessionRebuildCoordinator(resumeStore);
    await expect(resumeCoordinator.execute(resumption.continuationId, {
      async quiesce() {},
      async rebuildAndAttest() { return "manifest_7"; },
      async resume() { throw new Error("inject failed"); },
    })).resolves.toMatchObject({ state: "resume_failed", errorCode: "continuation_injection_failed" });
  });

  it("recovers from durable rebuilding and resuming states without replaying completed work", async () => {
    const store = new ContinuationStore(new DatabaseSync(":memory:"));
    const rebuilding = approved(store);
    store.markRebuilding(rebuilding.continuationId);
    const coordinator = new SessionRebuildCoordinator(store);
    const quiesce = vi.fn(async () => undefined);
    const resume = vi.fn(async () => undefined);

    await coordinator.execute(rebuilding.continuationId, {
      quiesce,
      async rebuildAndAttest() { return "manifest_7"; },
      resume,
    });
    expect(quiesce).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();

    coordinator.complete(rebuilding.continuationId);
    await coordinator.execute(rebuilding.continuationId, {
      quiesce,
      async rebuildAndAttest() { throw new Error("must not rebuild"); },
      resume,
    });
    expect(quiesce).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
});
