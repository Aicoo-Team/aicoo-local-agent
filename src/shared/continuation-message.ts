import type { InboundMessage } from "../adapters/runtime-adapter.js";
import { projectAccessSelectors } from "../security/relationship-policy.js";
import type { ContinuationCheckpoint } from "./continuation-store.js";

/** Rebuild the bounded task input without changing its root message or correlation identity. */
export function continuationInboundMessage(checkpoint: ContinuationCheckpoint): InboundMessage {
  const original = checkpoint.originalMessage as Partial<InboundMessage>;
  if (
    typeof original.id !== "string"
    || typeof original.clientMessageId !== "string"
    || typeof original.senderPrincipalId !== "string"
    || !original.target
    || !original.payload
    || typeof original.payload !== "object"
  ) throw new Error("continuation original message is invalid");
  if (original.communicationSessionId !== checkpoint.communicationSessionId) {
    throw new Error("continuation original message has a different communication session");
  }
  const approvedFolder = checkpoint.approvedCanonicalFolder;
  if (!approvedFolder) throw new Error("continuation has no approved folder");
  if (!checkpoint.grantId) throw new Error("continuation has no approved grant");
  const selectors = projectAccessSelectors(original as InboundMessage);
  const originalTask = original.payload.task;
  const taskRecord = originalTask && typeof originalTask === "object" && !Array.isArray(originalTask)
    ? originalTask as Record<string, unknown>
    : { text: typeof originalTask === "string" ? originalTask : "Resume the original task" };
  return {
    ...(original as InboundMessage),
    id: original.id,
    clientMessageId: original.clientMessageId,
    communicationSessionId: checkpoint.communicationSessionId,
    correlationId: checkpoint.correlationId,
    kind: "task_invite",
    payload: {
      ...original.payload,
      task: {
        ...taskRecord,
        projectAccessIds: [...new Set([...selectors, checkpoint.grantId, approvedFolder])].sort(),
        continuation: {
          continuationId: checkpoint.continuationId,
          grantId: checkpoint.grantId,
          grantRevision: checkpoint.grantRevision,
          boundaryRebuild: true,
          completedSideEffects: [],
        },
      },
    },
    trust: "untrusted_external_content",
  };
}
