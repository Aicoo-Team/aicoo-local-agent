import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/control-plane/app.js";
import { openDb, type AppDatabase } from "../../src/control-plane/db.js";
import type { MessageDelivery, MessageReceipt } from "../../src/shared/contracts.js";
import { activateDefaultGrant, api, TOKENS } from "../helpers/harness.js";

describe("message persistence, identity, idempotency, and ACKs", () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
  });

  it("derives sender/target from auth+grant and provides sender-scoped idempotency", async () => {
    const { commSessionId, b } = await activateDefaultGrant(app);
    const body = {
      communicationSessionId: commSessionId,
      clientMessageId: "same-client-id",
      kind: "text",
      payload: { text: "hello" },
      from: "prn_c",
      target: { kind: "runtime_session", endpointId: "forged" },
    };
    const first = await api<MessageReceipt>(app, TOKENS.a, "/api/v1/messages", "POST", body);
    const duplicate = await api<MessageReceipt>(app, TOKENS.a, "/api/v1/messages", "POST", body);
    expect(first.response.status).toBe(201);
    expect(duplicate.body.messageId).toBe(first.body.messageId);
    expect(duplicate.body.duplicate).toBe(true);
    const row = db.prepare(
      "SELECT sender_principal_id, sender_device_id, target_endpoint_id FROM messages WHERE message_id = ?",
    ).get(
      first.body.messageId,
    ) as { sender_principal_id: string; sender_device_id: string; target_endpoint_id: string };
    expect(row).toEqual({
      sender_principal_id: "prn_a",
      sender_device_id: "device-a1",
      target_endpoint_id: b.endpoint.endpointId,
    });

    const conflict = await api(app, TOKENS.a, "/api/v1/messages", "POST", { ...body, payload: { text: "changed" } });
    expect(conflict.response.status).toBe(409);
  });

  it("human inbox persists without a runtime grant and cannot receive a device/runtime ACK", async () => {
    const sent = await api<MessageReceipt>(app, TOKENS.a, "/api/v1/messages", "POST", {
      target: { kind: "human_inbox", principalId: "prn_b" },
      clientMessageId: "inbox-1",
      kind: "text",
      payload: { text: "for a person" },
    });
    expect(sent.body.status).toBe("inbox_persisted");
    const inbox = await api<unknown[]>(app, TOKENS.b, "/api/v1/inbox");
    expect(inbox.body).toHaveLength(1);
    const ack = await api(app, TOKENS.b, `/api/v1/messages/${sent.body.messageId}/ack`, "POST", {
      phase: "runtime_ack",
      attemptId: "attempt-inbox",
      runtimeAckId: "forged",
    });
    expect(ack.response.status).toBe(409);
    expect((await api(app, TOKENS.a, `/api/v1/messages/${sent.body.messageId}/status`)).body).toMatchObject({
      status: "inbox_persisted",
    });
  });

  it("only the delivery endpoint can ACK and queued_busy remains runtime_pending", async () => {
    const { commSessionId, b } = await activateDefaultGrant(app);
    const sent = await api<MessageReceipt>(app, TOKENS.a, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "ack-1",
      kind: "text",
      payload: { text: "hello" },
    });
    const ackPath = `/api/v1/messages/${sent.body.messageId}/ack`;
    expect((await api(app, TOKENS.c, ackPath, "POST", { phase: "device_ack", attemptId: "c" })).response.status).toBe(403);
    expect((await api(app, TOKENS.b, ackPath, "POST", { phase: "device_ack", attemptId: "b-device" })).response.status).toBe(200);
    expect((await api(app, TOKENS.b, ackPath, "POST", {
      phase: "runtime_pending",
      attemptId: "b-busy",
      resultCode: "queued_busy",
      retryable: true,
    })).response.status).toBe(200);
    const status = await api<MessageDelivery>(app, TOKENS.a, `/api/v1/messages/${sent.body.messageId}/status`);
    expect(status.body.status).toBe("runtime_pending");
    expect(status.body.runtimeAckReceivedAt).toBeUndefined();
    expect(status.body.attempts).toHaveLength(2);
    expect(b.endpoint.principalId).toBe("prn_b");
  });

  it("preserves reply correlation and derives the reverse target from the frozen grant", async () => {
    const { commSessionId, a } = await activateDefaultGrant(app);
    const initial = await api<MessageReceipt>(app, TOKENS.a, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "reply-initial",
      kind: "text",
      payload: { text: "hello B" },
      correlationId: "corr-frozen",
    });
    const reply = await api<MessageReceipt>(app, TOKENS.b, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "reply-from-b",
      kind: "text",
      payload: { text: "hello A" },
      replyTo: initial.body.messageId,
      correlationId: "corr-frozen",
      target: { endpointId: "forged", sessionHandle: "forged" },
    });
    expect(reply.response.status).toBe(201);
    const row = db.prepare(
      `SELECT target_endpoint_id, target_session_handle, reply_to, correlation_id
       FROM messages WHERE message_id = ?`,
    ).get(reply.body.messageId) as {
      target_endpoint_id: string;
      target_session_handle: string;
      reply_to: string;
      correlation_id: string;
    };
    expect(row).toEqual({
      target_endpoint_id: a.endpoint.endpointId,
      target_session_handle: a.session.sessionHandle,
      reply_to: initial.body.messageId,
      correlation_id: "corr-frozen",
    });

    const other = await activateDefaultGrant(app);
    const crossGrant = await api(app, TOKENS.b, "/api/v1/messages", "POST", {
      communicationSessionId: other.commSessionId,
      clientMessageId: "cross-grant-reply",
      kind: "text",
      payload: { text: "wrong conversation" },
      replyTo: initial.body.messageId,
    });
    expect(crossGrant.response.status).toBe(409);
    expect(crossGrant.body).toMatchObject({ error: { code: "wrong_target" } });
  });

  it("rejects oversized/unknown input and post-revoke sends", async () => {
    const { commSessionId } = await activateDefaultGrant(app);
    expect((await api(app, TOKENS.a, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "bad-kind",
      kind: "control",
      payload: {},
    })).response.status).toBe(403);
    expect((await api(app, TOKENS.a, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "large",
      kind: "text",
      payload: { text: "x".repeat(33 * 1024) },
    })).response.status).toBe(400);
    await api(app, TOKENS.b, `/api/v1/comm-sessions/${commSessionId}/revoke`, "POST");
    expect((await api(app, TOKENS.a, "/api/v1/messages", "POST", {
      communicationSessionId: commSessionId,
      clientMessageId: "revoked",
      kind: "text",
      payload: { text: "no" },
    })).response.status).toBe(403);
  });
});
