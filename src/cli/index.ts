import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { RuntimeBridge } from "../bridge/bridge.js";
import { BridgeSpool } from "../bridge/spool.js";
import type { CommunicationGrant, CommunicationSession, HumanInboxSendMessageInput, RequestCommunicationSessionInput } from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { AicooTransport, makeTransport } from "../shared/aicoo-transport.js";
import {
  DEFAULT_RELATIONSHIP_POLICY_FILE,
  upsertRelationshipPreset,
  type RelationshipAccessPreset,
} from "../security/relationship-policy.js";
import { startServer } from "../control-plane/server.js";
import { formatDelivery } from "./format.js";

const LOCAL_SERVER_URL = "http://127.0.0.1:7790";
const PRODUCT_AICOO_SERVER_URL = "https://www.aicoo.io";
const DEFAULT_SPOOL = join(homedir(), ".aicoo", "local-agent", "bridge.spool");

const program = new Command()
  .name("ccd")
  .description("aicoo-local-agent realtime runtime-messaging CLI")
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? LOCAL_SERVER_URL)
  .option("--token <token>", "device bearer token", process.env.CCD_TOKEN);

program.command("serve")
  .option("--port <number>", "listen port", process.env.CCD_PORT ?? "7790")
  .option("--host <host>", "listen host", process.env.CCD_HOST ?? "127.0.0.1")
  .option("--db <file>", "SQLite file", process.env.CCD_DB ?? "aicoo-local-agent.db")
  .action((options) => {
    startServer({
      port: Number.parseInt(options.port, 10),
      hostname: options.host,
      dbFile: options.db,
      log: console.log,
    });
    console.log(`aicoo-local-agent mock control plane listening on http://${options.host}:${options.port}`);
  });

program.command("bridge")
  .requiredOption("--spool <file>", "durable bridge spool")
  .addOption(new Option("--adapter <adapter>", "runtime adapter").choices(["fake", "claude-code", "codex"]).default("fake"))
  .option("--sessions <count>", "managed session count", "1")
  .option("--fake-busy", "start fake session busy", false)
  .option("--workspace <dir>", "managed-session workspace", process.cwd())
  .option("--claude-state <file>", "Claude Code managed-session state database")
  .option("--claude-path <file>", "Claude Code executable", process.env.CLAUDE_CODE_PATH)
  .option("--codex-state <file>", "Codex managed-session state database")
  .option("--codex-path <file>", "codex executable", process.env.CODEX_PATH)
  .option(
    "--relationship-policy <file>",
    "JSON allowlist of tools/folders for verified users and devices",
    process.env.CCD_RELATIONSHIP_POLICY ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
  )
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL)
  .action(async (options) => {
    await startBridge(options);
  });

program.command("start")
  .description("start this machine's hosted Aicoo bridge with production-friendly defaults")
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .addOption(new Option("--adapter <adapter>", "runtime adapter").choices(["claude-code", "codex", "fake"]).default("codex"))
  .option("--sessions <count>", "managed session count", "2")
  .option("--workspace <dir>", "managed-session workspace", process.cwd())
  .option("--codex-path <file>", "codex executable", process.env.CODEX_PATH)
  .option("--claude-path <file>", "Claude Code executable", process.env.CLAUDE_CODE_PATH)
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL)
  .action(async (options) => {
    await startBridge({ ...options, hosted: true, server: hostedServerUrl() });
  });

program.command("whoami").action(async () => print(await makeClient().whoami()));

program.command("targets")
  .requiredOption("--person <principalId>")
  .action(async (options) => print(await makeClient().listReachableTargets(options.person)));

const defaultRoute = program.command("default-route");
defaultRoute.command("set")
  .option("--endpoint <id>")
  .option("--session <handle>")
  .option("--spool <file>")
  .action(async (options) => {
    const route = await resolveRoute(options);
    print(await makeClient().setDefaultRoute(route.endpointId, route.sessionHandle));
  });
