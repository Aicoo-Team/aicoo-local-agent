import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { requestRuntimeDelegation, RuntimeBridge } from "../bridge/bridge.js";
import { startLocalHelper } from "../bridge/local-helper.js";
import { BridgeSpool } from "../bridge/spool.js";
import type {
  CommunicationGrant,
  CommunicationSession,
  HumanInboxSendMessageInput,
  LocalAgentDelegationResponse,
  MessageEnvelope,
  RequestCommunicationSessionInput,
  RuntimeEvent,
} from "../shared/contracts.js";
import { ApiError, HttpMessageTransport } from "../shared/http-client.js";
import { AicooTransport, makeTransport } from "../shared/aicoo-transport.js";
import {
  DEFAULT_RELATIONSHIP_POLICY_FILE,
  upsertRelationshipPreset,
  type RelationshipAccessPreset,
} from "../security/relationship-policy.js";
import { startServer } from "../control-plane/server.js";
import { formatDelivery } from "./format.js";
import { ensureCodexSkill, installCodexSkill } from "./skill-install.js";

const LOCAL_SERVER_URL = "http://127.0.0.1:7790";
const PRODUCT_AICOO_SERVER_URL = "https://www.aicoo.io";
const DEFAULT_SPOOL = join(homedir(), ".aicoo", "local-agent", "bridge.spool");
const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".aicoo", "credentials.json");

const program = new Command()
  .name("ccd")
  .description("aicoo-local-agent realtime runtime-messaging CLI")
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? LOCAL_SERVER_URL)
  .option("--token <token>", "device bearer token", process.env.CCD_TOKEN);

program.command("login")
  .description("log in this machine via Aicoo device-code pairing flow")
  .addOption(new Option("--runtime <adapter>", "runtime adapter").choices(["claude-code", "codex"]).default("codex"))
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (options) => {
    const server = hostedServerUrl(options.server);
    const deviceId = resolveDeviceId(undefined, options.spool);
    const unauthClient = new AicooTransport({ baseUrl: server, token: "anonymous", deviceId });

    console.log("Initiating device pairing with Aicoo...");
    const start = await unauthClient.startDeviceCode({
      deviceId,
      runtime: options.runtime,
      bridgeVersion: "0.1.0",
      adapterVersion: "0.1.0",
      capabilities: ["comm:c2c", "runtime:adapter"],
      label: `${hostname()} (${options.runtime})`,
    });

    const rawUrl = start.approvalUrl ?? "";
    const approvalUrl = (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) && !rawUrl.includes("undefined")
      ? rawUrl
      : `${server}/local-agent/device-code?code=${encodeURIComponent(start.userCode)}`;

    console.log("\n========================================================");
    console.log("  To approve this device, open your browser and visit:");
    console.log(`  ${approvalUrl}`);
    console.log(`\n  User Code: ${start.userCode}`);
    console.log("========================================================\n");
    console.log("Waiting for approval in browser...");

    const pollIntervalMs = 2000;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      try {
        const poll = await unauthClient.pollDeviceCode(start.pollToken);
        if (poll.status === "approved") {
          const userId = "userId" in poll ? (poll as { userId?: string }).userId : undefined;
          saveSavedCredentials({ token: poll.deviceToken, userId, deviceId }, options.spool);
          const credentialsFile = getCredentialsFile(options.spool);
          console.log(`\nSuccessfully authenticated device ${deviceId}!`);
          console.log(`Credentials saved to ${credentialsFile}`);
          return;
        }
        if (poll.status === "denied") {
          console.error("\nDevice login was denied by user.");
          process.exitCode = 1;
          return;
        }
        if (poll.status === "expired") {
          console.error("\nDevice login code expired. Please run 'ccd login' again.");
          process.exitCode = 1;
          return;
        }
        if (poll.status === "consumed") {
          console.error("\nDevice login code was already used. Please run 'ccd login' again.");
          process.exitCode = 1;
          return;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 400 && error.code === "pending") {
          continue;
        }
        throw error;
      }
    }
  });

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
  .option("--local-helper-port <port>", "localhost folder/file picker helper port", process.env.CCD_LOCAL_HELPER_PORT ?? "43177")
  .option("--local-helper-host <host>", "localhost folder/file picker helper host", process.env.CCD_LOCAL_HELPER_HOST ?? "127.0.0.1")
  .option("--no-local-helper", "disable the localhost folder/file picker helper")
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
  .option("--local-helper-port <port>", "localhost folder/file picker helper port", process.env.CCD_LOCAL_HELPER_PORT ?? "43177")
  .option("--local-helper-host <host>", "localhost folder/file picker helper host", process.env.CCD_LOCAL_HELPER_HOST ?? "127.0.0.1")
  .option("--no-local-helper", "disable the localhost folder/file picker helper")
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL)
  .option("--json", "output raw JSON status blob", false)
  .action(async (options) => {
    await startBridge({ ...options, hosted: true, server: hostedServerUrl(options.server) });
  });

