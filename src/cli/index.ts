import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { RuntimeBridge } from "../bridge/bridge.js";
import { BridgeSpool } from "../bridge/spool.js";
import type { HumanInboxSendMessageInput, RequestCommunicationSessionInput } from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { makeTransport } from "../shared/aicoo-transport.js";
import {
  upsertRelationshipPreset,
  type RelationshipAccessPreset,
} from "../security/relationship-policy.js";
import { startServer } from "../control-plane/server.js";
import { formatDelivery } from "./format.js";

const program = new Command()
  .name("ccd")
  .description("aicoo-local-agent realtime runtime-messaging CLI")
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? "http://127.0.0.1:7790")
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
    process.env.CCD_RELATIONSHIP_POLICY,
  )
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL)
  .action(async (options) => {
    const selected = await selectRuntimeAdapter({
      kind: options.adapter as RuntimeAdapterKind,
      sessions: Number.parseInt(options.sessions, 10),
      fakeBusy: options.fakeBusy,
      spoolFile: options.spool,
      workspace: options.workspace,
      claudeStateFile: options.claudeState,
      claudePath: options.claudePath,
      codexStateFile: options.codexState,
      codexPath: options.codexPath,
      relationshipPolicyFile: options.relationshipPolicy,
      model: options.model,
      log: console.log,
    });
    const spool = new BridgeSpool(options.spool);
    const bridge = new RuntimeBridge({
      transport: makeClient(),
      spool,
      adapter: selected.adapter,
      adapterVersion: selected.adapterVersion,
      runtime: selected.runtime,
      log: console.log,
    });
    const started = await bridge.start();
    console.log(JSON.stringify({ ...started, adapter: selected.label }, null, 2));
    const shutdown = async () => {
      await bridge.stop();
      spool.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
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
    const route = resolveRoute(options);
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
    const route = resolveRoute(options);
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
connect.command("request")
  .requiredOption("--to <principalId>")
  .addOption(new Option("--kind <kind>").choices(["person_default_runtime", "runtime_session"]).default("person_default_runtime"))
  .option("--offer <offerId>")
  .option("--reply-endpoint <id>")
  .option("--reply-session <handle>")
  .option("--spool <file>")
  .option("--ttl <minutes>", "grant TTL", "30")
  .action(async (options) => {
    const route = resolveRoute({ endpoint: options.replyEndpoint, session: options.replySession, spool: options.spool });
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
    .choices(["chat-only", "read-project", "edit-project"]))
  .option("--folder <dir>", "project folder for read/edit access")
  .option("--policy <file>", "local relationship policy file", "relationships.json")
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
      folder: options.folder,
    });
    print({
      grant,
      accessPolicy: {
        status: "saved",
        preset: options.access,
        policyFile: options.policy,
        ...(options.folder ? { folder: options.folder } : {}),
        note: options.access === "chat-only"
          ? "Chat-only works with Claude Code and Codex."
          : "Claude Code enforces this tool preset; Codex safely remains chat-only.",
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

program.command("inbox").action(async () => print(await makeClient().listInboxItems()));
program.command("audit")
  .option("--comm-session <id>")
  .action(async (options) => print(await makeClient().listAudit(options.commSession)));

program.showHelpAfterError();
program.parseAsync().catch((error: unknown) => {
  if (error instanceof ApiError) {
    console.error(JSON.stringify({ status: error.status, code: error.code, body: error.body }, null, 2));
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

function makeClient(): HttpMessageTransport {
  const options = program.opts<{ server: string; token?: string }>();
  return makeTransport({ baseUrl: options.server, token: required(options.token, "--token or CCD_TOKEN") });
}

function resolveRoute(options: { endpoint?: string; session?: string; spool?: string }): {
  endpointId: string;
  sessionHandle: string;
} {
  if (options.endpoint && options.session) return { endpointId: options.endpoint, sessionHandle: options.session };
  if (!options.spool) throw new Error("provide --endpoint and --session, or --spool");
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

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
