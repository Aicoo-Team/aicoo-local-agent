import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ApiError,
  type PollDeviceCodeResponse,
  type StartDeviceCodeInput,
  type StartDeviceCodeResponse,
} from "../shared/http-client.js";
import type { TeamAgentDirectory } from "../shared/contracts.js";
import type { CapabilitySurface } from "../shared/capability-rollout.js";
import { BridgeSpool } from "../bridge/spool.js";
import { bridgeHealthIsFresh, parseBridgeHealth } from "../bridge/health.js";

const MINIMUM_NODE_VERSION = [22, 5, 0] as const;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 1_000;

export type OnboardingRuntime = "claude-code" | "codex";

export interface BridgeLaunchConfig {
  runtime: OnboardingRuntime;
  capabilitySurface: CapabilitySurface;
  workspace: string;
}

export function bridgeLaunchConfigMatches(
  actual: BridgeLaunchConfig | undefined,
  requested: BridgeLaunchConfig,
): boolean {
  return actual?.runtime === requested.runtime
    && actual.capabilitySurface === requested.capabilitySurface
    && resolve(actual.workspace) === resolve(requested.workspace);
}

export interface DeviceAuthorizationClient {
  startDeviceCode(input: StartDeviceCodeInput): Promise<StartDeviceCodeResponse>;
  pollDeviceCode(pollToken: string): Promise<PollDeviceCodeResponse>;
}

export interface BridgeReadinessClient {
  getDefaultRoute(): Promise<{ endpointId: string }>;
  heartbeatEndpoint(endpointId: string): Promise<void>;
}

export function resolveOnboardingRuntimeFiles(
  spoolFile: string,
  defaultSpoolFile: string,
): { logFile: string; pidFile: string } {
  const spoolPath = resolve(spoolFile);
  if (spoolPath === resolve(defaultSpoolFile)) {
    const directory = dirname(spoolPath);
    return {
      logFile: resolve(directory, "bridge.log"),
      pidFile: resolve(directory, "bridge.pid"),
    };
  }
  return {
    logFile: `${spoolPath}.bridge.log`,
    pidFile: `${spoolPath}.bridge.pid`,
  };
}

function relationshipLabel(relationships: TeamAgentDirectory["agents"][number]["relationships"]): string {
  const isTeam = relationships?.includes("team") ?? false;
  const isFriend = relationships?.includes("friend") ?? false;
  if (isTeam && isFriend) return "Team + Friend";
  if (isFriend) return "Friend";
  // Older servers only returned Team cards and omitted relationship metadata.
  return "Team";
}

export function formatTeamAgentWelcome(directory: TeamAgentDirectory): string[] {
  const heading = directory.agents.length > 0
    ? "Bridge connected. Here are your Team and connected friend agents:"
    : directory.team
      ? `Bridge connected. Your ${directory.team.name} Team has no other discoverable agents yet.`
      : "Bridge connected. You have no discoverable Team or connected friend agents yet.";
  if (directory.agents.length === 0) {
    return [
      heading,
      directory.team
        ? "The first task plan will still be created locally."
        : "Join a Team or accept an individual agent connection to discover agents here.",
      "Give me a task, or tell me whose agent you want to connect with.",
    ];
  }

  const agents = directory.agents.map((agent) => {
    const status = agent.connectionState === "connected"
      ? agent.availability === "available" ? "connected, available" : "connected, away"
      : agent.connectionState === "connection_pending" ? "connection pending" : "contact";
    const skills = agent.agentCard.skills.map((skill) => skill.name).join(", ")
      || agent.agentCard.description;
    const relationship = relationshipLabel(agent.relationships);
    return `- ${agent.agentCard.name} [${relationship}] — ${agent.displayName}'s agent (${agent.role}; ${status}) — ${skills}`;
  });

  return [
    heading,
    ...agents,
    "Give me a task, or tell me whose agent you want to connect with.",
  ];
}

export const formatAgentWelcome = formatTeamAgentWelcome;

export interface SavedDeviceCredentials {
  token: string;
  userId?: string;
  deviceId: string;
}

