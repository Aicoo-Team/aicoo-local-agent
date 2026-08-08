import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/control-plane/app.js";
import { openDb, type AppDatabase } from "../../src/control-plane/db.js";
import type { LocalAgentDelegationResponse } from "../../src/shared/contracts.js";
import { api, registerManagedSession, TOKENS } from "../helpers/harness.js";

describe("local-agent delegations", () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
  });

  it("requests a grant when no active local-to-local relationship exists and idempotently waits", async () => {
    const a = await registerManagedSession(app, TOKENS.a, "A reply");
    const b = await registerManagedSession(app, TOKENS.b, "B default");
    await api(app, TOKENS.b, "/api/v1/default-route", "PUT", {
      endpointId: b.endpoint.endpointId,
      sessionHandle: b.session.sessionHandle,
    });

    const input = {
      target: { kind: "person_default_runtime" as const, principalId: "prn_b" },
      task: "Please run this locally.",
      sessionHandle: a.session.sessionHandle,
      clientMessageId: "delegate-once",
      correlationId: "corr-delegate",
    };
    const first = await api<LocalAgentDelegationResponse>(
      app,
      TOKENS.a,
      "/api/v1/local-agent/delegations",
      "POST",
      input,
    );
    const second = await api<LocalAgentDelegationResponse>(
      app,
      TOKENS.a,
      "/api/v1/local-agent/delegations",
      "POST",
      input,
    );

    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "grant_requested",
      clientMessageId: "delegate-once",
      correlationId: "corr-delegate",
      duplicate: false,
      communicationSession: { status: "pending" },
    });
    expect(second.response.status).toBe(200);
    if (first.body.status === "collaboration_requested") throw new Error("unexpected collaboration request");
    expect(second.body).toMatchObject({
      status: "grant_requested",
      duplicate: true,
      communicationSession: { id: first.body.communicationSession.id },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM comm_sessions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
  });

  it("retries after grant activation and creates exactly one task_invite", async () => {
    const a = await registerManagedSession(app, TOKENS.a, "A reply");
    const b = await registerManagedSession(app, TOKENS.b, "B default");
    await api(app, TOKENS.b, "/api/v1/default-route", "PUT", {
      endpointId: b.endpoint.endpointId,
      sessionHandle: b.session.sessionHandle,
    });

    const input = {
      target: { kind: "person_default_runtime" as const, principalId: "prn_b" },
      task: { prompt: "Run this in your local runtime." },
      sessionHandle: a.session.sessionHandle,
      clientMessageId: "delegate-after-grant",
      correlationId: "corr-after-grant",
    };
    const requested = await api<LocalAgentDelegationResponse>(
      app,
      TOKENS.a,
      "/api/v1/local-agent/delegations",
      "POST",
      input,
    );
    if (requested.body.status === "collaboration_requested") throw new Error("unexpected collaboration request");
    await api(app, TOKENS.b, `/api/v1/comm-sessions/${requested.body.communicationSession.id}/accept`, "POST");

    const delegated = await api<LocalAgentDelegationResponse>(
      app,
      TOKENS.a,
      "/api/v1/local-agent/delegations",
      "POST",
      input,
    );
    const duplicate = await api<LocalAgentDelegationResponse>(
      app,
      TOKENS.a,
      "/api/v1/local-agent/delegations",
      "POST",
      input,
    );

    expect(delegated.response.status).toBe(201);
    expect(delegated.body).toMatchObject({
      status: "delegated",
      clientMessageId: "delegate-after-grant",
      correlationId: "corr-after-grant",
      duplicate: true,
      communicationSession: { id: requested.body.communicationSession.id, status: "active" },
      receipt: { status: "queued", duplicate: false },
    });
    expect(duplicate.body).toMatchObject({
      status: "delegated",
      duplicate: true,
      receipt: { messageId: delegated.body.status === "delegated" ? delegated.body.receipt.messageId : "" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
    const row = db.prepare("SELECT kind, payload_json, correlation_id FROM messages").get() as {
      kind: string;
      payload_json: string;
      correlation_id: string;
    };
    expect(row.kind).toBe("task_invite");
    expect(row.correlation_id).toBe("corr-after-grant");
    expect(JSON.parse(row.payload_json)).toMatchObject({
      task: { prompt: "Run this in your local runtime." },
      delegation: {
        clientMessageId: "delegate-after-grant",
        correlationId: "corr-after-grant",
        requestedSessionHandle: a.session.sessionHandle,
        untrustedExternalContent: true,
      },
    });
  });
});
