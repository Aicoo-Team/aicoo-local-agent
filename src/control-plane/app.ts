import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ServiceResult } from "../shared/contracts.js";
import { listAudit } from "./audit.js";
import { resolveBearer, type AuthContext } from "./auth.js";
import type { AppDatabase } from "./db.js";
import { EventStore } from "./events.js";
import { CommunicationSessionService } from "./services/comm-sessions.js";
import { DelegationService } from "./services/delegations.js";
import { EndpointService } from "./services/endpoints.js";
import { MessageService } from "./services/messages.js";
import { OfferService } from "./services/offers.js";

type Variables = { auth: AuthContext };

export interface AppConfig {
  ssePingMs?: number;
  log?: (line: string) => void;
}

const endpointSchema = z.object({
  runtime: z.enum(["claude-code", "codex"]),
  bridgeVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  capabilities: z.array(z.string()),
});

const capabilitiesSchema = z.object({
  liveInject: z.boolean(),
  midTurnSteer: z.boolean(),
  replyEvents: z.boolean(),
});

const sessionSchema = z.object({
  label: z.string().min(1).max(200),
  state: z.enum(["idle", "busy"]),
  deliveryMode: z.literal("managed_stream"),
  capabilities: capabilitiesSchema,
  allowInbound: z.boolean(),
  allowMidTurnSteer: z.boolean(),
});

const requestCommSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("person_default_runtime"), principalId: z.string().min(1) }),
    z.object({
      kind: z.literal("runtime_session"),
      principalId: z.string().min(1),
      targetOfferId: z.string().min(1),
    }),
  ]),
  replyEndpointId: z.string().min(1),
  replySessionHandle: z.string().min(1),
  requestedTtlMinutes: z.number().int().positive().max(30).optional(),
});

const messageBase = {
  clientMessageId: z.string().min(1).max(200),
  kind: z.enum(["text", "task_invite", "resource_request"]),
  payload: z.record(z.string(), z.unknown()),
  replyTo: z.string().optional(),
  correlationId: z.string().optional(),
};

const sendMessageSchema = z.union([
  z.object({ communicationSessionId: z.string().min(1), ...messageBase }),
  z.object({
    target: z.object({ kind: z.literal("human_inbox"), principalId: z.string().min(1) }),
    ...messageBase,
  }),
]);

const delegationSchema = z.object({
  target: requestCommSchema.shape.target,
  task: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  sessionHandle: z.string().min(1),
  clientMessageId: z.string().min(1).max(200),
  correlationId: z.string().min(1).optional(),
  requestedTtlMinutes: z.number().int().positive().max(30).optional(),
});