program.command("whoami")
  .option("--spool <file>", "credentials spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (options) => print(await makeHostedClient(options.server, options.spool).whoami()));

program.command("targets")
  .requiredOption("--person <principalId>")
  .action(async (options) => print(await makeClient().listReachableTargets(options.person)));

const defaultRoute = program.command("default-route");
defaultRoute.command("set")
  .option("--endpoint <id>")
  .option("--session <handle>")
  .option("--spool <file>")
  .option("--server <url>", "control-plane URL")
  .action(async (options) => {
    const route = await resolveRoute(options);
    print(await makeHostedClient(options.server, options.spool).setDefaultRoute(route.endpointId, route.sessionHandle));
  });
defaultRoute.command("get")
  .option("--spool <file>", "credentials spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (options) => print(await makeHostedClient(options.server, options.spool).getDefaultRoute()));
defaultRoute.command("clear")
  .option("--spool <file>", "credentials spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (options) => {
    await makeHostedClient(options.server, options.spool).clearDefaultRoute();
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
  .argument("[person]", "principal ID or @handle to connect to")
  .option("--spool <file>", "bridge spool", DEFAULT_SPOOL)
  .option("--ttl <minutes>", "grant TTL", "30")
  .option("--server <url>", "control-plane URL")
  .action(async (person, options) => {
    if (!person) {
      connect.help();
      return;
    }
    const client = makeHostedClient(options.server, options.spool);
    let targetPrincipalId = person;
    if (person.startsWith("@") || !isUuid(person)) {
      try {
        const resolved = await client.resolvePerson(person);
        targetPrincipalId = resolved.principalId;
        console.log(`Resolved ${person} -> ${resolved.principalId} (${resolved.name ?? resolved.displayName ?? resolved.handle ?? "user"})`);
      } catch (error) {
        console.error(`Could not resolve person '${person}': ${errorMessage(error)}`);
        process.exitCode = 1;
        return;
      }
    }

    try {
      const pairStatus = await client.getPairStatus(targetPrincipalId);
      if (
        (pairStatus.status === "ready" && pairStatus.targetReachable === false)
        || (pairStatus.status !== "ready" && pairStatus.status !== "setup_bridge")
      ) {
        console.error(`\nCannot connect: ${pairStatus.message}`);
        if (pairStatus.status === "request_pair") {
          console.error("Ask them to open your DM in Aicoo and click Collaborate to pair your accounts first.");
        } else if (pairStatus.status === "awaiting_their_accept") {
          console.error("Your pair request is waiting for the other person to accept in Aicoo.");
        } else if (pairStatus.status === "accept_incoming") {
          console.error("Open Aicoo and accept their Collaborate request first.");
        } else if (pairStatus.status === "ready" && pairStatus.targetReachable === false) {
          console.error("Ask them to start their local agent bridge, then retry.");
        }
        process.exitCode = 1;
        return;
      }
    } catch {
      /* non-fatal fallback if pair-status check fails */
    }

    const route = await resolveRoute({ spool: options.spool });
    const session = await requestConnection(targetPrincipalId, route, Number.parseInt(options.ttl, 10), options.server, options.spool);
    console.log(`Connection request sent to ${person} (${targetPrincipalId}). They can accept in Aicoo, or run: ccd accept`);
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
    .choices(["chat-only", "read-project", "edit-project"]))
  .option("--folder <dir>", "folder to grant for read-project/edit-project")
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
      folder: options.folder,
    });
    print({
      grant,
      accessPolicy: {
        status: "saved",
        preset: options.access,
        ...(options.folder ? { folder: options.folder } : {}),
        policyFile: options.policy,
        note: "Aicoo relays between local runtimes. Claude Code enforces this policy per tool call; Codex uses the local bridge broker for allowed file operations.",
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
  .addOption(new Option("--access <preset>", "relationship access preset").choices(["chat-only", "read-project", "edit-project"]).default("chat-only"))
  .option("--folder <dir>", "folder to grant for read-project/edit-project")
  .option(
    "--policy <file>",
    "local relationship policy file",
    process.env.CCD_RELATIONSHIP_POLICY ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
  )
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (sessionId, options) => {
    const id = sessionId ?? (await latestPendingSessionId(options.server, options.spool));
    const result = await acceptConnection(id, options.access as RelationshipAccessPreset, options.policy, options.folder, options.server, options.spool);
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
  .argument("<person>", "peer principal ID or @handle")
  .argument("<message...>", "message text")
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--client-id <id>")
  .option("--no-watch", "do not wait for runtime acknowledgement")
  .option("--server <url>", "control-plane URL")
  .action(async (person, messageParts, options) => {
    const client = makeHostedClient(options.server, options.spool);
    let targetPrincipalId = person;
    if (person.startsWith("@") || !isUuid(person)) {
      try {
        const resolved = await client.resolvePerson(person);
        targetPrincipalId = resolved.principalId;
      } catch (error) {
        console.error(`Could not resolve person '${person}': ${errorMessage(error)}`);
        process.exitCode = 1;
        return;
      }
    }
    const session = await activeSessionForPeer(targetPrincipalId, options.server, options.spool);
    const receipt = await client.sendMessage({
      communicationSessionId: session.id,
      clientMessageId: options.clientId ?? randomUUID(),
      kind: "text",
      payload: { text: messageParts.join(" ") },
    });
    console.log(`Sent to ${person} (${targetPrincipalId}).`);
    print(receipt);
    if (options.watch) {
      console.log("");
      await watchDelivery(client, receipt.messageId);
    }
  });

program.command("delegate")
  .description("ask a peer's local Codex/Claude to do a task through Aicoo relay")
  .argument("<person>", "peer principal ID or @handle")
  .argument("<task...>", "task for the peer local agent")
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--client-id <id>", "stable id for retrying this delegation")
  .option("--correlation-id <id>", "stable id used to correlate the peer reply")
  .option("--ttl <minutes>", "grant TTL", "30")
  .option("--timeout <seconds>", "local pending-delegation timeout", "1800")
  .option("--wait", "wait for the peer local agent reply and print it", false)
  .option("--reply-timeout <seconds>", "how long --wait should wait for the peer reply", "180")
  .option("--server <url>", "control-plane URL")
  .action(async (person, taskParts, options) => {
    const client = makeHostedClient(options.server, options.spool);
    let targetPrincipalId = person;
    if (person.startsWith("@") || !isUuid(person)) {
      try {
        const resolved = await client.resolvePerson(person);
        targetPrincipalId = resolved.principalId;
      } catch (error) {
        console.error(`Could not resolve person '${person}': ${errorMessage(error)}`);
        process.exitCode = 1;
        return;
      }
    }

    const route = await resolveRoute({ spool: options.spool });
    const clientMessageId = options.clientId ?? `delegate:${randomUUID()}`;
    const correlationId = options.correlationId ?? clientMessageId;
    const spool = new BridgeSpool(options.spool);
    try {
      const result = await requestRuntimeDelegation({
        transport: client,
        spool,
        target: { kind: "person_default_runtime", principalId: targetPrincipalId },
        task: taskParts.join(" "),
        sessionHandle: route.sessionHandle,
        clientMessageId,
        correlationId,
        requestedTtlMinutes: Number.parseInt(options.ttl, 10),
        timeoutMs: Number.parseInt(options.timeout, 10) * 1000,
      });
      if (result.status === "delegated") {
        const messageId = delegationMessageId(result);
        if (!options.wait) {
          console.log(`Delegated to ${person}'s local agent.`);
          console.log(`messageId: ${messageId}`);
        } else {
          console.log(`Delegated to ${person}'s local agent. Waiting for their reply...`);
          const reply = await waitForDelegationReply({
            client,
            spoolFile: options.spool,
            correlationId: result.correlationId ?? correlationId,
            sentMessageId: messageId,
            timeoutMs: Number.parseInt(options.replyTimeout, 10) * 1000,
          });
          console.log("");
          console.log(reply.text);
        }
      } else {
        console.log(`Approval requested from ${person}. The bridge will dispatch after they approve.`);
        console.log(`requestId: ${delegationCommunicationSessionId(result)}`);
      }
      if (!options.wait || result.status !== "delegated") {
        console.log(`clientMessageId: ${result.clientMessageId ?? clientMessageId}`);
        console.log(`correlationId: ${result.correlationId ?? correlationId}`);
      }
    } finally {
      spool.close();
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

program.command("install-codex-skill")
  .description("install the Aicoo local-to-local delegation skill for Codex")
  .option("--target-dir <dir>", "Codex skill directory to write")
  .action((options) => {
    const result = installCodexSkill({ targetDir: options.targetDir });
    console.log(`${result.overwritten ? "Updated" : "Installed"} Aicoo C2C Codex skill.`);
    console.log(`skillFile: ${result.skillFile}`);
    console.log("Restart Codex so it can load the new skill.");
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
  localHelper?: boolean;
  localHelperPort?: string;
  localHelperHost?: string;
  relationshipPolicy?: string;
  model?: string;
  hosted?: boolean;
  server?: string;
  json?: boolean;
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
  if (selected.runtime === "codex") {
    ensureCodexSkill({ log: options.json ? undefined : console.log });
  }
  const deviceId = resolveDeviceId(undefined, options.spool);
  const spool = new BridgeSpool(options.spool);
  const bridge = new RuntimeBridge({
    transport: makeClient({ hosted: options.hosted, server: options.server, deviceId, spool: options.spool }),
    spool,
    adapter: selected.adapter,
    adapterVersion: selected.adapterVersion,
    runtime: selected.runtime,
    relationshipPolicyFile: options.relationshipPolicy ?? DEFAULT_RELATIONSHIP_POLICY_FILE,
    log: console.log,
  });
  let localHelper: ReturnType<typeof startLocalHelper> | undefined;
  if (options.localHelper ?? true) {
    try {
      const host = options.localHelperHost ?? "127.0.0.1";
      const port = options.localHelperPort ?? "43177";
      localHelper = startLocalHelper({
        hostname: host,
        port: Number.parseInt(port, 10),
        log: console.log,
      });
      localHelper?.on("listening", () => {
        console.log(`[local-helper] listening on http://${host}:${port}`);
      });
    } catch (error) {
      console.log(`[local-helper] not started: ${String(error)}`);
    }
  }
  const started = await bridge.start();
  if (options.json) {
    console.log(JSON.stringify({
      status: "ready",
      mode: "text-only",
      adapter: selected.label,
      ...started,
    }, null, 2));
  } else {
    console.log("\n========================================================");
    console.log("  Aicoo Local Agent Bridge is running!");
    console.log(`     Adapter:  ${selected.label}`);
    console.log(`     Device:   ${deviceId}`);
    console.log("     Status:   Ready for C2C collaboration");
    console.log("========================================================\n");
    console.log("Listening for incoming C2C session tasks... (Press Ctrl+C to stop)");
  }
  const shutdown = async () => {
    await bridge.stop();
    localHelper?.close();
    spool.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function getCredentialsFile(spoolFile?: string): string {
  if (!spoolFile || spoolFile === DEFAULT_SPOOL) return DEFAULT_CREDENTIALS_FILE;
  return `${spoolFile}.credentials.json`;
}

interface SavedCredentials {
  token?: string;
  deviceToken?: string;
  userId?: string;
  deviceId?: string;
  updatedAt?: string;
}

function loadSavedCredentials(spoolFile?: string): SavedCredentials | undefined {
  const primaryFile = getCredentialsFile(spoolFile);
  const files = primaryFile === DEFAULT_CREDENTIALS_FILE ? [primaryFile] : [primaryFile, DEFAULT_CREDENTIALS_FILE];
  for (const file of files) {
    try {
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, "utf8")) as SavedCredentials;
      }
    } catch {
      /* unreadable credentials file */
    }
  }
  return undefined;
}

function loadSavedToken(spoolFile?: string): string | undefined {
  const parsed = loadSavedCredentials(spoolFile);
  return parsed ? parsed.token ?? parsed.deviceToken : undefined;
}

function loadSavedDeviceId(spoolFile?: string): string | undefined {
  const saved = loadSavedCredentials(spoolFile)?.deviceId?.trim();
  return saved || undefined;
}

function loadSavedDeviceIdFromFile(spoolFile: string): string | undefined {
  const file = `${spoolFile}.device-id`;
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf8").trim();
      if (saved) return saved;
    }
  } catch {
    /* unreadable device-id file */
  }
  return undefined;
}

function saveSavedCredentials(credentials: { token: string; userId?: string; deviceId?: string }, spoolFile?: string): void {
  const file = getCredentialsFile(spoolFile);
  ensureParentDirectory(file);
  writeFileSync(file, JSON.stringify({ ...credentials, updatedAt: new Date().toISOString() }, null, 2));
}

function isHostedUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return url.protocol === "https:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

function makeClient(options: { hosted?: boolean; server?: string; deviceId?: string; spool?: string } = {}): HttpMessageTransport {
  const programOptions = program.opts<{ server: string; token?: string; spool?: string }>();
  const server = options.server ?? programOptions.server;
  const spoolFile = options.spool ?? programOptions.spool;
  const token = programOptions.token ?? process.env.CCD_TOKEN ?? loadSavedToken(spoolFile);
  const validToken = required(token, "--token, CCD_TOKEN, or run 'ccd login'");
  const isHosted = options.hosted || process.env.CCD_AICOO === "1" || isHostedUrl(server);
  if (isHosted) {
    return new AicooTransport({
      baseUrl: server,
      token: validToken,
      deviceId: options.deviceId,
      onTokenRefreshed: (newToken) => {
        saveSavedCredentials({ token: newToken, deviceId: options.deviceId }, spoolFile);
      },
    });
  }
  return makeTransport({ baseUrl: server, token: validToken, deviceId: options.deviceId });
}

function makeHostedClient(server?: string, spool?: string): HttpMessageTransport {
  return makeClient({ hosted: true, server: hostedServerUrl(server), spool });
}

function hostedServerUrl(explicitServer?: string): string {
  const serverCandidate = explicitServer ?? process.env.CCD_SERVER_URL ?? program.opts<{ server?: string }>().server;
  if (!serverCandidate || serverCandidate === LOCAL_SERVER_URL) return PRODUCT_AICOO_SERVER_URL;
  return serverCandidate;
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
  server?: string,
  spool?: string,
): Promise<CommunicationSession> {
  return makeHostedClient(server, spool).requestCommunicationSession({
    target: { kind: "person_default_runtime", principalId },
    replyEndpointId: route.endpointId,
    replySessionHandle: route.sessionHandle,
    requestedTtlMinutes: ttlMinutes,
  });
}

async function latestPendingSessionId(server?: string, spool?: string): Promise<string> {
  const client = makeHostedClient(server, spool);
  const me = await client.whoami();
  const pending = (await client.listCommunicationSessions())
    .filter((session) => session.status === "pending" && session.recipient.principalId === me.principalId)
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  const latest = pending[0];
  if (!latest) throw new Error("No pending incoming connection request found.");
  return latest.id;
}

async function acceptConnection(
  sessionId: string,
  access: RelationshipAccessPreset,
  policyFile: string,
  folder: string | undefined,
  server?: string,
  spool?: string,
): Promise<{
  grant: CommunicationGrant;
  accessPolicy: { status: "saved"; preset: RelationshipAccessPreset; policyFile: string; folder?: string } | { status: "not_applied"; reason: string };
}> {
  const grant = await makeHostedClient(server, spool).acceptCommunicationSession(sessionId);
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
    folder,
  });
  return { grant, accessPolicy: { status: "saved", preset: access, policyFile, ...(folder ? { folder } : {}) } };
}

async function activeSessionForPeer(peerPrincipalId: string, server?: string, spool?: string): Promise<CommunicationSession> {
  const active = (await makeHostedClient(server, spool).listCommunicationSessions())
    .filter((session) =>
      session.status === "active"
      && (session.requester.principalId === peerPrincipalId || session.recipient.principalId === peerPrincipalId))
    .sort((a, b) => Date.parse(b.activatedAt ?? b.requestedAt) - Date.parse(a.activatedAt ?? a.requestedAt));
  const session = active[0];
  if (!session) throw new Error(`No active connection found for ${peerPrincipalId}. Run ccd connect ${peerPrincipalId} first.`);
  return session;
}

function delegationCommunicationSessionId(result: LocalAgentDelegationResponse): string {
  const compact = result as LocalAgentDelegationResponse & { communicationSessionId?: string };
  const id = result.communicationSession?.id ?? compact.communicationSessionId;
  if (!id) throw new Error("delegation response did not include a communication session id");
  return id;
}

function delegationMessageId(result: Extract<LocalAgentDelegationResponse, { status: "delegated" }>): string {
  const compact = result as Extract<LocalAgentDelegationResponse, { status: "delegated" }> & { messageId?: string };
  const id = result.receipt?.messageId ?? compact.messageId;
  if (!id) throw new Error("delegation response did not include a message id");
  return id;
}

function resolveDeviceId(explicit: string | undefined, spoolFile: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const idFile = `${spoolFile}.device-id`;
  const saved = loadSavedDeviceIdFromFile(spoolFile) ?? loadSavedDeviceId(spoolFile);
  if (saved) return saved;
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
  let lastStatus = "";
  do {
    const status = await client.getMessageStatus(messageId);
    const formatted = formatDelivery(status);
    if (formatted !== lastStatus) {
      console.log(formatted);
      console.log("");
      lastStatus = formatted;
    }
    if (["runtime_acked", "inbox_persisted", "failed", "expired", "revoked", "rejected"].includes(status.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (true);
}

async function waitForDelegationReply(options: {
  client: HttpMessageTransport;
  spoolFile: string;
  correlationId: string;
  sentMessageId: string;
  timeoutMs: number;
}): Promise<{ text: string; event: RuntimeEvent }> {
  const timeoutAt = Date.now() + Math.max(1, options.timeoutMs);
  primeClientEndpoint(options.client, options.spoolFile);
  let cursor = "0";
  while (Date.now() < timeoutAt) {
    const events = await options.client.fetchInbox(cursor);
    if (events.length > 0) cursor = events.at(-1)?.cursor ?? cursor;
    const reply = events
      .map((event) => ({ event, envelope: messageEnvelope(event) }))
      .find(({ envelope }) =>
        envelope?.kind === "text"
        && envelope.correlationId === options.correlationId
        && envelope.replyTo === options.sentMessageId);
    if (reply?.envelope) {
      return { text: messageText(reply.envelope), event: reply.event };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for peer local agent reply (${options.correlationId}).`);
}

function primeClientEndpoint(client: HttpMessageTransport, spoolFile: string): void {
  const spool = new BridgeSpool(spoolFile);
  try {
    const endpointId = spool.getIdentity("endpointId");
    if (!endpointId) throw new Error("spool does not contain a registered endpoint");
    client.setEndpointId(endpointId);
  } finally {
    spool.close();
  }
}

function messageEnvelope(event: RuntimeEvent): MessageEnvelope | undefined {
  if (event.type !== "message.dispatch") return undefined;
  const envelope = (event.data as { envelope?: unknown }).envelope;
  return isMessageEnvelope(envelope) ? envelope : undefined;
}

function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return typeof value === "object"
    && value !== null
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { kind?: unknown }).kind === "string"
    && typeof (value as { payload?: unknown }).payload === "object"
    && (value as { payload?: unknown }).payload !== null;
}

function messageText(envelope: MessageEnvelope): string {
  const text = envelope.payload.text;
  return typeof text === "string" ? text : JSON.stringify(envelope.payload);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}`;
  return error instanceof Error ? error.message : String(error);
}
