import type { RuntimeAdapter } from "../adapters/runtime-adapter.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BoundaryTelemetry } from "../adapters/boundary-telemetry.js";
import { ContinuationStore } from "../shared/continuation-store.js";
import { SessionRebuildCoordinator } from "../shared/session-rebuild.js";
import type { BoundaryActivation } from "../shared/aicoo-transport.js";
import type { ToolApprovalGateway } from "../shared/tool-approval.js";

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
    private readonly boundaryTelemetry?: BoundaryTelemetry,
    private readonly approvalGateway?: ToolApprovalGateway,
  ) {
    this.#coordinator = new SessionRebuildCoordinator(store);
  }

  async recover(): Promise<void> {
    await this.recoverAwaitingDecisions();
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
        const startedState = checkpoint.state;
        const startedAt = Date.now();
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
        if (startedState !== "resuming") {
          const failed = result.state === "activation_failed" || result.state === "resume_failed";
          this.boundaryTelemetry?.recordTransition({
            transitionId: `continuation:${checkpoint.continuationId}`,
            messageId: checkpoint.messageId,
            kind: "post_start_rebuild",
            cause: "approval_boundary_expansion",
            boundaryKey: result.boundaryManifestHash
              ?? result.expectedBoundaryManifestHash
              ?? checkpoint.continuationId,
            success: !failed && result.state === "resuming",
            latencyMs: Date.now() - startedAt,
            ...(failed && result.errorCode ? { failureCode: result.errorCode } : {}),
          });
        }
        if (result.state === "resuming") this.#resumedThisProcess.add(checkpoint.continuationId);
        if (result.state === "activation_failed" || result.state === "resume_failed") {
          this.log?.(`[bridge] continuation ${checkpoint.continuationId} failed: ${result.errorCode}`);
        }
      } finally {
        this.#inFlight.delete(checkpoint.continuationId);
      }
    }));
  }

  private async recoverAwaitingDecisions(): Promise<void> {
    if (!this.approvalGateway) return;
    await Promise.all(this.store.listAwaitingDecisions().map(async (checkpoint) => {
      try {
        const current = await this.approvalGateway!.getToolApproval(checkpoint.approvalId!);
        if (current.status === "pending" && current.decision === null) return;
        if (current.decision === "deny") {
          this.store.markDenied(checkpoint.continuationId);
          return;
        }
        if (current.decision === "allow") {
          if (!validActivation(current.activation)
            || !contains(current.activation.canonicalFolder, checkpoint.requestedCapability.canonicalResource)) {
            this.store.markApprovalDeliveryFailed(checkpoint.continuationId);
            return;
          }
          this.store.markApproved(checkpoint.continuationId, {
            grantId: current.activation.grantId,
            grantRevision: current.activation.grantRevision,
            approvedCanonicalFolder: current.activation.canonicalFolder,
            approvedAccessPreset: current.activation.accessPreset,
            expectedBoundaryManifestHash: current.activation.expectedBoundaryManifestHash,
          });
          return;
        }
        if (current.status !== "pending") this.store.markApprovalExpired(checkpoint.continuationId);
      } catch (error) {
        this.log?.(`[bridge] continuation approval recovery deferred: ${String(error)}`);
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

function validActivation(value: BoundaryActivation | null | undefined): value is BoundaryActivation {
  return Boolean(
    value
    && typeof value.grantId === "string" && value.grantId.trim()
    && Number.isSafeInteger(value.grantRevision) && value.grantRevision >= 0
    && typeof value.canonicalFolder === "string" && value.canonicalFolder.trim()
    && (value.accessPreset === "read-project" || value.accessPreset === "edit-project")
    && typeof value.expectedBoundaryManifestHash === "string"
    && value.expectedBoundaryManifestHash.trim(),
  );
}

function contains(folder: string, resource: string): boolean {
  const path = relative(resolve(folder), resolve(resource));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
