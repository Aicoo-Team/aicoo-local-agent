import { describe, expect, it } from "vitest";
import { parseCollaborationRuntimeReply } from "../../src/bridge/bridge.js";
import { BridgeSpool } from "../../src/bridge/spool.js";

describe("collaboration runtime replies", () => {
  it("creates a bounded reply turn from the runtime protocol", () => {
    expect(parseCollaborationRuntimeReply(
      '{"outcome":"respond","expectsReply":true,"text":"Which checkout variant?"}',
      "runtime-2",
      "turn-1",
    )).toEqual({
      text: "Which checkout variant?",
      turn: {
        clientTurnId: "runtime-turn:runtime-2",
        parentTurnId: "turn-1",
        type: "question",
        expectsReply: true,
        outcome: "respond",
      },
    });
  });

  it("fails closed to a terminal response when runtime output is not structured", () => {
    expect(parseCollaborationRuntimeReply("ordinary reply", "runtime-2", "turn-1"))
      .toMatchObject({
        text: "ordinary reply",
        turn: { expectsReply: false, outcome: "respond" },
      });
  });

  it("only lets completion proposals continue when explicitly requested", () => {
    expect(parseCollaborationRuntimeReply(
      '{"outcome":"propose_complete","expectsReply":true,"text":"Ready to finish"}',
      "runtime-2",
      "turn-1",
    ).turn.expectsReply).toBe(true);
    expect(parseCollaborationRuntimeReply(
      '{"outcome":"propose_complete","expectsReply":false,"text":"Confirmed"}',
      "runtime-3",
      "turn-2",
    ).turn.expectsReply).toBe(false);
  });

  it("blocks queued work and replies when a collaboration ends", () => {
    const spool = new BridgeSpool(":memory:");
    spool.storeDispatch({
      cursor: "1",
      type: "message.dispatch",
      endpointId: "ep-b",
      createdAt: new Date().toISOString(),
      data: {
        deliveryId: "del-1",
        envelope: {
          id: "msg-1",
          clientMessageId: "client-1",
          communicationSessionId: "comm-1",
          collaborationId: "collab-1",
          senderPrincipalId: "peer",
          target: {
            kind: "person_default_runtime",
            principalId: "me",
            endpointId: "ep-b",
            sessionHandle: "rs-b",
          },
          kind: "text",
          payload: { text: "question" },
          sequence: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    spool.storeOutboundReply({
      eventId: "event-1",
      communicationSessionId: "comm-1",
      clientMessageId: "reply-1",
      payload: { text: "answer" },
      replyTo: "msg-1",
      correlationId: "corr-1",
    });
    spool.recordAttempt({
      attemptId: "attempt-1",
      messageId: "msg-1",
      phase: "runtime_ack",
      retryable: false,
      runtimeAckId: "runtime-1",
      createdAt: new Date().toISOString(),
    });

    expect(spool.blockCollaboration("collab-1", "collaboration_completed")).toEqual(["comm-1"]);
    expect(spool.getMessage("msg-1")?.status).toBe("blocked");
    expect(spool.getOutboundReply("event-1")?.status).toBe("failed");
    expect(spool.listPendingReports()).toEqual([]);
    spool.close();
  });
});