export function createApp(db: AppDatabase, config: AppConfig = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const events = new EventStore(db);
  const endpoints = new EndpointService(db);
  const offers = new OfferService(db, endpoints);
  const comms = new CommunicationSessionService(db, endpoints, offers, events);
  const messages = new MessageService(db, comms, endpoints, events);
  const delegations = new DelegationService(db, comms, endpoints, messages);

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/api/v1/*", async (c, next) => {
    const auth = resolveBearer(db, c.req.header("authorization"));
    if (!auth) return c.json({ error: { code: "unauthorized" } }, 401);
    c.set("auth", auth);
    config.log?.(`${c.req.method} ${c.req.path} principal=${auth.principalId}`);
    await next();
  });

  app.get("/api/v1/whoami", (c) => c.json(c.get("auth")));

  app.post("/api/v1/endpoints", async (c) => {
    const parsed = endpointSchema.safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return c.json(endpoints.register(c.get("auth"), parsed.data), 201);
  });

  app.post("/api/v1/endpoints/:id/heartbeat", (c) =>
    respond(c, endpoints.heartbeat(c.get("auth"), c.req.param("id")), 204));

  app.post("/api/v1/endpoints/:id/sessions", async (c) => {
    const parsed = sessionSchema.safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, endpoints.registerSession(c.get("auth"), c.req.param("id"), parsed.data), 201);
  });

  app.patch("/api/v1/endpoints/:id/sessions/:handle", async (c) => {
    const parsed = z.object({
      state: z.enum(["idle", "busy", "closed"]).optional(),
      allowInbound: z.boolean().optional(),
      allowMidTurnSteer: z.boolean().optional(),
    }).safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(
      c,
      endpoints.updateSession(c.get("auth"), c.req.param("id"), c.req.param("handle"), parsed.data),
    );
  });

  app.delete("/api/v1/endpoints/:id/sessions/:handle", (c) =>
    respond(c, endpoints.closeSession(c.get("auth"), c.req.param("id"), c.req.param("handle")), 204));

  app.put("/api/v1/default-route", async (c) => {
    const parsed = z.object({ endpointId: z.string(), sessionHandle: z.string() }).safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, endpoints.setDefaultRoute(c.get("auth"), parsed.data.endpointId, parsed.data.sessionHandle));
  });

  app.get("/api/v1/default-route", (c) => {
    const route = endpoints.getDefaultRoute(c.get("auth").principalId);
    return route ? c.json(route) : c.json({ error: { code: "no_default_route" } }, 404);
  });

  app.delete("/api/v1/default-route", (c) => respond(c, endpoints.clearDefaultRoute(c.get("auth")), 204));

  app.post("/api/v1/target-offers", async (c) => {
    const parsed = z.object({
      endpointId: z.string(),
      sessionHandle: z.string(),
      audiencePrincipalId: z.string(),
      ttlSeconds: z.number().int().positive().max(3600).optional(),
    }).safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, offers.create(c.get("auth"), parsed.data), 201);
  });

  app.post("/api/v1/target-offers/:id/revoke", (c) =>
    respond(c, offers.revoke(c.get("auth"), c.req.param("id")), 204));

  app.get("/api/v1/targets", (c) => {
    const personId = c.req.query("personId");
    if (!personId) return c.json({ error: { code: "invalid_request" } }, 400);
    return c.json(offers.listReachable(c.get("auth").principalId, personId));
  });

  app.post("/api/v1/comm-sessions", async (c) => {
    const parsed = requestCommSchema.safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, comms.request(c.get("auth"), parsed.data), 201);
  });

  app.get("/api/v1/comm-sessions", (c) => c.json(comms.list(c.get("auth").principalId)));
  app.get("/api/v1/comm-sessions/:id", (c) =>
    respond(c, comms.getVisible(c.get("auth").principalId, c.req.param("id"))));
  app.post("/api/v1/comm-sessions/:id/accept", (c) =>
    respond(c, comms.accept(c.get("auth"), c.req.param("id"))));
  app.post("/api/v1/comm-sessions/:id/decline", (c) =>
    respond(c, comms.decline(c.get("auth"), c.req.param("id")), 204));
  app.post("/api/v1/comm-sessions/:id/revoke", (c) =>
    respond(c, comms.revoke(c.get("auth"), c.req.param("id")), 204));

  app.post("/api/v1/messages", async (c) => {
    const raw = await safeJson(c);
    if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "control") {
      return c.json({ error: { code: "invalid_message_kind" } }, 403);
    }
    const parsed = sendMessageSchema.safeParse(raw);
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, messages.send(c.get("auth"), parsed.data), 201);
  });

  app.post("/api/v1/local-agent/delegations", async (c) => {
    const parsed = delegationSchema.safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    const result = delegations.delegate(c.get("auth"), parsed.data);
    const status = result.ok && result.value.status === "delegated" ? 201 : 200;
    return respond(c, result, status);
  });

  app.get("/api/v1/messages/:id/status", (c) =>
    respond(c, messages.getStatus(c.get("auth").principalId, c.req.param("id"))));

  app.post("/api/v1/messages/:id/ack", async (c) => {
    const parsed = z.object({
      phase: z.enum(["device_ack", "runtime_pending", "runtime_ack", "runtime_failed"]),
      attemptId: z.string().min(1),
      resultCode: z.string().optional(),
      retryable: z.boolean().optional(),
      runtimeAckId: z.string().optional(),
    }).safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return respond(c, messages.acknowledge(c.get("auth"), c.req.param("id"), parsed.data));
  });

  app.post("/api/v1/injections/validate", async (c) => {
    const parsed = z.object({
      messageId: z.string(),
      communicationSessionId: z.string(),
      endpointId: z.string(),
      sessionHandle: z.string().optional(),
    }).safeParse(await safeJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    return c.json(messages.validateInjection(c.get("auth"), parsed.data));
  });

  app.get("/api/v1/inbox", (c) => c.json(messages.listInbox(c.get("auth").principalId)));

  app.get("/api/v1/audit", (c) => {
    const commSessionId = c.req.query("commSessionId");
    return c.json(
      listAudit(
        db,
        c.get("auth").principalId,
        commSessionId ? "communication_session" : undefined,
        commSessionId,
      ),
    );
  });

  app.get("/api/v1/events/poll", (c) => {
    const endpointId = c.req.query("endpointId");
    const owned = endpointId ? endpoints.getOwned(c.get("auth"), endpointId) : undefined;
    if (!endpointId || !owned?.ok) return c.json({ error: { code: "endpoint_not_owned" } }, 403);
    const result = events.list(endpointId, c.req.query("cursor") ?? "0");
    for (const event of result) markDispatch(event);
    return c.json(result);
  });

  app.get("/api/v1/events", (c) => {
    const endpointId = c.req.query("endpointId");
    const owned = endpointId ? endpoints.getOwned(c.get("auth"), endpointId) : undefined;
    if (!endpointId || !owned?.ok) return c.json({ error: { code: "endpoint_not_owned" } }, 403);
    const startingCursor = normalizeCursor(c.req.query("cursor"));
    return streamSSE(c, async (stream) => {
      let lastCursor = startingCursor;
      let pendingWake = true;
      let aborted = false;
      let resolveWake: (() => void) | undefined;
      stream.onAbort(() => {
        aborted = true;
        resolveWake?.();
      });
      const unsubscribe = events.subscribe(endpointId, () => {
        pendingWake = true;
        resolveWake?.();
      });
      try {
        while (!aborted && !stream.closed) {
          if (pendingWake) {
            pendingWake = false;
            const batch = events.list(endpointId, String(lastCursor));
            for (const event of batch) {
              if (aborted || stream.closed) break;
              if (Number(event.cursor) <= lastCursor) continue;
              await stream.writeSSE({ id: event.cursor, event: event.type, data: JSON.stringify(event) });
              if (aborted || stream.closed) break;
              lastCursor = Number(event.cursor);
              markDispatch(event);
            }
            if (batch.length > 0) continue;
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              resolveWake = resolve;
              if (pendingWake) resolve();
            }),
            stream.sleep(config.ssePingMs ?? 15_000).then(async () => {
              if (!aborted && !stream.closed) await stream.write(":ping\n\n");
            }),
          ]);
          resolveWake = undefined;
        }
      } catch {
        // Disconnects are expected; durable replay starts after the caller's persisted cursor.
      } finally {
        unsubscribe();
      }
    });
  });

  app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));

  function markDispatch(event: { type: string; data: Record<string, unknown> }): void {
    if (event.type !== "message.dispatch") return;
    const envelope = event.data.envelope as { id?: string } | undefined;
    if (envelope?.id) messages.markDispatched(envelope.id);
  }

  return app;
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function normalizeCursor(value: string | undefined): number {
  const cursor = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

function invalid(c: { json: (body: unknown, status: ContentfulStatusCode) => Response }, error: z.ZodError) {
  return c.json({ error: { code: "invalid_request", issues: error.issues } }, 400);
}

function respond<T>(
  c: { json: (body: unknown, status?: ContentfulStatusCode) => Response; body: (body: null, status: 204) => Response },
  result: ServiceResult<T>,
  successStatus: ContentfulStatusCode | 204 = 200,
): Response {
  if (!result.ok) {
    return c.json({ error: { code: result.code, message: result.message } }, result.httpStatus as ContentfulStatusCode);
  }
  if (successStatus === 204) return c.body(null, 204);
  return c.json(result.value, successStatus);
}
