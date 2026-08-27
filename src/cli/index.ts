import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { Command, Option } from "commander";
import { selectRuntimeAdapter, type RuntimeAdapterKind } from "../adapters/select-adapter.js";
import { BoundaryTelemetry } from "../adapters/boundary-telemetry.js";
import { bridgeHealthIsFresh, parseBridgeHealth } from "../bridge/health.js";
import { requestRuntimeDelegation, RuntimeBridge } from "../bridge/bridge.js";
import { startLocalHelper } from "../bridge/local-helper.js";
import { readProcessWatchdogDiagnostic, startProcessWatchdog } from "../bridge/process-watchdog.js";
import { BridgeSpool } from "../bridge/spool.js";
import type { CommunicationGrant, CommunicationSession, HumanInboxSendMessageInput, RequestCommunicationSessionInput } from "../shared/contracts.js";
import { ApiError, HttpMessageTransport, type ResolvedPersonResponse } from "../shared/http-client.js";
import { AicooTransport, makeTransport } from "../shared/aicoo-transport.js";
import type { ToolApprovalGateway } from "../shared/tool-approval.js";
import {
  resetRelationshipPolicy,
  upsertRelationshipPreset,
  type RelationshipAccessPreset,
} from "../security/relationship-policy.js";
import {
  readTrustedToolPolicies,
  revokeTrustedToolPolicy,
  upsertTrustedToolPolicy,
  type TrustedToolPolicyScope,
} from "../security/trusted-tool-policy.js";
import {
  isFileAccessPreset,
  type FileAccessPreset,
} from "../security/relationship-access.js";
import { startServer } from "../control-plane/server.js";
import { formatDelivery } from "./format.js";
import {
  ensureClaudeSkill,
  ensureCodexSkill,
  installClaudeSkill,
  installCodexSkill,
} from "./skill-install.js";
import { selectLocalSessionForPeer } from "./active-session.js";
import {
  COLLABORATION_CONTEXT_MAX_BYTES,
  parseCollaborationContext,
  type CollaborationContext,
} from "../shared/collaboration-context.js";
import { parseGoalPlan } from "../shared/goal-plan.js";
import { runGoalPlan } from "./goal-runner.js";
import {
  authorityDecisionFromEnvelope,
  delegationDeliveryFailure,
  isFinalDelegationReplyEnvelope,
} from "./delegation-replies.js";
import {
  assertRuntimeAvailable,
  authorizeDevice,
  formatTeamAgentWelcome,
  launchDetachedBridge,
  nodeMeetsMinimumVersion,
  readRunningProcessId,
  waitForBridgeReady,
} from "./onboarding.js";
import { getCredentialsFile, loadSavedToken, saveSavedCredentials } from "./credentials.js";
import {
  evaluateCapabilityRollout,
  resolveCapabilitySurface,
  type CapabilitySurfaceActivation,
  type CapabilitySurface,
} from "../shared/capability-rollout.js";

const LOCAL_SERVER_URL = "http://127.0.0.1:7790";
const PRODUCT_AICOO_SERVER_URL = "https://www.aicoo.io";
const PREVIEW_AICOO_SERVER_URL = "https://www.yourcoo.ai";
const DEFAULT_SPOOL = process.env.CCD_SPOOL?.trim()
  ? resolve(process.env.CCD_SPOOL)
  : join(homedir(), ".aicoo", "local-agent", "bridge.spool");

const program = new Command()
  .name("ccd")
  .description("aicoo-local-agent realtime runtime-messaging CLI")
  .option("--server <url>", "control-plane URL", process.env.CCD_SERVER_URL ?? LOCAL_SERVER_URL)
  .option("--token <token>", "device bearer token", process.env.CCD_TOKEN);

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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
      bridgeVersion: "0.5.0",
      adapterVersion: "0.5.0",
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

