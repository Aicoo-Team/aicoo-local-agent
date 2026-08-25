import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContinuationCheckpoint, ContinuationStore, CreateContinuationInput } from "./continuation-store.js";
import type { ToolApprovalRequest } from "./aicoo-transport.js";
import { awaitToolApproval, type AwaitToolApprovalOptions, type ToolApprovalGateway } from "./tool-approval.js";

export interface BoundaryExpansionInput extends CreateContinuationInput {
  attemptId: string;
  requestedAccessPreset: "read-project" | "edit-project";
  currentBoundaryManifestHash?: string;
  approval: Omit<ToolApprovalRequest, "boundaryExpansion">;
}

/** Couples one owner decision to one durable continuation and one exact kernel-boundary proposal. */
export class BoundaryExpansionCoordinator {
  constructor(
    private readonly store: ContinuationStore,
    private readonly gateway: ToolApprovalGateway,
  ) {}

  async request(
    input: BoundaryExpansionInput,
    options: AwaitToolApprovalOptions = {},
  ): Promise<ContinuationCheckpoint> {
    const checkpoint = this.store.create({
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      communicationSessionId: input.communicationSessionId,
      messageId: input.messageId,
      sessionHandle: input.sessionHandle,
      runtimeTurnId: input.runtimeTurnId,
      originalMessage: input.originalMessage,
      requestedCapability: input.requestedCapability,
    });
    if (checkpoint.state !== "awaiting_approval") return checkpoint;
    const outcome = await awaitToolApproval(this.gateway, {
      ...input.approval,
      boundaryExpansion: {
        continuationId: checkpoint.continuationId,
        attemptId: input.attemptId,
        resourceKind: "filesystem",
        canonicalResource: input.requestedCapability.canonicalResource,
        requestedAccessPreset: input.requestedAccessPreset,
        ...(input.currentBoundaryManifestHash
          ? { currentBoundaryManifestHash: input.currentBoundaryManifestHash }
          : {}),
        requiresSessionRebuild: true,
      },
    }, options);
    if (outcome.behavior === "deny") {
      if (/declined/i.test(outcome.message)) return this.store.markDenied(checkpoint.continuationId);
      if (/expired|not approved in time/i.test(outcome.message)) {
        return this.store.markApprovalExpired(checkpoint.continuationId);
      }
      return this.store.markApprovalDeliveryFailed(checkpoint.continuationId);
    }

    const activation = outcome.activation!;
    const approved = this.store.markApproved(checkpoint.continuationId, {
      grantId: activation.grantId,
      grantRevision: activation.grantRevision,
      expectedBoundaryManifestHash: activation.expectedBoundaryManifestHash,
    });
    if (
      !contains(activation.canonicalFolder, input.requestedCapability.canonicalResource)
      || (input.requestedAccessPreset === "edit-project" && activation.accessPreset !== "edit-project")
    ) {
      return this.store.markActivationFailed(approved.continuationId, "approved_boundary_does_not_cover_request");
    }
    return approved;
  }
}

function contains(folder: string, resource: string): boolean {
  const canonicalFolder = resolve(folder);
  const canonicalResource = resolve(resource);
  const path = relative(canonicalFolder, canonicalResource);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