defaultRoute.command("get").action(async () => print(await makeClient().getDefaultRoute()));
defaultRoute.command("clear").action(async () => {
  await makeClient().clearDefaultRoute();
  console.log("default route cleared");
});

const offer = program.command("offer");
offer.command("create")
  .requiredOption("--audience <principalId>")
  .option("--endpoint <id>")
  .option("--session <handle>")
  .option("--spool <file>")
  .option("--ttl <seconds>", "offer TTL", "600")
  .action(async (options) => {
    const route = await resolveRoute(options);
    print(await makeClient().createOffer({
      ...route,
      audiencePrincipalId: options.audience,
      ttlSeconds: Number.parseInt(options.ttl, 10),
    }));
  });
offer.command("revoke").argument("<offerId>").action(async (offerId) => {
  await makeClient().revokeOffer(offerId);
  console.log("offer revoked");
});

const connect = program.command("connect");
connect
  .argument("[person]", "principal ID to connect to")
  .option("--spool <file>", "bridge spool", DEFAULT_SPOOL)
  .option("--ttl <minutes>", "grant TTL", "30")
  .action(async (person, options) => {
    if (!person) {
      connect.help();
      return;
    }
    const route = await resolveRoute({ spool: options.spool });
    const session = await requestConnection(person, route, Number.parseInt(options.ttl, 10));
    console.log(`Connection request sent to ${person}. They can accept in Aicoo, or run: ccd accept`);
    console.log(`requestId: ${session.id}`);
  });
connect.command("request")
  .requiredOption("--to <principalId>")
  .addOption(new Option("--kind <kind>").choices(["person_default_runtime", "runtime_session"]).default("person_default_runtime"))
  .option("--offer <offerId>")
  .option("--reply-endpoint <id>")
  .option("--reply-session <handle>")
  .option("--spool <file>")
  .option("--ttl <minutes>", "grant TTL", "30")
  .action(async (options) => {
    const route = await resolveRoute({ endpoint: options.replyEndpoint, session: options.replySession, spool: options.spool });
    const target = options.kind === "runtime_session"
      ? { kind: "runtime_session" as const, principalId: options.to, targetOfferId: required(options.offer, "--offer") }
      : { kind: "person_default_runtime" as const, principalId: options.to };
    const input: RequestCommunicationSessionInput = {
      target,
      replyEndpointId: route.endpointId,
      replySessionHandle: route.sessionHandle,
      requestedTtlMinutes: Number.parseInt(options.ttl, 10),
    };
    print(await makeClient().requestCommunicationSession(input));
  });
connect.command("list").action(async () => print(await makeClient().listCommunicationSessions()));
connect.command("accept")
  .argument("<sessionId>")
  .addOption(new Option("--access <preset>", "relationship access preset")
    .choices(["chat-only"]))
  .option(
    "--policy <file>",
    "local relationship policy file",
    process.env.CCD_RELATIONSHIP_POLICY ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
  )
  .action(async (sessionId, options) => {
    const grant = await makeClient().acceptCommunicationSession(sessionId);
    if (!options.access) {
      print(grant);
      return;
    }
    const deviceId = grant.requester.deviceId;
    if (!deviceId) {
      print({
        grant,
        accessPolicy: {
          status: "not_applied",
          reason: "The server did not return the requester's verified device ID; access remains chat-only.",
        },
      });
      return;
    }
    upsertRelationshipPreset({
      file: options.policy,
      principalId: grant.requester.principalId,
      deviceId,
      preset: options.access as RelationshipAccessPreset,
    });
    print({
      grant,
      accessPolicy: {
        status: "saved",
        preset: options.access,
        policyFile: options.policy,
        note: "Claude Code and Codex remain text-only until per-relationship OS sandboxing is available.",
      },
    });
  });
connect.command("decline").argument("<sessionId>").action(async (sessionId) => {
  await makeClient().declineCommunicationSession(sessionId);
  console.log("communication session declined");
});
connect.command("revoke").argument("<sessionId>").action(async (sessionId) => {
  await makeClient().revokeCommunicationSession(sessionId);
  console.log("communication session revoked");
});

