import { accessPresetForTool } from "../security/relationship-access.js";
import { canonicalToolResourceForApproval } from "../security/relationship-policy.js";
import type { InboundMessage } from "../adapters/runtime-adapter.js";
import { BoundaryExpansionCoordinator } from "./boundary-expansion.js";
import type { ContinuationCheckpoint, ContinuationStore } from "./continuation-store.js";
import type { ToolApprovalGateway } from "./tool-approval.js";

export async function requestBoundaryExpansionForTool(input: {
  store: ContinuationStore;
  gateway: ToolApprovalGateway;
  message: InboundMessage;
  sessionHandle: string;
  runtimeTurnId: string;
  attemptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  summary: string;
  log?: (line: string) => void;
}): Promise<ContinuationCheckpoint | undefined> {
  const communicationSessionId = input.message.communicationSessionId;
  const requestedAccessPreset = accessPresetForTool(input.toolName);
  const canonicalResource = canonicalToolResourceForApproval(
    { toolName: input.toolName, input: input.toolInput },
    input.cwd,
  );
  if (!communicationSessionId || !requestedAccessPreset || !canonicalResource) return undefined;

  try {
    return await new BoundaryExpansionCoordinator(input.store, input.gateway).request({
      idempotencyKey: `${communicationSessionId}:${input.message.id}:${input.attemptId}`,
      correlationId: input.message.correlationId ?? input.message.id,
      communicationSessionId,
      messageId: input.message.id,
      sessionHandle: input.sessionHandle,
      runtimeTurnId: input.runtimeTurnId,
      originalMessage: input.message,
      requestedCapability: {
        toolName: input.toolName,
        canonicalResource,
        summary: input.summary,
      },
      attemptId: input.attemptId,
      requestedAccessPreset,
      approval: {
        communicationSessionId,
        sessionHandle: input.sessionHandle,
        messageId: input.message.id,
        toolName: input.toolName,
        toolInputSummary: input.summary,
      },
    }, { log: input.log });
  } catch (error) {
    input.log?.(`boundary expansion request failed closed: ${String(error)}`);
    return undefined;
  }
}
