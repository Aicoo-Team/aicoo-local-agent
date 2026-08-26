import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ApiError,
  type PollDeviceCodeResponse,
  type StartDeviceCodeInput,
  type StartDeviceCodeResponse,
} from "../shared/http-client.js";
import type { TeamAgentDirectory } from "../shared/contracts.js";
import type { CapabilitySurface } from "../shared/capability-rollout.js";

const MINIMUM_NODE_VERSION = [22, 5, 0] as const;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 1_000;

export type OnboardingRuntime = "claude-code" | "codex";

export interface DeviceAuthorizationClient {
  startDeviceCode(input: StartDeviceCodeInput): Promise<StartDeviceCodeResponse>;
  pollDeviceCode(pollToken: string): Promise<PollDeviceCodeResponse>;
}

export interface BridgeReadinessClient {
  getDefaultRoute(): Promise<{ endpointId: string }>;
  heartbeatEndpoint(endpointId: string): Promise<void>;
}

export function formatTeamAgentWelcome(directory: TeamAgentDirectory): string[] {
  const heading = directory.team
    ? `Bridge connected. Here are the agents in ${directory.team.name} and what they can help with:`
    : "Bridge connected. You are not in an Aicoo Team yet.";
  if (directory.agents.length === 0) {
    return [
      heading,
      directory.team
        ? "No other team agents are available yet. The first task plan will still be created locally."
        : "Join a team to discover teammate agents automatically.",
      "Give me a task, or tell me whose agent you want to connect with.",
    ];
  }

  const agents = directory.agents.map((agent) => {
    const status = agent.connectionState === "connected"
      ? agent.availability === "available" ? "connected, available" : "connected, away"
      : agent.connectionState === "connection_pending" ? "connection pending" : "contact";
    const skills = agent.agentCard.skills.map((skill) => skill.name).join(", ")
      || agent.agentCard.description;
    return `- ${agent.agentCard.name} — ${agent.displayName}'s agent (${agent.role}; ${status}) — ${skills}`;
  });

  return [
    heading,
    ...agents,
    "Give me a task, or tell me whose agent you want to connect with.",
  ];
}

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
    bridgeVersion: "0.4.5",
    adapterVersion: "0.4.5",
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
