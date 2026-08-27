import type { MessageDelivery, MessageEnvelope } from "../shared/contracts.js";

export function isFinalDelegationReplyEnvelope(envelope: MessageEnvelope | undefined): boolean {
  const turn = envelope?.collaborationTurn;
  return Boolean(
    envelope
    && envelope.replyTo
    && (turn?.expectsReply !== true || turn.outcome === "propose_complete"),
  );
}

export function delegationDeliveryFailure(delivery: MessageDelivery): string | undefined {
  if (!["failed", "rejected", "expired", "revoked"].includes(delivery.status)) return undefined;
  if (delivery.resultCode === "project_access_required") {
    return "project_access_required: the peer has not granted access to a project for this request";
  }
  if (delivery.resultCode === "project_selection_required") {
    return "project_selection_required: select one of the peer's approved projects and retry";
  }
  if (delivery.resultCode === "project_access_not_found") {
    return "project_access_not_found: the selected project grant is missing or no longer active";
  }
  return `delegation_${delivery.status}: ${delivery.resultCode ?? "delivery did not reach the peer runtime"}`;
}

export function authorityDecisionFromEnvelope(
  envelope: MessageEnvelope,
): "allow" | "deny" | null {
  if (envelope.payload.source !== "local_agent_authority_decision") return null;
  return envelope.payload.authorityDecision === "allow" || envelope.payload.authorityDecision === "deny"
    ? envelope.payload.authorityDecision
    : null;
}