program.command("accept")
  .description("accept the latest pending c2c request")
  .argument("[sessionId]")
  .addOption(new Option("--access <preset>", "relationship access preset").choices(["chat-only"]).default("chat-only"))
  .option(
    "--policy <file>",
    "local relationship policy file",
    process.env.CCD_RELATIONSHIP_POLICY ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
  )
  .action(async (sessionId, options) => {
    const id = sessionId ?? (await latestPendingSessionId());
    const result = await acceptConnection(id, options.access as RelationshipAccessPreset, options.policy);
    console.log(`Accepted connection ${result.grant.id} from ${result.grant.requester.principalId}.`);
    if (result.accessPolicy.status !== "saved") {
      console.log(result.accessPolicy.reason);
    }
  });

program.command("send")
  .requiredOption("--comm-session <id>")
  .requiredOption("--text <message>")
  .option("--client-id <id>")
  .action(async (options) => print(await makeClient().sendMessage({
    communicationSessionId: options.commSession,
    clientMessageId: options.clientId ?? randomUUID(),
    kind: "text",
    payload: { text: options.text },
  })));

program.command("send-to")
  .description("send a text message to an active c2c relationship")
  .argument("<person>", "peer principal ID")
  .argument("<message...>", "message text")
  .option("--client-id <id>")
  .option("--no-watch", "do not wait for runtime acknowledgement")
  .action(async (person, messageParts, options) => {
    const session = await activeSessionForPeer(person);
    const client = makeHostedClient();
    const receipt = await client.sendMessage({
      communicationSessionId: session.id,
      clientMessageId: options.clientId ?? randomUUID(),
      kind: "text",
      payload: { text: messageParts.join(" ") },
    });
    console.log(`Sent to ${person}.`);
    print(receipt);
    if (options.watch) {
      console.log("");
      await watchDelivery(client, receipt.messageId);
    }
  });

program.command("send-inbox")
  .requiredOption("--to <principalId>")
  .requiredOption("--text <message>")
  .option("--client-id <id>")
  .action(async (options) => {
    const input: HumanInboxSendMessageInput = {
      target: { kind: "human_inbox", principalId: options.to },
      clientMessageId: options.clientId ?? randomUUID(),
      kind: "text",
      payload: { text: options.text },
    };
    print(await makeClient().sendMessage(input));
    console.log("cloud inbox only — NOT delivered to any local runtime");
  });

