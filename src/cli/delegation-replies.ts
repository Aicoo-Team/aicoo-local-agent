import type { MessageEnvelope } from "../shared/contracts.js";

export function isFinalDelegationReplyEnvelope(envelope: MessageEnvelope | undefined): boolean {
  const turn = envelope?.collaborationTurn;
  return Boolean(
    envelope
    && envelope.replyTo
    && turn?.outcome !== "needs_owner"
    && (turn?.expectsReply !== true || turn.outcome === "propose_complete"),
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
