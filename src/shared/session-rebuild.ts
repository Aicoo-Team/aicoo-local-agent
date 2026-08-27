import type { ContinuationCheckpoint, ContinuationStore } from "./continuation-store.js";

export interface SessionRebuildOperations {
  /** Must be idempotent: recovery may repeat quiescence after a process crash. */
  quiesce(checkpoint: ContinuationCheckpoint): Promise<void>;
  /** Build a replacement sandbox and return the manifest hash observed from that runtime. */
  rebuildAndAttest(checkpoint: ContinuationCheckpoint): Promise<string>;
  /** Inject the bounded continuation with the continuation ID as its idempotency key. */
  resume(checkpoint: ContinuationCheckpoint): Promise<void>;
}

/** Runtime-neutral execution of the immutable-boundary rebuild protocol. */
export class SessionRebuildCoordinator {
  constructor(private readonly store: ContinuationStore) {}

  async execute(
    continuationId: string,
    operations: SessionRebuildOperations,
  ): Promise<ContinuationCheckpoint> {
    let checkpoint = this.require(continuationId);
    if (isTerminal(checkpoint.state)) return checkpoint;

    if (checkpoint.state === "approved_pending_activation") {
      checkpoint = this.store.markRebuilding(continuationId);
    }
    if (checkpoint.state === "rebuilding_session") {
      try {
        await operations.quiesce(checkpoint);
      } catch {
        return this.store.markActivationFailed(continuationId, "session_quiesce_failed");
      }
      try {
        const manifest = await operations.rebuildAndAttest(checkpoint);
        checkpoint = this.store.markAttested(continuationId, manifest);
      } catch {
        return this.store.markActivationFailed(continuationId, "session_launch_failed");
      }
      if (checkpoint.state !== "resuming") return checkpoint;
    }
    if (checkpoint.state === "resuming") {
      try {
        await operations.resume(checkpoint);
        return this.store.markResuming(continuationId);
      } catch {
        return this.store.markResumeFailed(continuationId, "continuation_injection_failed");
      }
    }
    return checkpoint;
  }

  complete(continuationId: string): ContinuationCheckpoint {
    return this.store.markCompleted(continuationId);
  }

  private require(continuationId: string): ContinuationCheckpoint {
    const checkpoint = this.store.find(continuationId);
    if (!checkpoint) throw new Error(`unknown continuation: ${continuationId}`);
    return checkpoint;
  }
}

function isTerminal(state: ContinuationCheckpoint["state"]): boolean {
  return [
    "completed",
    "denied",
    "approval_expired",
    "approval_delivery_failed",
    "activation_failed",
    "resume_failed",
  ].includes(state);
}