program.command("status")
  .argument("<messageId>")
  .option("--watch", "poll until a terminal/runtime state", false)
  .action(async (messageId, options) => {
    const client = makeClient();
    do {
      const status = await client.getMessageStatus(messageId);
      console.log(formatDelivery(status));
      if (!options.watch || ["runtime_acked", "inbox_persisted", "failed", "expired", "revoked", "rejected"].includes(status.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
      console.log("");
    } while (true);
  });

program.command("watch")
  .description("watch hosted Aicoo delivery status for a message")
  .argument("<messageId>")
  .action(async (messageId) => {
    await watchDelivery(makeHostedClient(), messageId);
  });

program.command("inbox").action(async () => print(await makeClient().listInboxItems()));
program.command("audit")
  .option("--comm-session <id>")
  .action(async (options) => print(await makeClient().listAudit(options.commSession)));

program.command("doctor")
  .description("check whether this machine is ready for text-only c2c")
  .option("--spool <file>", "bridge spool to inspect")
  .action(async (options) => {
    const client = makeClient();
    const checks: Array<{ name: string; ok: boolean; detail?: unknown; next?: string }> = [];

    try {
      checks.push({ name: "identity", ok: true, detail: await client.whoami() });
    } catch (error) {
      checks.push({
        name: "identity",
        ok: false,
        detail: errorMessage(error),
        next: "Check --server and --token / CCD_TOKEN.",
      });
    }

    try {
      checks.push({ name: "defaultRoute", ok: true, detail: await client.getDefaultRoute() });
    } catch (error) {
      checks.push({
        name: "defaultRoute",
        ok: false,
        detail: errorMessage(error),
        next: "Start the bridge and wait for the '[bridge] default route -> ...' log.",
      });
    }

    if (options.spool) {
      try {
        const spool = new BridgeSpool(options.spool);
        try {
          const endpointId = spool.getIdentity("endpointId");
          const sessions = spool.listSessionMappings();
          checks.push({
            name: "localSpool",
            ok: Boolean(endpointId && sessions.length > 0),
            detail: { endpointId, sessions },
            ...(endpointId && sessions.length > 0 ? {} : { next: "Start the bridge with this spool file." }),
          });
        } finally {
          spool.close();
        }
      } catch (error) {
        checks.push({ name: "localSpool", ok: false, detail: errorMessage(error) });
      }
    }

    print({
      ok: checks.every((check) => check.ok),
      mode: "text-only",
      checks,
    });
  });

program.showHelpAfterError();
program.parseAsync().catch((error: unknown) => {
  if (error instanceof ApiError) {
    console.error(JSON.stringify({ status: error.status, code: error.code, body: error.body }, null, 2));
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

async function startBridge(options: {
  adapter: RuntimeAdapterKind;
  sessions: string;
  fakeBusy?: boolean;
  spool: string;
  workspace?: string;
  claudeState?: string;
  claudePath?: string;
  codexState?: string;
  codexPath?: string;
  relationshipPolicy?: string;
  model?: string;
  hosted?: boolean;
  server?: string;
}): Promise<void> {
  ensureParentDirectory(options.spool);
  const selected = await selectRuntimeAdapter({
    kind: options.adapter,
    sessions: Number.parseInt(options.sessions, 10),
    fakeBusy: options.fakeBusy ?? false,
    spoolFile: options.spool,
    workspace: options.workspace ?? process.cwd(),
    claudeStateFile: options.claudeState,
    claudePath: options.claudePath,
    codexStateFile: options.codexState,
    codexPath: options.codexPath,
    relationshipPolicyFile: options.relationshipPolicy ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
    model: options.model,
    log: console.log,
  });
  const deviceId = resolveDeviceId(undefined, options.spool);
  const spool = new BridgeSpool(options.spool);
  const bridge = new RuntimeBridge({
    transport: makeClient({ hosted: options.hosted, server: options.server, deviceId }),
    spool,
    adapter: selected.adapter,
    adapterVersion: selected.adapterVersion,
    runtime: selected.runtime,
    log: console.log,
  });
  const started = await bridge.start();
  console.log(JSON.stringify({
    status: "ready",
    mode: "text-only",
    adapter: selected.label,
    ...started,
    next: "Share principalId with the other person, then they can run: ccd connect <principalId>",
  }, null, 2));
  const shutdown = async () => {
    await bridge.stop();
    spool.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function makeClient(options: { hosted?: boolean; server?: string; deviceId?: string } = {}): HttpMessageTransport {
  const programOptions = program.opts<{ server: string; token?: string }>();
  const server = options.server ?? programOptions.server;
  const token = required(programOptions.token, "--token or CCD_TOKEN");
  if (options.hosted || process.env.CCD_AICOO === "1") {
    return new AicooTransport({ baseUrl: server, token, deviceId: options.deviceId });
  }
  return makeTransport({ baseUrl: server, token, deviceId: options.deviceId });
}

function makeHostedClient(): HttpMessageTransport {
  return makeClient({ hosted: true, server: hostedServerUrl() });
}

function hostedServerUrl(): string {
  if (process.env.CCD_SERVER_URL) return process.env.CCD_SERVER_URL;
  const options = program.opts<{ server: string }>();
  return options.server === LOCAL_SERVER_URL ? PRODUCT_AICOO_SERVER_URL : options.server;
}

async function resolveRoute(options: { endpoint?: string; session?: string; spool?: string }): Promise<{
  endpointId: string;
  sessionHandle: string;
}> {
  if (options.endpoint && options.session) return { endpointId: options.endpoint, sessionHandle: options.session };
  if (!options.spool) {
    try {
      return await makeClient().getDefaultRoute();
    } catch (error) {
      throw new Error(
        `No local route found. Start the bridge first, pass --spool, or pass --reply-endpoint and --reply-session. ${errorMessage(error)}`,
      );
    }
  }
  const spool = new BridgeSpool(options.spool);
  try {
    const endpointId = spool.getIdentity("endpointId");
    const mapping = spool.listSessionMappings()[0];
    if (!endpointId || !mapping) throw new Error("spool does not contain a registered endpoint/session");
    return { endpointId, sessionHandle: mapping.serverHandle };
  } finally {
    spool.close();
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

async function requestConnection(
  principalId: string,
  route: { endpointId: string; sessionHandle: string },
  ttlMinutes: number,
): Promise<CommunicationSession> {
  return makeHostedClient().requestCommunicationSession({
    target: { kind: "person_default_runtime", principalId },
    replyEndpointId: route.endpointId,
    replySessionHandle: route.sessionHandle,
    requestedTtlMinutes: ttlMinutes,
  });
}

async function latestPendingSessionId(): Promise<string> {
  const pending = (await makeHostedClient().listCommunicationSessions())
    .filter((session) => session.status === "pending")
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  const latest = pending[0];
  if (!latest) throw new Error("No pending connection request found.");
  return latest.id;
}

async function acceptConnection(
  sessionId: string,
  access: RelationshipAccessPreset,
  policyFile: string,
): Promise<{
  grant: CommunicationGrant;
  accessPolicy: { status: "saved"; preset: RelationshipAccessPreset; policyFile: string } | { status: "not_applied"; reason: string };
}> {
  const grant = await makeHostedClient().acceptCommunicationSession(sessionId);
  const deviceId = grant.requester.deviceId;
  if (!deviceId) {
    return {
      grant,
      accessPolicy: {
        status: "not_applied",
        reason: "The server did not return the requester's verified device ID; access remains chat-only.",
      },
    };
  }
  upsertRelationshipPreset({
    file: policyFile,
    principalId: grant.requester.principalId,
    deviceId,
    preset: access,
  });
  return { grant, accessPolicy: { status: "saved", preset: access, policyFile } };
}

async function activeSessionForPeer(peerPrincipalId: string): Promise<CommunicationSession> {
  const active = (await makeHostedClient().listCommunicationSessions())
    .filter((session) =>
      session.status === "active"
      && (session.requester.principalId === peerPrincipalId || session.recipient.principalId === peerPrincipalId))
    .sort((a, b) => Date.parse(b.activatedAt ?? b.requestedAt) - Date.parse(a.activatedAt ?? a.requestedAt));
  const session = active[0];
  if (!session) throw new Error(`No active connection found for ${peerPrincipalId}. Run ccd connect ${peerPrincipalId} first.`);
  return session;
}

function resolveDeviceId(explicit: string | undefined, spoolFile: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const idFile = `${spoolFile}.device-id`;
  try {
    if (existsSync(idFile)) {
      const saved = readFileSync(idFile, "utf8").trim();
      if (saved) return saved;
    }
  } catch {
    /* unreadable — fall through and regenerate */
  }
  const generated = `${hostname()}-${randomUUID()}`;
  ensureParentDirectory(idFile);
  try {
    writeFileSync(idFile, generated);
  } catch {
    /* non-fatal: id is still used for this run */
  }
  return generated;
}

function ensureParentDirectory(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function watchDelivery(client: HttpMessageTransport, messageId: string): Promise<void> {
  do {
    const status = await client.getMessageStatus(messageId);
    console.log(formatDelivery(status));
    if (["runtime_acked", "inbox_persisted", "failed", "expired", "revoked", "rejected"].includes(status.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log("");
  } while (true);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}`;
  return error instanceof Error ? error.message : String(error);
}