program.command("onboard")
  .description("connect this machine to Aicoo and start a verified local-agent bridge")
  .addOption(new Option("--runtime <adapter>", "runtime adapter")
    .choices(["claude-code", "codex"])
    .makeOptionMandatory())
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--workspace <dir>", "workspace exposed to the local runtime", process.cwd())
  .option("--server <url>", "control-plane URL")
  .addOption(new Option("--capability-surface <surface>", "peer agent capability surface")
    .choices(["restricted", "full-agent"])
    .default("restricted"))
  .option("--ready-timeout <milliseconds>", "time to wait for bidirectional readiness", "30000")
  .option("--no-open", "print the approval URL instead of opening a browser")
  .action(async (options) => {
    if (!nodeMeetsMinimumVersion(process.version)) {
      throw new Error(`Node.js 22.5 or newer is required; this machine is running ${process.version}.`);
    }
    assertRuntimeAvailable(options.runtime);

    const server = hostedServerUrl(options.server);
    const deviceId = resolveDeviceId(undefined, options.spool);
    const savedToken = loadSavedToken(options.spool);
    let authenticated = false;
    if (savedToken) {
      try {
        await makeHostedClient(server, options.spool).whoami();
        authenticated = true;
        console.log("✓ Existing Aicoo device authorization is valid");
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        console.log("The saved device authorization expired; opening Aicoo again.");
      }
    }

    if (!authenticated) {
      const unauthenticatedClient = new AicooTransport({
        baseUrl: server,
        token: "anonymous",
        deviceId,
      });
      const credentials = await authorizeDevice({
        client: unauthenticatedClient,
        deviceId,
        runtime: options.runtime,
        serverUrl: server,
        ...(options.open ? {} : { openUrl: async () => false }),
        log: console.log,
      });
      saveSavedCredentials(credentials, options.spool);
      console.log("✓ Identity verified and device authorization saved");
    }

    const localAgentDirectory = dirname(resolve(options.spool));
    const logFile = join(localAgentDirectory, "bridge.log");
    const pidFile = join(localAgentDirectory, "bridge.pid");
    const runningPid = readRunningProcessId(pidFile);
    if (runningPid) {
      console.log(`✓ Existing local bridge process found (${runningPid})`);
    } else {
      const cliEntry = process.argv[1];
      if (!cliEntry) throw new Error("Cannot determine the ccd CLI entry point.");
      const started = launchDetachedBridge({
        cliEntry,
        runtime: options.runtime,
        spoolFile: options.spool,
        logFile,
        pidFile,
        serverUrl: server,
        workspace: options.workspace,
        capabilitySurface: options.capabilitySurface,
      });
      console.log(`✓ Local bridge started in the background (${started.pid})`);
    }

    const readLocalEndpointId = () => {
      try {
        const spool = new BridgeSpool(options.spool);
        try {
          return spool.listSessionMappings().length > 0 ? spool.getIdentity("endpointId") : undefined;
        } finally {
          spool.close();
        }
      } catch {
        return undefined;
      }
    };
    const readyTimeoutMs = Number.parseInt(options.readyTimeout, 10);
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
      throw new Error("--ready-timeout must be a positive number of milliseconds.");
    }
    const ready = await waitForBridgeReady({
      clientFactory: () => makeHostedClient(server, options.spool),
      localEndpointId: readLocalEndpointId,
      timeoutMs: readyTimeoutMs,
    });

    console.log("\nAicoo Local Agent is ready.");
    console.log(`Runtime: ${options.runtime}`);
    console.log(`Endpoint: ${ready.endpointId}`);
    console.log(`Logs: ${logFile}`);
    try {
      const directory = await makeHostedClient(server, options.spool).listAgentDirectory();
      console.log("");
      for (const line of formatTeamAgentWelcome(directory)) console.log(line);
    } catch (error) {
      console.log("Bridge connected. Give me a task, or tell me whose agent you want to connect with.");
      console.log(`Agent directory is temporarily unavailable: ${errorMessage(error)}`);
    }
  });

program.command("agents")
  .description("list your Aicoo Team and connected friend agents and their published capabilities")
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .option("--json", "print the machine-readable private Agent Card directory", false)
  .action(async (options) => {
    const directory = await makeHostedClient(options.server, options.spool).listAgentDirectory();
    if (options.json) {
      print(directory);
      return;
    }
    for (const line of formatTeamAgentWelcome(directory)) console.log(line);
  });