export function nodeMeetsMinimumVersion(version: string): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const difference = (actual[index] ?? 0) - (MINIMUM_NODE_VERSION[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function runtimeCommand(runtime: OnboardingRuntime): string {
  return runtime === "codex" ? "codex" : "claude";
}

export function assertRuntimeAvailable(
  runtime: OnboardingRuntime,
  run: typeof spawnSync = spawnSync,
): void {
  const command = runtimeCommand(runtime);
  const result = run(command, ["--version"], { encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} is not installed or is not available on PATH.`);
  }
}

export async function authorizeDevice(options: {
  client: DeviceAuthorizationClient;
  deviceId: string;
  runtime: OnboardingRuntime;
  serverUrl: string;
  openUrl?: (url: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
  pollIntervalMs?: number;
}): Promise<SavedDeviceCredentials> {
  const log = options.log ?? console.log;
  const delay = options.delay ?? defaultDelay;
  const start = await options.client.startDeviceCode({
    deviceId: options.deviceId,
    runtime: options.runtime,
    bridgeVersion: "0.5.2",
    adapterVersion: "0.5.2",
    capabilities: ["comm:c2c", "runtime:adapter"],
  });
  const approvalUrl = validApprovalUrl(start.approvalUrl)
    ? start.approvalUrl
    : `${options.serverUrl.replace(/\/$/, "")}/local-agent/device-code?code=${encodeURIComponent(start.userCode)}`;

  log("Opening Aicoo to approve this machine...");
  const opened = await (options.openUrl ?? openInDefaultBrowser)(approvalUrl);
  if (!opened) {
    log("The browser could not be opened. Open this URL to continue:");
    log(approvalUrl);
  }
  log(`Device code: ${start.userCode}`);
  log("Waiting for approval in Aicoo...");

  while (true) {
    await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    let poll: PollDeviceCodeResponse;
    try {
      poll = await options.client.pollDeviceCode(start.pollToken);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && error.code === "pending") continue;
      throw error;
    }
    if (poll.status === "pending") continue;
    if (poll.status === "approved") {
      return { token: poll.deviceToken, userId: poll.userId, deviceId: options.deviceId };
    }
    if (poll.status === "denied") throw new Error("Device approval was denied.");
    if (poll.status === "expired") throw new Error("Device approval expired. Run ccd onboard again.");
    throw new Error("Device approval code was already used. Run ccd onboard again.");
  }
}

export async function openInDefaultBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

export function launchDetachedBridge(options: {
  cliEntry: string;
  runtime: OnboardingRuntime;
  spoolFile: string;
  logFile: string;
  pidFile: string;
  serverUrl: string;
  workspace?: string;
  capabilitySurface?: CapabilitySurface;
  spawnProcess?: typeof spawn;
}): { pid: number } {
  mkdirSync(dirname(options.logFile), { recursive: true });
  mkdirSync(dirname(options.pidFile), { recursive: true });
  const logFd = openSync(options.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(process.execPath, [
      ...process.execArgv,
      options.cliEntry,
      "start",
      // App-server carries the named permission profile and runtime workspace roots together.
      // The legacy exec path can advertise edit-project while its managed apply_patch helper
      // still loses the writable root and fails inside the kernel sandbox.
      "--adapter",
      options.runtime,
      ...(options.runtime === "codex" ? ["--codex-app-server"] : []),
      "--spool",
      options.spoolFile,
      ...(options.workspace ? ["--workspace", options.workspace] : []),
      ...(options.capabilitySurface
        ? ["--capability-surface", options.capabilitySurface]
        : []),
    ], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        CCD_AICOO: "1",
        CCD_SERVER_URL: options.serverUrl,
        CCD_SPOOL: resolve(options.spoolFile),
      },
    });
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error("The local bridge process could not be started.");
  child.unref();
  writeFileSync(options.pidFile, `${child.pid}\n`, { mode: 0o600 });
  return { pid: child.pid };
}

export function readRunningProcessId(
  pidFile: string,
  probe: (pid: number) => boolean = defaultProcessProbe,
): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 && probe(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function readRegisteredEndpointId(spoolFile: string): string | undefined {
  try {
    const spool = new BridgeSpool(spoolFile);
    try {
      return spool.getIdentity("endpointId");
    } finally {
      spool.close();
    }
  } catch {
    return undefined;
  }
}

export interface ManagedBridgeStatus {
  running: boolean;
  pid?: number;
  endpointId?: string;
  runtime?: OnboardingRuntime;
  capabilitySurface?: CapabilitySurface;
  /** What the bridge was launched asking for, when that differs from what it got. */
  requestedCapabilitySurface?: CapabilitySurface;
  workspace?: string;
}

export function formatCapabilitySurfaceStatus(input: {
  requested: CapabilitySurface;
  active: CapabilitySurface;
}): string {
  if (input.active === input.requested) return `Capability: ${input.active}`;
  return `Capability: ${input.active} (requested ${input.requested}; local rebuild health is outside its limits)`;
}

export function inspectManagedBridge(options: {
  spoolFile: string;
  pidFile: string;
  probe?: (pid: number) => boolean;
}): ManagedBridgeStatus {
  const pid = readRunningProcessId(options.pidFile, options.probe);
  const status: ManagedBridgeStatus = { running: pid !== undefined, ...(pid ? { pid } : {}) };
  try {
    const spool = new BridgeSpool(options.spoolFile);
    try {
      const endpointId = spool.getIdentity("endpointId");
      const runtime = spool.getIdentity("launchRuntime");
      const capabilitySurface = spool.getIdentity("launchCapabilitySurface");
      const requestedCapabilitySurface = spool.getIdentity("launchRequestedCapabilitySurface");
      const workspace = spool.getIdentity("launchWorkspace");
      if (endpointId) status.endpointId = endpointId;
      if (runtime === "codex" || runtime === "claude-code") status.runtime = runtime;
      if (capabilitySurface === "restricted" || capabilitySurface === "full-agent") {
        status.capabilitySurface = capabilitySurface;
      }
      // Reported separately so a bridge that asked for full-agent and came up restricted reads
      // as a pending gate rather than as an owner who never asked.
      if (requestedCapabilitySurface === "restricted" || requestedCapabilitySurface === "full-agent") {
        status.requestedCapabilitySurface = requestedCapabilitySurface;
      }
      if (workspace) status.workspace = workspace;
    } finally {
      spool.close();
    }
  } catch {
    // A missing or unreadable spool is a valid stopped/unconfigured state.
  }
  return status;
}

export function managedBridgeHealthAllowsReuse(spoolFile: string, nowMs = Date.now()): boolean {
  try {
    const spool = new BridgeSpool(spoolFile);
    try {
      const health = parseBridgeHealth(spool.getIdentity("bridgeHealth"));
      return Boolean(
        health
        && health.status !== "stopped"
        && health.status !== "unhealthy"
        && bridgeHealthIsFresh(health, nowMs),
      );
    } finally {
      spool.close();
    }
  } catch {
    return false;
  }
}

export async function stopManagedBridge(
  pid: number,
  options: {
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
    probe?: (pid: number) => boolean;
    delay?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const signalProcess = options.signalProcess ?? ((target, signal) => process.kill(target, signal));
  const probe = options.probe ?? defaultProcessProbe;
  const delay = options.delay ?? defaultDelay;
  signalProcess(pid, "SIGTERM");
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (probe(pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (probe(pid)) {
    throw new Error(`Local bridge process ${pid} did not stop after SIGTERM.`);
  }
}

export async function stopManagedBridgeFromPidFile(
  pidFile: string,
  options: Parameters<typeof stopManagedBridge>[1] = {},
): Promise<{ stopped: boolean; pid?: number }> {
  const pid = readRunningProcessId(pidFile, options.probe);
  if (pid === undefined) {
    try { unlinkSync(pidFile); } catch { /* No PID file to clean. */ }
    return { stopped: false };
  }
  await stopManagedBridge(pid, options);
  try { unlinkSync(pidFile); } catch { /* The exiting bridge may already have removed it. */ }
  return { stopped: true, pid };
}

export function removeManagedPidFile(pidFile: string, expectedPid = process.pid): void {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (pid === expectedPid) unlinkSync(pidFile);
  } catch {
    // Cleanup is best-effort and must not mask the original shutdown reason.
  }
}

export async function waitForBridgeReady(options: {
  clientFactory: () => BridgeReadinessClient;
  localEndpointId?: () => string | undefined;
  timeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<{ endpointId: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const delay = options.delay ?? defaultDelay;
  let lastError: unknown;
  do {
    try {
      const client = options.clientFactory();
      const route = await client.getDefaultRoute();
      const localEndpointId = options.localEndpointId?.();
      if (options.localEndpointId && localEndpointId !== route.endpointId) {
        throw new Error("the local bridge has not registered its current endpoint yet");
      }
      await client.heartbeatEndpoint(route.endpointId);
      return { endpointId: route.endpointId };
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(options.pollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS);
    }
  } while (Date.now() < deadline);
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`The local bridge did not become ready within ${timeoutMs}ms${detail}`);
}

function validApprovalUrl(url: string | undefined): url is string {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")) && !url.includes("undefined"));
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultProcessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
