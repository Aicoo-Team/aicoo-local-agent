import { describe, expect, it } from "vitest";
import type { MessageDelivery, MessageEnvelope } from "../../src/shared/contracts.js";
import {
  authorityDecisionFromEnvelope,
  delegationDeliveryFailure,
  isFinalDelegationReplyEnvelope,
} from "../../src/cli/delegation-replies.js";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: "msg-reply",
    clientMessageId: "reply-1",
    senderPrincipalId: "owner-b",
    target: { kind: "person_default_runtime", principalId: "owner-a" },
    kind: "text",
    payload: { text: "result" },
    replyTo: "msg-task",
    correlationId: "goal:acme:approval",
    sequence: 2,
    createdAt: "2026-08-19T10:00:00.000Z",
    expiresAt: "2026-08-19T10:30:00.000Z",
    ...overrides,
  };
}

describe("delegation reply completion", () => {
  it("accepts a peer completion proposal as the delegated result", () => {
    expect(isFinalDelegationReplyEnvelope(envelope({
      collaborationTurn: {
        turnId: "turn-2",
        clientTurnId: "peer-2",
        parentTurnId: "turn-1",
        sequence: 2,
        type: "question",
        expectsReply: true,
        outcome: "propose_complete",
      },
    }))).toBe(true);
  });

  it("keeps waiting when the peer asks a non-terminal follow-up question", () => {
    expect(isFinalDelegationReplyEnvelope(envelope({
      collaborationTurn: {
        turnId: "turn-2",
        clientTurnId: "peer-2",
        parentTurnId: "turn-1",
        sequence: 2,
        type: "question",
        expectsReply: true,
        outcome: "respond",
      },
    }))).toBe(false);
  });

  it("returns an owner-needed response when no approval continuation was advertised", () => {
    expect(isFinalDelegationReplyEnvelope(envelope({
      collaborationTurn: {
        turnId: "turn-2",
        clientTurnId: "peer-2",
        parentTurnId: "turn-1",
        sequence: 2,
        type: "response",
        expectsReply: false,
        outcome: "needs_owner",
      },
    }))).toBe(true);
  });

  it("turns a project-access delivery failure into an actionable result", () => {
    expect(delegationDeliveryFailure({
      status: "failed",
      resultCode: "project_access_required",
    } as MessageDelivery)).toBe(
      "project_access_required: the peer has not granted access to a project for this request",
    );
    expect(delegationDeliveryFailure({ status: "runtime_pending" } as MessageDelivery)).toBeUndefined();
  });

  it.each(["allow", "deny"] as const)("accepts a synchronized %s decision as final", (decision) => {
    const reply = envelope({
      payload: {
        text: `Human authority ${decision}`,
        source: "local_agent_authority_decision",
        authorityDecision: decision,
      },
    });

    expect(isFinalDelegationReplyEnvelope(reply)).toBe(true);
    expect(authorityDecisionFromEnvelope(reply)).toBe(decision);
  });

  it("does not trust an authorityDecision field without the server source marker", () => {
    expect(authorityDecisionFromEnvelope(envelope({
      payload: { authorityDecision: "allow", source: "peer_text" },
    }))).toBeNull();
  });
});
