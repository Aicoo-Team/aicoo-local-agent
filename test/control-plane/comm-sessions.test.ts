import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/control-plane/app.js";
import { openDb, type AppDatabase } from "../../src/control-plane/db.js";
import type { CommunicationSession } from "../../src/shared/contracts.js";
import { activateDefaultGrant, api, registerManagedSession, TOKENS } from "../helpers/harness.js";

describe("communication-session lifecycle", () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
  });
  afterEach(() => vi.useRealTimers());

  it("requires recipient approval, freezes a default route, and caps grant at 30 minutes", async () => {
    const { commSessionId, b } = await activateDefaultGrant(app);
    const current = await api<CommunicationSession>(app, TOKENS.a, `/api/v1/comm-sessions/${commSessionId}`);
    expect(current.body.status).toBe("active");
    expect(current.body.recipient.endpointId).toBe(b.endpoint.endpointId);
    expect(current.body.recipient.sessionHandle).toBe(b.session.sessionHandle);
    expect(new Date(current.body.grantExpiresAt as string).getTime() - new Date(current.body.activatedAt as string).getTime())
      .toBe(30 * 60_000);
  });

  it("rejects human_inbox as a communication-grant target and rejects third-party acceptance", async () => {
    const a = await registerManagedSession(app, TOKENS.a, "A");
    const invalid = await api(app, TOKENS.a, "/api/v1/comm-sessions", "POST", {
      target: { kind: "human_inbox", principalId: "prn_b" },
      replyEndpointId: a.endpoint.endpointId,
      replySessionHandle: a.session.sessionHandle,
    });
    expect(invalid.response.status).toBe(400);

    await registerManagedSession(app, TOKENS.b, "B");
    const request = await api<{ id: string }>(app, TOKENS.a, "/api/v1/comm-sessions", "POST", {
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: a.endpoint.endpointId,
      replySessionHandle: a.session.sessionHandle,
    });
    expect((await api(app, TOKENS.c, `/api/v1/comm-sessions/${request.body.id}/accept`, "POST")).response.status).toBe(404);
  });

  it("expires from server time and cannot be reactivated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const { commSessionId } = await activateDefaultGrant(app);
    vi.setSystemTime(new Date("2026-07-16T00:31:00.000Z"));
    const current = await api<CommunicationSession>(app, TOKENS.a, `/api/v1/comm-sessions/${commSessionId}`);
    expect(current.body.status).toBe("expired");
    expect((await api(app, TOKENS.a, `/api/v1/comm-sessions/${commSessionId}/revoke`, "POST")).response.status).toBe(409);
  });

  it("either participant can revoke and C cannot observe the grant", async () => {
    const { commSessionId } = await activateDefaultGrant(app);
    expect((await api(app, TOKENS.c, `/api/v1/comm-sessions/${commSessionId}`)).response.status).toBe(404);
    expect((await api(app, TOKENS.b, `/api/v1/comm-sessions/${commSessionId}/revoke`, "POST")).response.status).toBe(204);
    const current = await api<CommunicationSession>(app, TOKENS.a, `/api/v1/comm-sessions/${commSessionId}`);
    expect(current.body.status).toBe("revoked");
  });
});
