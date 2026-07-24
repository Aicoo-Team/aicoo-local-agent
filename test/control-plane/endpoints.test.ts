import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/control-plane/app.js";
import { openDb, type AppDatabase } from "../../src/control-plane/db.js";
import type { RuntimeEndpoint } from "../../src/shared/contracts.js";
import { api, registerManagedSession, TOKENS } from "../helpers/harness.js";

describe("endpoint/session/default-route/offer contracts", () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    app = createApp(db);
  });

  it("auth resolves principal/device and endpoint registration is idempotent", async () => {
    const input = {
      runtime: "claude-code",
      bridgeVersion: "1",
      adapterVersion: "fake-0.1.0",
      capabilities: [],
      principalId: "prn_c",
    };
    const first = await api<RuntimeEndpoint>(app, TOKENS.a, "/api/v1/endpoints", "POST", input);
    const second = await api<RuntimeEndpoint>(app, TOKENS.a, "/api/v1/endpoints", "POST", input);
    expect(first.body.principalId).toBe("prn_a");
    expect(first.body.endpointId).toBe(second.body.endpointId);
    expect((await api(app, "stale", "/api/v1/whoami")).response.status).toBe(401);
  });

  it("A/B/C cannot mutate another device endpoint or session", async () => {
    const a = await registerManagedSession(app, TOKENS.a, "A");
    expect((await api(app, TOKENS.c, `/api/v1/endpoints/${a.endpoint.endpointId}/heartbeat`, "POST")).response.status).toBe(404);
    expect((await api(
      app,
      TOKENS.c,
      `/api/v1/endpoints/${a.endpoint.endpointId}/sessions/${a.session.sessionHandle}`,
      "PATCH",
      { state: "busy" },
    )).response.status).toBe(404);
  });

  it("pins a unique default route and scoped offer without leaking a session handle pre-grant", async () => {
    const b = await registerManagedSession(app, TOKENS.b, "private label");
    const route = await api(app, TOKENS.b, "/api/v1/default-route", "PUT", {
      endpointId: b.endpoint.endpointId,
      sessionHandle: b.session.sessionHandle,
    });
    expect(route.response.status).toBe(200);
    const offer = await api<{ targetOfferId: string }>(app, TOKENS.b, "/api/v1/target-offers", "POST", {
      endpointId: b.endpoint.endpointId,
      sessionHandle: b.session.sessionHandle,
      audiencePrincipalId: "prn_a",
    });
    const targets = await api<unknown[]>(app, TOKENS.a, "/api/v1/targets?personId=prn_b");
    expect(JSON.stringify(targets.body)).toContain(offer.body.targetOfferId);
    expect(JSON.stringify(targets.body)).not.toContain(b.session.sessionHandle);
    expect(JSON.stringify((await api(app, TOKENS.c, "/api/v1/targets?personId=prn_b")).body)).not.toContain(
      offer.body.targetOfferId,
    );
  });
});
