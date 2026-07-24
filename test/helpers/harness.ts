import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { expect } from "vitest";
import { createApp } from "../../src/control-plane/app.js";
import { openDb, type AppDatabase } from "../../src/control-plane/db.js";
import type { RuntimeEndpoint, RuntimeSessionBinding } from "../../src/shared/contracts.js";

export const TOKENS = {
  a: "ccd-token-a1",
  b: "ccd-token-b1",
  c: "ccd-token-c1",
} as const;

export async function api<T = unknown>(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; body: T }> {
  const response = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = response.status === 204 ? undefined : await response.json();
  return { response, body: parsed as T };
}

export async function registerManagedSession(
  app: ReturnType<typeof createApp>,
  token: string,
  label: string,
): Promise<{ endpoint: RuntimeEndpoint; session: RuntimeSessionBinding }> {
  const endpointResult = await api<RuntimeEndpoint>(app, token, "/api/v1/endpoints", "POST", {
    runtime: "claude-code",
    bridgeVersion: "test",
    adapterVersion: "fake-0.1.0",
    capabilities: ["listSessions", "liveInject"],
  });
  expect(endpointResult.response.status).toBe(201);
  const sessionResult = await api<RuntimeSessionBinding>(
    app,
    token,
    `/api/v1/endpoints/${endpointResult.body.endpointId}/sessions`,
    "POST",
    {
      label,
      state: "idle",
      deliveryMode: "managed_stream",
      capabilities: { liveInject: true, midTurnSteer: false, replyEvents: false },
      allowInbound: true,
      allowMidTurnSteer: false,
    },
  );
  expect(sessionResult.response.status).toBe(201);
  return { endpoint: endpointResult.body, session: sessionResult.body };
}

export async function activateDefaultGrant(app: ReturnType<typeof createApp>) {
  const a = await registerManagedSession(app, TOKENS.a, "A reply");
  const b = await registerManagedSession(app, TOKENS.b, "B default");
  await api(app, TOKENS.b, "/api/v1/default-route", "PUT", {
    endpointId: b.endpoint.endpointId,
    sessionHandle: b.session.sessionHandle,
  });
  const request = await api<{ id: string }>(app, TOKENS.a, "/api/v1/comm-sessions", "POST", {
    target: { kind: "person_default_runtime", principalId: "prn_b" },
    replyEndpointId: a.endpoint.endpointId,
    replySessionHandle: a.session.sessionHandle,
    requestedTtlMinutes: 30,
  });
  expect(request.response.status).toBe(201);
  const accepted = await api(app, TOKENS.b, `/api/v1/comm-sessions/${request.body.id}/accept`, "POST");
  expect(accepted.response.status).toBe(200);
  return { a, b, commSessionId: request.body.id };
}

export async function startTestServer(options: { pingMs?: number } = {}): Promise<{
  baseUrl: string;
  db: AppDatabase;
  server: Server;
  close: () => Promise<void>;
}> {
  const db = openDb(":memory:");
  const app = createApp(db, { ssePingMs: options.pingMs ?? 100 });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

export async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  if (!accept(value)) throw new Error(`Condition not met within ${timeoutMs}ms: ${JSON.stringify(value)}`);
  return value;
}