program.command("goal")
  .description("execute a validated multi-agent goal plan and collect correlated results")
  .requiredOption("--plan-file <path>", "JSON goal plan prepared by the initiating agent")
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--ttl <minutes>", "per-subtask grant TTL", "30")
  .option("--timeout <seconds>", "per-subtask approval and execution timeout", "1800")
  .option("--request-timeout <seconds>", "delegation HTTP submission timeout", "30")
  .option("--server <url>", "control-plane URL")
  .action(async (options) => {
    if (statSync(options.planFile).size > 256 * 1024) throw new Error("goal plan is too large");
    const plan = parseGoalPlan(JSON.parse(readFileSync(options.planFile, "utf8")) as unknown);
    const client = makeHostedClient(options.server, options.spool);
    const route = await resolveRoute({ spool: options.spool });
    const spool = new BridgeSpool(options.spool);
    const timeoutMs = Number.parseInt(options.timeout, 10) * 1_000;
    const requestedTtlMinutes = Number.parseInt(options.ttl, 10);
    const requestTimeoutMs = Number.parseInt(options.requestTimeout, 10) * 1_000;

    try {
      const result = await runGoalPlan(plan, {
        runSubtask: async (subtask, identifiers) => {
          const resolved = await resolvePerson(client, subtask.target, options.spool);
          const task = subtask.projects
            ? { text: subtask.task, projectAccessIds: subtask.projects }
            : subtask.project
              ? { text: subtask.task, projectAccessId: subtask.project }
              : subtask.task;
          let context: CollaborationContext | undefined;
          if (subtask.contextFile) {
            if (statSync(subtask.contextFile).size > COLLABORATION_CONTEXT_MAX_BYTES) {
              throw new Error(`context_too_large: ${subtask.id}`);
            }
            context = parseCollaborationContext(
              JSON.parse(readFileSync(subtask.contextFile, "utf8")) as unknown,
              subtask.task,
            );
          }
          const delegation = await requestRuntimeDelegation({
            transport: client,
            spool,
            target: { kind: "person_default_runtime", principalId: resolved.principalId },
            task,
            ...(context ? { context } : {}),
            sessionHandle: route.sessionHandle,
            clientMessageId: identifiers.clientMessageId,
            correlationId: identifiers.correlationId,
            requestedTtlMinutes,
            timeoutMs,
            requestTimeoutMs,
          });
          const reply = await waitForDelegationReplyOrUndefined(
            spool,
            identifiers.correlationId,
            timeoutMs,
            delegation.status === "delegated"
              ? { transport: client, messageId: delegation.receipt.messageId }
              : delegation.status === "folder_access_requested"
                ? { transport: client, messageId: delegation.messageId }
              : undefined,
          );
          if (!reply) {
            return {
              status: delegation.status === "collaboration_requested"
                ? "awaiting_approval" as const
                : "timed_out" as const,
              error: delegation.status === "collaboration_requested"
                ? "The teammate has not approved this collaboration yet."
                : "The delegated agent did not reply before the timeout.",
            };
          }
          const outcome = reply.envelope.collaborationTurn?.outcome;
          const authorityDecision = authorityDecisionFromEnvelope(reply.envelope);
          const text = reply.envelope.payload.text;
          const resultText = typeof text === "string" ? text : JSON.stringify(reply.envelope.payload);
          if (authorityDecision === "deny") {
            return { status: "failed" as const, outcome: "failed" as const, result: resultText };
          }
          if (authorityDecision === "allow") {
            return { status: "completed" as const, outcome: "respond" as const, result: resultText };
          }
          if (outcome === "needs_owner") {
            return { status: "needs_owner" as const, outcome, result: resultText };
          }
          if (outcome === "failed") {
            return { status: "failed" as const, outcome, result: resultText };
          }
          return {
            status: "completed" as const,
            ...(outcome ? { outcome } : {}),
            result: resultText,
          };
        },
      });
      print(result);
    } finally {
      spool.close();
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
  .option("--codex-app-server", "drive codex through app-server so tool calls can be put to you for approval")
  .addOption(new Option("--capability-surface <surface>", "peer agent capability surface")
    .choices(["restricted", "full-agent"])
    .default("restricted"))
  .option("--local-helper-port <port>", "localhost folder/file picker helper port", process.env.CCD_LOCAL_HELPER_PORT ?? "43177")
  .option("--local-helper-host <host>", "localhost folder/file picker helper host", process.env.CCD_LOCAL_HELPER_HOST ?? "127.0.0.1")
  .option("--no-local-helper", "disable the localhost folder/file picker helper")
  .option(
    "--relationship-policy <file>",
    "JSON allowlist of tools/folders for verified users and devices",
    process.env.CCD_RELATIONSHIP_POLICY,
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
  .option("--codex-app-server", "drive codex through app-server so tool calls can be put to you for approval")
  .addOption(new Option("--capability-surface <surface>", "peer agent capability surface")
    .choices(["restricted", "full-agent"])
    .default("restricted"))
  .option("--claude-path <file>", "Claude Code executable", process.env.CLAUDE_CODE_PATH)
  .option("--local-helper-port <port>", "localhost folder/file picker helper port", process.env.CCD_LOCAL_HELPER_PORT ?? "43177")
  .option("--local-helper-host <host>", "localhost folder/file picker helper host", process.env.CCD_LOCAL_HELPER_HOST ?? "127.0.0.1")
  .option("--no-local-helper", "disable the localhost folder/file picker helper")
  .option("--model <model>", "provider model override", process.env.CLAUDE_MODEL)
  .option("--json", "output raw JSON status blob", false)
  .action(async (options) => {
    await startBridge({ ...options, hosted: true, server: hostedServerUrl() });
  });

program.command("whoami")
  .description("show the Aicoo identity bound to this machine")
  .option("--spool <file>", "bridge spool whose saved device credential should be used", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (options, command) => {
    const server = commandLineOption(command, "server", options.server);
    const spool = commandLineOption(command, "spool", options.spool);
    print(await makeHostedClient(server, spool).whoami());
  });

const trustedTools = program.command("trusted-access")
  .alias("trusted-tools")
  .description("manage preset-based collaborator project access on this machine");

trustedTools.command("allow")
  .description("pre-approve read-only or read-write project access for one collaborator device and folder")
  .argument("<person>", "peer principal ID or @handle")
  .addOption(new Option("--preset <preset>", "project access preset")
    .choices(["read-project", "edit-project"])
    .default("read-project"))
  .requiredOption("--folder <dir>", "exact local folder boundary")
  .addOption(new Option("--scope <scope>", "permission lifetime")
    .choices(["bridge-run", "always"])
    .default("bridge-run"))
  .option("--requester-device <id>", "verified peer device when more than one has been observed")
  .option("--spool <file>", "running bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (person, options) => {
    if (!isFileAccessPreset(options.preset)) throw new Error("Preset must be read-project or edit-project");
    const client = makeHostedClient(options.server, options.spool);
    const [owner, target, sessions] = await Promise.all([
      client.whoami(),
      resolvePerson(client, person, options.spool),
      client.listCommunicationSessions(),
    ]);
    const requesterDeviceId = selectVerifiedCollaboratorDevice({
      sessions,
      ownerPrincipalId: owner.principalId,
      requesterPrincipalId: target.principalId,
      requestedDeviceId: options.requesterDevice,
    });
    const spool = new BridgeSpool(options.spool);
    try {
      const file = spool.getIdentity("trustedToolPolicyFile")
        ?? `${resolve(options.spool)}.trusted-tools.json`;
      const bridgeInstanceId = spool.getIdentity("bridgeInstanceId");
      const scope: TrustedToolPolicyScope = options.scope === "always" ? "persistent" : "bridge_run";
      const accessPreset: FileAccessPreset = options.preset;
      if (scope === "bridge_run" && !bridgeInstanceId) {
        throw new Error("The bridge is not running for this spool; bridge-run access cannot be created.");
      }
      const policy = upsertTrustedToolPolicy({
        file,
        ownerPrincipalId: owner.principalId,
        ownerDeviceId: owner.deviceId,
        requesterPrincipalId: target.principalId,
        requesterDeviceId,
        folder: options.folder,
        accessPreset,
        scope,
        ...(scope === "bridge_run" ? { bridgeInstanceId } : {}),
        createdFrom: "cli",
        createdBy: owner.principalId,
      });
      print({
        policyId: policy.policyId,
        collaborator: target.displayName ?? target.name ?? target.handle ?? person,
        requesterDeviceId,
        folder: policy.canonicalFolder,
        accessPreset: policy.accessPreset,
        lifetime: policy.scope === "persistent" ? "always" : "while bridge is running",
        status: policy.status,
      });
    } finally {
      spool.close();
    }
  });

trustedTools.command("list")
  .description("list saved collaborator access presets")
  .option("--spool <file>", "bridge spool", DEFAULT_SPOOL)
  .option("--all", "include revoked and invalid policies", false)
  .action((options) => {
    const spool = new BridgeSpool(options.spool);
    try {
      const file = spool.getIdentity("trustedToolPolicyFile")
        ?? `${resolve(options.spool)}.trusted-tools.json`;
      const bridgeInstanceId = spool.getIdentity("bridgeInstanceId");
      const document = readTrustedToolPolicies(file);
      print({
        revision: document.revision,
        policies: document.policies
          .filter((policy) => options.all || policy.status === "active")
          .map((policy) => ({
            ...policy,
            activeForCurrentBridge: policy.status === "active"
              && (policy.scope === "persistent" || policy.bridgeInstanceId === bridgeInstanceId),
          })),
      });
    } finally {
      spool.close();
    }
  });

trustedTools.command("revoke")
  .description("revoke one saved access policy")
  .argument("<policyId>")
  .option("--spool <file>", "bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (policyId, options) => {
    const owner = await makeHostedClient(options.server, options.spool).whoami();
    const spool = new BridgeSpool(options.spool);
    try {
      const file = spool.getIdentity("trustedToolPolicyFile")
        ?? `${resolve(options.spool)}.trusted-tools.json`;
      const revoked = revokeTrustedToolPolicy({ file, policyId, revokedBy: owner.principalId });
      if (!revoked) throw new Error(`Trusted tool policy ${policyId} was not found`);
      print({ policyId: revoked.policyId, status: revoked.status, revokedAt: revoked.revokedAt });
    } finally {
      spool.close();
    }
  });

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
        const resolved = await resolvePerson(client, person, options.spool);
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
    process.env.CCD_RELATIONSHIP_POLICY,
  )
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (sessionId, options, command) => {
    const server = commandLineOption(command, "server", options.server);
    const spoolFile = required(commandLineOption(command, "spool", options.spool), "--spool");
    const grant = await makeCollaborationClient(server, spoolFile).acceptCommunicationSession(sessionId);
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
    const policyFile = resolveRunningRelationshipPolicy(options.policy, spoolFile);
    upsertRelationshipPreset({
      file: policyFile,
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
        policyFile,
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
    process.env.CCD_RELATIONSHIP_POLICY,
  )
  .option("--spool <file>", "durable bridge spool", DEFAULT_SPOOL)
  .option("--server <url>", "control-plane URL")
  .action(async (sessionId, options) => {
    const id = sessionId ?? (await latestPendingSessionId(options.server, options.spool));
    const policyFile = resolveRunningRelationshipPolicy(options.policy, options.spool);
    const result = await acceptConnection(id, options.access as RelationshipAccessPreset, policyFile, options.folder, options.server, options.spool);
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
        const resolved = await resolvePerson(client, person, options.spool);
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
  .option("--request-timeout <seconds>", "delegation HTTP submission timeout", "30")
  .option("--context-file <path>", "bounded JSON context capsule prepared by your local agent")
  .option(
    "--project <id-or-folder>",
    "exact shared-project grant ID or approved absolute folder (repeat for one multi-project boundary)",
    collectOption,
    [],
  )
  .option("--no-wait", "return after dispatch instead of waiting for the peer reply")
  .option("--server <url>", "control-plane URL")
  .action(async (person, taskParts, options) => {
    const client = makeHostedClient(options.server, options.spool);
    let targetPrincipalId = person;
    if (person.startsWith("@") || !isUuid(person)) {
      try {
        const resolved = await resolvePerson(client, person, options.spool);
        targetPrincipalId = resolved.principalId;
      } catch (error) {
        console.error(`Could not resolve person '${person}': ${errorMessage(error)}`);
        process.exitCode = 1;
        return;
      }
    }

    const route = await resolveRoute({ spool: options.spool });
    const taskText = taskParts.join(" ");
    const projects = Array.isArray(options.project)
      ? [...new Set(options.project.map((project: unknown) => String(project).trim()).filter(Boolean))]
      : [];
    const task = projects.length > 1
      ? { text: taskText, projectAccessIds: projects }
      : projects.length === 1
        ? { text: taskText, projectAccessId: projects[0] }
        : taskText;
    let context: CollaborationContext | undefined;
    if (options.contextFile) {
      try {
        if (statSync(options.contextFile).size > COLLABORATION_CONTEXT_MAX_BYTES) {
          throw new Error("context_too_large");
        }
        context = parseCollaborationContext(
          JSON.parse(readFileSync(options.contextFile, "utf8")) as unknown,
          taskText,
        );
      } catch (error) {
        console.error(`Could not load context capsule: ${errorMessage(error)}`);
        process.exitCode = 1;
        return;
      }
    }
    const clientMessageId = options.clientId ?? `delegate:${randomUUID()}`;
    const correlationId = options.correlationId ?? clientMessageId;
    const spool = new BridgeSpool(options.spool);
    try {
      const result = await requestRuntimeDelegation({
        transport: client,
        spool,
        target: { kind: "person_default_runtime", principalId: targetPrincipalId },
        task,
        ...(context ? { context } : {}),
        sessionHandle: route.sessionHandle,
        clientMessageId,
        correlationId,
        requestedTtlMinutes: Number.parseInt(options.ttl, 10),
        timeoutMs: Number.parseInt(options.timeout, 10) * 1000,
        requestTimeoutMs: Number.parseInt(options.requestTimeout, 10) * 1000,
      });
      if (context) {
        console.log(`Context sent: ${context.items.length} item${context.items.length === 1 ? "" : "s"}.`);
      }
      if (result.status === "delegated") {
        console.log(`Delegated to ${person}'s local agent.`);
        console.log(`messageId: ${result.receipt.messageId}`);
      } else if (result.status === "collaboration_requested") {
        console.log(`Task collaboration requested from ${person}. The bridge will dispatch after they accept.`);
      } else if (result.status === "folder_access_requested" || result.approvalKind === "folder") {
        console.log(`File access approval requested from ${person}. The task will dispatch after they approve.`);
        if (result.approvalId) console.log(`approvalId: ${result.approvalId}`);
        console.log(`communicationSessionId: ${result.communicationSession.id}`);
      } else {
        console.log(`Collaboration approval requested from ${person}. The bridge will dispatch after they approve.`);
        console.log(`requestId: ${result.communicationSession.id}`);
      }
      console.log(`clientMessageId: ${result.clientMessageId}`);
      console.log(`correlationId: ${result.correlationId ?? correlationId}`);
      if (options.wait) {
        console.log("Waiting for the peer local agent's reply...");
        const reply = await waitForDelegationReply(
          spool,
          result.correlationId ?? correlationId,
          Number.parseInt(options.timeout, 10) * 1000,
          result.status === "delegated"
            ? { transport: client, messageId: result.receipt.messageId }
            : result.status === "folder_access_requested"
              ? { transport: client, messageId: result.messageId }
            : undefined,
        );
        const replyText = reply.envelope.payload.text;
        console.log("");
        console.log(typeof replyText === "string" ? replyText : JSON.stringify(reply.envelope.payload));
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
  .option("--server <url>", "control-plane URL")
  .action(async (options) => {
    // Resolve the hosted control plane the way login and start do. Inheriting the root --server
    // default sent doctor at http://127.0.0.1:7790, which only `ccd serve` hosts — so on a machine
    // running `ccd start` every check failed and the advice was to start what was already running.
    const client = makeHostedClient(options.server, options.spool);
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

    let endpointId: string | undefined;
    try {
      const route = await client.getDefaultRoute();
      endpointId = route.endpointId;
      checks.push({ name: "defaultRoute", ok: true, detail: route });
    } catch (error) {
      checks.push({
        name: "defaultRoute",
        ok: false,
        detail: errorMessage(error),
        next: "Start the bridge and wait for the '[bridge] default route -> ...' log.",
      });
    }

    // Every check above is a GET. In the field a machine has reported all of them green while
    // every write — heartbeat, default-route, message ack — timed out at the cap, which is the
    // failure that actually stops messages being delivered. So exercise one write too. Heartbeat
    // is the cheapest and is idempotent, so probing costs a `lastSeenAt` bump and nothing else.
    if (endpointId) {
      const startedAt = Date.now();
      try {
        await client.heartbeatEndpoint(endpointId);
        checks.push({
          name: "controlPlaneWrite",
          ok: true,
          detail: { endpointId, method: "POST heartbeat", elapsedMs: Date.now() - startedAt },
        });
      } catch (error) {
        checks.push({
          name: "controlPlaneWrite",
          ok: false,
          detail: { endpointId, method: "POST heartbeat", elapsedMs: Date.now() - startedAt, error: errorMessage(error) },
          next: "Reads work but writes do not, so this machine cannot ack messages. Compare a direct "
            + "POST (curl reaches the same route) against this one: if curl is fast, the difference is "
            + "Node's fetch ignoring your proxy settings — retry with NODE_USE_ENV_PROXY=1 on Node 24+.",
        });
      }
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
          const bridgeHealth = parseBridgeHealth(spool.getIdentity("bridgeHealth"));
          const bridgeHealthFresh = bridgeHealth ? bridgeHealthIsFresh(bridgeHealth) : false;
          checks.push({
            name: "localBridgeHealth",
            ok: bridgeHealthFresh
              && (bridgeHealth?.status === "healthy" || bridgeHealth?.status === "starting"),
            detail: bridgeHealth ? { ...bridgeHealth, fresh: bridgeHealthFresh } : { status: "unknown" },
            ...(bridgeHealthFresh
              && (bridgeHealth?.status === "healthy" || bridgeHealth?.status === "starting")
              ? {}
              : { next: "Restart the bridge and inspect bridge.log for heartbeat or event-loop failures." }),
          });
          const processWatchdog = readProcessWatchdogDiagnostic(`${resolve(options.spool)}.watchdog.json`);
          if (processWatchdog) {
            checks.push({
              name: "processWatchdog",
              ok: false,
              detail: processWatchdog,
              next: "The independent watchdog stopped a stalled bridge. Restart it, then attach bridge.log "
                + "and this watchdog diagnostic to the incident report.",
            });
          }
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

program.command("capability-readiness")
  .description("show whether local C2C rebuild evidence permits wider agent capabilities")
  .option("--spool <file>", "bridge spool to inspect", DEFAULT_SPOOL)
  .action((options) => {
    const spool = new BridgeSpool(options.spool);
    try {
      print({
        surface: "full-agent-capability",
        ...evaluateCapabilityRollout(new BoundaryTelemetry(spool.db).snapshot()),
      });
    } finally {
      spool.close();
    }
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

program.command("install-claude-skill")
  .description("install the Aicoo local-to-local delegation skill for Claude Code")
  .option("--target-dir <dir>", "Claude Code skill directory to write")
  .action((options) => {
    const result = installClaudeSkill({ targetDir: options.targetDir });
    console.log(`${result.overwritten ? "Updated" : "Installed"} Aicoo C2C Claude skill.`);
    console.log(`skillFile: ${result.skillFile}`);
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
  codexAppServer?: boolean;
  capabilitySurface?: CapabilitySurface;
  localHelper?: boolean;
  localHelperPort?: string;
  localHelperHost?: string;
  relationshipPolicy?: string;
  model?: string;
  hosted?: boolean;
  server?: string;
  json?: boolean;
}): Promise<void> {
  // Managed Codex/Claude turns inherit this bridge process environment. Preserve the exact
  // control plane and identity spool selected for this bridge so `ccd agents/delegate/goal`
  // invoked by the installed skill cannot silently fall back to another account or localhost.
  process.env.CCD_SPOOL = resolve(options.spool);
  process.env.CCD_SERVER_URL = options.server
    ?? process.env.CCD_SERVER_URL
    ?? program.opts<{ server?: string }>().server;
  ensureParentDirectory(options.spool);
  const readinessSpool = new BridgeSpool(options.spool);
  let boundaryMetrics: ReturnType<BoundaryTelemetry["snapshot"]>;
  try {
    boundaryMetrics = new BoundaryTelemetry(readinessSpool.db).snapshot();
  } finally {
    readinessSpool.close();
  }
  const rebuildReadiness = evaluateCapabilityRollout(boundaryMetrics);
  if (options.capabilitySurface === "full-agent" && !rebuildReadiness.eligible) {
    throw new Error(`full-agent capability is not ready: ${rebuildReadiness.reasons.join(", ")}`);
  }
  const bridgeInstanceId = randomUUID();
  const relationshipPolicyFile = options.relationshipPolicy ?? `${resolve(options.spool)}.relationships.json`;
  const trustedToolPolicyFile = `${resolve(options.spool)}.trusted-tools.json`;
  // The generated policy is a bridge-run lease, not a durable trust decision. An explicitly
  // supplied policy remains operator-managed and is not cleared automatically.
  const ephemeralRelationshipPolicy = !options.relationshipPolicy;
  if (ephemeralRelationshipPolicy) resetRelationshipPolicy(relationshipPolicyFile);
  const deviceId = resolveDeviceId(undefined, options.spool);
  const transport = makeClient({ hosted: options.hosted, server: options.server, deviceId, spool: options.spool });
  const ownerIdentity = await transport.whoami();
  // Only the hosted transport can reach the approval endpoints; a self-hosted mock cannot, and
  // wiring it anyway would turn every un-preauthorized tool into a confusing runtime error.
  const approvalGateway = typeof (transport as Partial<ToolApprovalGateway>).requestToolApproval === "function"
    ? (transport as unknown as ToolApprovalGateway)
    : undefined;
  const codexAppServer = options.codexAppServer || process.env.CCD_CODEX_APP_SERVER === "1";
  const capabilityActivation: CapabilitySurfaceActivation = resolveCapabilitySurface(
    options.capabilitySurface ?? "restricted",
    boundaryMetrics,
    {
      runtime: options.adapter,
      ownerApprovalGateway: Boolean(approvalGateway),
      ...(options.adapter === "codex" ? { codexAppServer } : {}),
    },
  );
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
    relationshipPolicyFile,
    trustedToolPolicyFile,
    ownerPrincipalId: ownerIdentity.principalId,
    ownerDeviceId: ownerIdentity.deviceId,
    bridgeInstanceId,
    capabilitySurface: capabilityActivation.active,
    ...(approvalGateway ? { approvalGateway } : {}),
    // Opt-in: drives Codex through app-server so the owner can be asked mid-turn.
    ...(codexAppServer ? { codexAppServer: true } : {}),
    model: options.model,
    log: console.log,
  });
  if (selected.runtime === "codex") {
    ensureCodexSkill({ log: options.json ? undefined : console.log });
  } else if (selected.runtime === "claude-code") {
    ensureClaudeSkill({ log: options.json ? undefined : console.log });
  }
  const spool = new BridgeSpool(options.spool);
  spool.setIdentity("relationshipPolicyFile", relationshipPolicyFile);
  spool.setIdentity("trustedToolPolicyFile", trustedToolPolicyFile);
  spool.setIdentity("ownerPrincipalId", ownerIdentity.principalId);
  spool.setIdentity("ownerDeviceId", ownerIdentity.deviceId);
  spool.setIdentity("bridgeInstanceId", bridgeInstanceId);
  spool.setIdentity("spoolFile", resolve(options.spool));
  // This watchdog owns a separate event loop. Unlike heartbeat timers in this process, it can
  // still stop the daemon if runtime execution completely starves the bridge's main thread.
  const processWatchdog = startProcessWatchdog({
    diagnosticFile: `${resolve(options.spool)}.watchdog.json`,
  });
  const bridge = new RuntimeBridge({
    transport,
    spool,
    adapter: selected.adapter,
    adapterVersion: selected.adapterVersion,
    workspaceBoundary: resolve(options.workspace ?? process.cwd()),
    runtime: selected.runtime,
    relationshipPolicyFile,
    trustedToolPolicyFile,
    ownerPrincipalId: ownerIdentity.principalId,
    ownerDeviceId: ownerIdentity.deviceId,
    bridgeInstanceId,
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
  let started: Awaited<ReturnType<RuntimeBridge["start"]>>;
  try {
    started = await bridge.start();
  } catch (error) {
    await processWatchdog.stop();
    localHelper?.close();
    if (ephemeralRelationshipPolicy) resetRelationshipPolicy(relationshipPolicyFile);
    spool.close();
    throw error;
  }
  if (options.json) {
    console.log(JSON.stringify({
      status: "ready",
      mode: capabilityActivation.active === "restricted" ? "text-only" : "full-agent",
      capabilitySurface: capabilityActivation.active,
      capabilityGate: {
        rollout: capabilityActivation.rollout,
        security: capabilityActivation.security,
      },
      adapter: selected.label,
      ...started,
    }, null, 2));
  } else {
    console.log("\n========================================================");
    console.log("  Aicoo Local Agent Bridge is running!");
    console.log(`     Adapter:  ${selected.label}`);
    console.log(`     Device:   ${deviceId}`);
    console.log(`     Surface:  ${capabilityActivation.active}`);
    if (capabilityActivation.active === "full-agent") {
      console.log("     Gate:     sandbox + approval + timeout + credential/output controls");
    }
    console.log("     Status:   Ready for C2C collaboration");
    console.log("========================================================\n");
    console.log("Listening for incoming C2C session tasks... (Press Ctrl+C to stop)");
  }
  const shutdown = async () => {
    await bridge.stop();
    await processWatchdog.stop();
    localHelper?.close();
    if (ephemeralRelationshipPolicy) resetRelationshipPolicy(relationshipPolicyFile);
    spool.deleteIdentity("relationshipPolicyFile");
    spool.deleteIdentity("bridgeInstanceId");
    spool.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function resolveRunningRelationshipPolicy(explicitPolicy: string | undefined, spoolFile: string): string {
  if (explicitPolicy) return explicitPolicy;
  const spool = new BridgeSpool(spoolFile);
  try {
    const policyFile = spool.getIdentity("relationshipPolicyFile");
    if (!policyFile) {
      throw new Error("The bridge is not running for this spool. Start it before granting folder access.");
    }
    return policyFile;
  } finally {
    spool.close();
  }
}

function isHostedUrl(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl);
    return url.hostname.includes("aicoo") || url.hostname.includes("yourcoo");
  } catch {
    return false;
  }
}

function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
}

async function resolvePerson(
  client: HttpMessageTransport,
  person: string,
  spoolFile?: string,
): Promise<ResolvedPersonResponse> {
  if (isUuid(person)) return { principalId: person.trim() };
  const normalizedHandle = person.trim().replace(/^@/, "");
  const cacheKey = `peerPrincipal:${normalizedHandle.toLowerCase()}`;
  let lookupError: unknown;
  const queries = [...new Set([person.trim(), normalizedHandle])];
  for (const query of queries) {
    try {
      const resolved = await client.resolvePerson(query);
      if (spoolFile) {
        const spool = new BridgeSpool(spoolFile);
        try {
          spool.setIdentity(cacheKey, resolved.principalId);
        } finally {
          spool.close();
        }
      }
      return resolved;
    } catch (error) {
      lookupError = error;
      if (error instanceof ApiError && error.status === 401) {
        throw new Error(
          `Device login expired for this spool. Run 'ccd login${spoolFile ? ` --spool ${spoolFile}` : ""}' and retry.`,
        );
      }
      if (!(error instanceof ApiError) || error.status !== 404) break;
    }
  }
  if (spoolFile) {
    const spool = new BridgeSpool(spoolFile);
    try {
      const principalId = spool.getIdentity(cacheKey);
      if (principalId) return { principalId, handle: normalizedHandle };
    } finally {
      spool.close();
    }
  }
  if (lookupError instanceof ApiError && lookupError.status === 404) {
    throw new Error(
      `Aicoo could not resolve '${person}' and no cached collaboration identity exists. `
      + "Confirm the username and complete Collaborate in Aicoo first.",
    );
  }
  throw lookupError;
}

function selectVerifiedCollaboratorDevice(input: {
  sessions: CommunicationSession[];
  ownerPrincipalId: string;
  requesterPrincipalId: string;
  requestedDeviceId?: string;
}): string {
  const verified = [...new Set(input.sessions.flatMap((session) =>
    session.requester.principalId === input.requesterPrincipalId
    && session.recipient.principalId === input.ownerPrincipalId
    && session.requester.deviceId
      ? [session.requester.deviceId]
      : []))].sort();
  if (input.requestedDeviceId) {
    if (!verified.includes(input.requestedDeviceId)) {
      throw new Error("That collaborator device has not been verified in a C2C request to this owner device.");
    }
    return input.requestedDeviceId;
  }
  if (verified.length === 1) return verified[0]!;
  if (verified.length === 0) {
    throw new Error("No verified collaborator device was found. Accept one C2C task from that device first.");
  }
  throw new Error(`More than one verified collaborator device was found; pass --requester-device (${verified.join(", ")}).`);
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
      loadToken: () => loadSavedToken(spoolFile),
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

function commandLineOption(command: Command, name: string, fallback?: string): string | undefined {
  let current: Command | null = command;
  while (current) {
    if (current.getOptionValueSource(name) === "cli") {
      const value = current.opts<Record<string, unknown>>()[name];
      if (typeof value === "string" && value.trim()) return value;
    }
    current = current.parent;
  }
  return fallback;
}

function makeCollaborationClient(server?: string, spool?: string): HttpMessageTransport {
  const rootServer = program.opts<{ server?: string }>().server;
  const rootServerSource = program.getOptionValueSource("server");
  const environmentServer = process.env.CCD_SERVER_URL?.trim() || undefined;
  const selectedServer = server
    ?? (rootServerSource === "cli" ? rootServer : undefined)
    ?? environmentServer;
  if (selectedServer) {
    return makeClient({ server: normalizeHostedServerUrl(selectedServer), spool });
  }
  return makeHostedClient(undefined, spool);
}

function hostedServerUrl(explicitServer?: string): string {
  const serverCandidate = explicitServer ?? process.env.CCD_SERVER_URL ?? program.opts<{ server?: string }>().server;
  if (!serverCandidate || serverCandidate === LOCAL_SERVER_URL) return PRODUCT_AICOO_SERVER_URL;
  return normalizeHostedServerUrl(serverCandidate);
}

function normalizeHostedServerUrl(server: string): string {
  try {
    const url = new URL(server);
    if (url.hostname === "yourcoo.ai") return PREVIEW_AICOO_SERVER_URL;
  } catch {
    return server;
  }
  return server;
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
  const client = makeCollaborationClient(server, spool);
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
  const grant = await makeCollaborationClient(server, spool).acceptCommunicationSession(sessionId);
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
  const client = makeHostedClient(server, spool);
  const [identity, sessions] = await Promise.all([client.whoami(), client.listCommunicationSessions()]);
  const session = selectLocalSessionForPeer(sessions, identity.principalId, peerPrincipalId);
  if (!session) {
    throw new Error(
      `No active local-runtime connection found for ${peerPrincipalId}. Use ccd delegate so Aicoo can establish the correct route.`,
    );
  }
  return session;
}

async function waitForDelegationReply(
  spool: BridgeSpool,
  correlationId: string,
  timeoutMs: number,
  delivery?: DelegationDeliveryMonitor,
): Promise<ReturnType<BridgeSpool["findReplyByCorrelation"]> & {}> {
  const deadline = Date.now() + timeoutMs;
  let nextDeliveryCheckAt = 0;
  while (Date.now() < deadline) {
    const reply = spool.findReplyByCorrelation(correlationId);
    // A bounded collaboration can exchange follow-up turns. Tool-boundary approvals do not
    // emit a peer reply until resume completes, so a received needs_owner reply is actionable.
    if (isFinalDelegationReply(reply)) return reply;
    nextDeliveryCheckAt = await throwIfDelegationFailed(delivery, nextDeliveryCheckAt);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the peer reply (${correlationId})`);
}

async function waitForDelegationReplyOrUndefined(
  spool: BridgeSpool,
  correlationId: string,
  timeoutMs: number,
  delivery?: DelegationDeliveryMonitor,
): Promise<ReturnType<BridgeSpool["findReplyByCorrelation"]>> {
  const deadline = Date.now() + timeoutMs;
  let nextDeliveryCheckAt = 0;
  while (Date.now() < deadline) {
    const reply = spool.findReplyByCorrelation(correlationId);
    if (isFinalDelegationReply(reply)) return reply;
    nextDeliveryCheckAt = await throwIfDelegationFailed(delivery, nextDeliveryCheckAt);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

type DelegationDeliveryMonitor = {
  transport: Pick<HttpMessageTransport, "getMessageStatus">;
  messageId: string;
};

async function throwIfDelegationFailed(
  delivery: DelegationDeliveryMonitor | undefined,
  nextCheckAt: number,
): Promise<number> {
  if (!delivery || Date.now() < nextCheckAt) return nextCheckAt;
  const retryAt = Date.now() + 1_000;
  let status;
  try {
    status = await delivery.transport.getMessageStatus(delivery.messageId);
  } catch {
    // Status polling is advisory while the correlated reply channel remains healthy.
    return retryAt;
  }
  const failure = delegationDeliveryFailure(status);
  if (failure) throw new Error(failure);
  return retryAt;
}

function isFinalDelegationReply(
  reply: ReturnType<BridgeSpool["findReplyByCorrelation"]>,
): reply is NonNullable<ReturnType<BridgeSpool["findReplyByCorrelation"]>> {
  return Boolean(reply && isFinalDelegationReplyEnvelope(reply.envelope));
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

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}`;
  return error instanceof Error ? error.message : String(error);
}
