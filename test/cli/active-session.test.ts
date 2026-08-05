import { describe, expect, it } from "vitest";
import type { CommunicationSession } from "../../src/shared/contracts.js";
import { selectLocalSessionForPeer } from "../../src/cli/active-session.js";

function session(input: {
  id: string;
  requester: string;
  recipient: string;
  requesterEndpoint: string;
  requesterSession: string;
  recipientEndpoint: string;
  recipientSession: string;
  activatedAt: string;
}): CommunicationSession {
  return {
    id: input.id,
    requester: {
      principalId: input.requester,
      replyEndpointId: input.requesterEndpoint,
      replySessionHandle: input.requesterSession,
    },
    recipient: {
      principalId: input.recipient,
      targetKind: "person_default_runtime",
      endpointId: input.recipientEndpoint,
      sessionHandle: input.recipientSession,
    },
    status: "active",
    capabilities: ["message:send", "message:reply"],
    requestedAt: input.activatedAt,
    requestExpiresAt: "2026-08-05T12:00:00.000Z",
    activatedAt: input.activatedAt,
    grantExpiresAt: "2026-08-05T12:00:00.000Z",
  };
}

describe("local C2C session selection", () => {
  it("ignores a newer reverse web-chat grant and selects the local runtime grant", () => {
    // Regression: send-to selected chat:9 and the peer Codex never received the task.
    const chat = session({
      id: "comm-chat",
      requester: "peer",
      recipient: "me",
      requesterEndpoint: "chat:9",
      requesterSession: "chat:9",
      recipientEndpoint: "ep-me",
      recipientSession: "rs-me",
      activatedAt: "2026-08-05T11:00:00.000Z",
    });
    const local = session({
      id: "comm-local",
      requester: "me",
      recipient: "peer",
      requesterEndpoint: "ep-me",
      requesterSession: "rs-me",
      recipientEndpoint: "ep-peer",
      recipientSession: "rs-peer",
      activatedAt: "2026-08-05T10:00:00.000Z",
    });

    expect(selectLocalSessionForPeer([chat, local], "me", "peer")?.id).toBe("comm-local");
  });

  it("returns no session when the only computed destination is web chat", () => {
    const chat = session({
      id: "comm-chat",
      requester: "peer",
      recipient: "me",
      requesterEndpoint: "chat:9",
      requesterSession: "chat:9",
      recipientEndpoint: "ep-me",
      recipientSession: "rs-me",
      activatedAt: "2026-08-05T11:00:00.000Z",
    });

    expect(selectLocalSessionForPeer([chat], "me", "peer")).toBeUndefined();
  });
});
