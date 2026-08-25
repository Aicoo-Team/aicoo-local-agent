import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { ContinuationStore } from "../shared/continuation-store.js";
import { SessionRebuildCoordinator } from "../shared/session-rebuild.js";

interface ContinuationRuntimeEvent {
  type: "turn_started" | "reply" | "turn_failed" | "session_closed";
  inReplyTo?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

/** Replays durable approved work and joins its eventual runtime result back to the checkpoint. */
export class ContinuationRecovery {
  readonly #coordinator: SessionRebuildCoordinator;
  readonly #inFlight = new Set<string>();
  readonly #resumedThisProcess = new Set<string>();

  constructor(
    private readonly store: ContinuationStore,
    private readonly adapter: RuntimeAdapter,
    private readonly log?: (line: string) => void,
  ) {
    this.#coordinator = new SessionRebuildCoordinator(store);
  }

  async recover(): Promise<void> {
    const { quiesceContinuation, rebuildContinuation, resumeContinuation } = this.adapter;
    if (!quiesceContinuation || !rebuildContinuation || !resumeContinuation) return;

    await Promise.all(this.store.listRecoverable().map(async (checkpoint) => {
      if (this.#inFlight.has(checkpoint.continuationId) || this.#resumedThisProcess.has(checkpoint.continuationId)) {
        return;
      }
      this.#inFlight.add(checkpoint.continuationId);
      try {
        if (
          this.adapter.canActivateContinuation
          && !(await this.adapter.canActivateContinuation(checkpoint))
        ) return;
        const result = await this.#coordinator.execute(checkpoint.continuationId, {
          quiesce: (current) => quiesceContinuation.call(this.adapter, current),
          rebuildAndAttest: async (current) => {
            const rebuilt = await rebuildContinuation.call(this.adapter, current);
            return rebuilt.boundaryManifestHash;
          },
          resume: async (current) => {
            const resumed = await resumeContinuation.call(this.adapter, current);
            if (resumed.status !== "runtime_acked") {
              throw new Error(`runtime rejected continuation: ${resumed.status}`);
            }
          },
        });
        if (result.state === "resuming") this.#resumedThisProcess.add(checkpoint.continuationId);
        if (result.state === "activation_failed" || result.state === "resume_failed") {
          this.log?.(`[bridge] continuation ${checkpoint.continuationId} failed: ${result.errorCode}`);
        }
      } finally {
        this.#inFlight.delete(checkpoint.continuationId);
      }
    }));
  }

  handleRuntimeEvent(sessionHandle: string, event: ContinuationRuntimeEvent): void {
    if ((event.type !== "reply" && event.type !== "turn_failed") || !event.inReplyTo) return;
    const checkpoint = this.store.findResuming({
      sessionHandle,
      messageId: event.inReplyTo,
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    });
    if (!checkpoint) return;

    this.#resumedThisProcess.delete(checkpoint.continuationId);
    if (event.type === "reply") {
      this.#coordinator.complete(checkpoint.continuationId);
      return;
    }
    this.store.markResumeFailed(checkpoint.continuationId, "runtime_turn_failed");
  }
}
