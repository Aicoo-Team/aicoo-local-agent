import { describe, expect, it } from "vitest";
import { BridgeSpool } from "../../src/bridge/spool.js";

describe("delegation replies in the bridge spool", () => {
  it("finds a reply by its correlation ID", () => {
    const spool = new BridgeSpool(":memory:");
    spool.storeDispatch({
      cursor: "1",
      type: "message.dispatch",
      endpointId: "ep-a",
      createdAt: "2026-08-05T00:00:00.000Z",
      data: {
        deliveryId: "del-reply",
        envelope: {
          id: "msg-reply",
          clientMessageId: "runtime-reply",
          communicationSessionId: "comm-1",
          senderPrincipalId: "peer",
          target: { kind: "person_default_runtime", principalId: "me", endpointId: "ep-a", sessionHandle: "rs-a" },
          kind: "text",
          payload: { text: "Natural reply" },
          replyTo: "msg-task",
          correlationId: "corr-1",
          sequence: 2,
          createdAt: "2026-08-05T00:00:00.000Z",
          expiresAt: "2026-08-05T00:30:00.000Z",
        },
      },
    });

    expect(spool.findReplyByCorrelation("corr-1")?.envelope.payload.text).toBe("Natural reply");
    expect(spool.findReplyByCorrelation("missing")).toBeUndefined();
    spool.close();
  });
});
