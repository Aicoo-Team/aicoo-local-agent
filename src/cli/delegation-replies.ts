import type { MessageEnvelope } from "../shared/contracts.js";

export function isFinalDelegationReplyEnvelope(envelope: MessageEnvelope | undefined): boolean {
  return Boolean(
    envelope
    && envelope.replyTo
    && envelope.collaborationTurn?.expectsReply !== true
    && envelope.collaborationTurn?.outcome !== "needs_owner",
  );
}

export function authorityDecisionFromEnvelope(
  envelope: MessageEnvelope,
): "allow" | "deny" | null {
  if (envelope.payload.source !== "local_agent_authority_decision") return null;
  return envelope.payload.authorityDecision === "allow" || envelope.payload.authorityDecision === "deny"
    ? envelope.payload.authorityDecision
    : null;
}
