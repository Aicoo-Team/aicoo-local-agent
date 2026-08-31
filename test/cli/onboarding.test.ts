import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeDevice,
  bridgeLaunchConfigMatches,
  formatCapabilitySurfaceStatus,
  formatTeamAgentWelcome,
  inspectManagedBridge,
  launchDetachedBridge,
  managedBridgeHealthAllowsReuse,
  nodeMeetsMinimumVersion,
  readRegisteredEndpointId,
  readRunningProcessId,
  resolveOnboardingRuntimeFiles,
  stopManagedBridge,
  stopManagedBridgeFromPidFile,
  waitForBridgeReady,
  type DeviceAuthorizationClient,
} from "../../src/cli/onboarding.js";
import { ApiError } from "../../src/shared/http-client.js";
import { BridgeSpool } from "../../src/bridge/spool.js";

describe("local-agent onboarding", () => {
  it("opens the approval page and continues after one human approval", async () => {
    const client: DeviceAuthorizationClient = {
      startDeviceCode: vi.fn().mockResolvedValue({
        userCode: "ABCD-1234",
        pollToken: "poll-token",
        approvalUrl: "https://www.aicoo.io/local-agent/device-code?code=ABCD-1234",
        expiresAt: "2026-08-18T12:00:00.000Z",
      }),
      pollDeviceCode: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValueOnce({ status: "approved", deviceToken: "device-token", userId: "user-1" }),
    };
    const openUrl = vi.fn().mockResolvedValue(true);
    const log = vi.fn();

    const result = await authorizeDevice({
      client,
      deviceId: "device-1",
      runtime: "codex",
      serverUrl: "https://www.aicoo.io",
      openUrl,
      delay: vi.fn().mockResolvedValue(undefined),
      log,
    });

    expect(openUrl).toHaveBeenCalledWith(
      "https://www.aicoo.io/local-agent/device-code?code=ABCD-1234",
    );
    expect(client.startDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      bridgeVersion: "0.5.1",
      adapterVersion: "0.5.1",
    }));
    expect(result).toEqual({ token: "device-token", userId: "user-1", deviceId: "device-1" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Waiting for approval"));
  });

  it("prints the approval URL when the browser cannot be opened", async () => {
    const client: DeviceAuthorizationClient = {
      startDeviceCode: vi.fn().mockResolvedValue({
        userCode: "ABCD-1234",
        pollToken: "poll-token",
        expiresAt: "2026-08-18T12:00:00.000Z",
      }),
      pollDeviceCode: vi.fn().mockResolvedValue({
        status: "approved",
        deviceToken: "device-token",
        userId: "user-1",
      }),
    };
    const log = vi.fn();

    await authorizeDevice({
      client,
      deviceId: "device-1",
      runtime: "claude-code",
      serverUrl: "https://www.aicoo.io",
      openUrl: vi.fn().mockResolvedValue(false),
      delay: vi.fn().mockResolvedValue(undefined),
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "https://www.aicoo.io/local-agent/device-code?code=ABCD-1234",
    );
  });

  it("keeps polling when the hosted API represents pending as a 400 response", async () => {
    const client: DeviceAuthorizationClient = {
      startDeviceCode: vi.fn().mockResolvedValue({
        userCode: "ABCD-1234",
        pollToken: "poll-token",
        expiresAt: "2026-08-18T12:00:00.000Z",
      }),
      pollDeviceCode: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(400, "pending", { status: "pending" }))
        .mockResolvedValueOnce({ status: "approved", deviceToken: "device-token", userId: "user-1" }),
    };

    await expect(authorizeDevice({
      client,
      deviceId: "device-1",
      runtime: "codex",
      serverUrl: "https://www.aicoo.io",
      openUrl: vi.fn().mockResolvedValue(true),
      delay: vi.fn().mockResolvedValue(undefined),
    })).resolves.toMatchObject({ token: "device-token" });
  });

  it.each([
    ["22.5.0", true],
    ["v24.1.0", true],
    ["22.4.9", false],
    ["not-a-version", false],
  ])("checks the Node requirement for %s", (version, expected) => {
    expect(nodeMeetsMinimumVersion(version)).toBe(expected);
  });

  it("waits until the bridge has a bidirectional control-plane path", async () => {
    const heartbeatEndpoint = vi.fn().mockResolvedValue(undefined);
    const firstClient = {
      getDefaultRoute: vi.fn().mockRejectedValue(new Error("not ready")),
      heartbeatEndpoint,
    };
    const secondClient = {
      getDefaultRoute: vi.fn().mockResolvedValue({ endpointId: "endpoint-1" }),
      heartbeatEndpoint,
    };
    const clientFactory = vi.fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    await expect(waitForBridgeReady({
      clientFactory,
      timeoutMs: 1_000,
      delay: vi.fn().mockResolvedValue(undefined),
    })).resolves.toEqual({ endpointId: "endpoint-1" });
    expect(heartbeatEndpoint).toHaveBeenCalledWith("endpoint-1");
  });

  it("only reuses a bridge PID when that process is still running", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "ccd-onboarding-pid-")), "bridge.pid");
    writeFileSync(pidFile, "4321\n");
    expect(readRunningProcessId(pidFile, (pid) => pid === 4321)).toBe(4321);
    expect(readRunningProcessId(pidFile, () => false)).toBeUndefined();
  });

  it("recognizes a freshly registered endpoint before any collaboration session exists", () => {
    const spoolFile = join(mkdtempSync(join(tmpdir(), "ccd-onboarding-ready-")), "bridge.spool");
    const spool = new BridgeSpool(spoolFile);
    spool.setIdentity("endpointId", "endpoint-fresh");
    expect(spool.listSessionMappings()).toHaveLength(0);
    spool.close();

    expect(readRegisteredEndpointId(spoolFile)).toBe("endpoint-fresh");
  });

  it("does not reuse a restricted bridge when onboarding requests full-agent", () => {
    expect(bridgeLaunchConfigMatches({
      runtime: "codex",
      capabilitySurface: "restricted",
      workspace: "/tmp/project",
    }, {
      runtime: "codex",
      capabilitySurface: "full-agent",
      workspace: "/tmp/project",
    })).toBe(false);
  });

  it("reuses a bridge only when runtime, capability surface, and workspace match", () => {
    const config = {
      runtime: "codex" as const,
      capabilitySurface: "full-agent" as const,
      workspace: "/tmp/project",
    };
    expect(bridgeLaunchConfigMatches(config, config)).toBe(true);
    expect(bridgeLaunchConfigMatches(undefined, config)).toBe(false);
    expect(bridgeLaunchConfigMatches({ ...config, workspace: "/tmp/other" }, config)).toBe(false);
  });

  it("stops a managed bridge before relaunching it with a different configuration", async () => {
    let running = true;
    const signalProcess = vi.fn(() => {
      running = false;
    });

    await expect(stopManagedBridge(4321, {
      signalProcess,
      probe: () => running,
      delay: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBeUndefined();
    expect(signalProcess).toHaveBeenCalledWith(4321, "SIGTERM");
  });

  it("reports managed bridge lifecycle and launch configuration from its spool", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-bridge-status-"));
    const spoolFile = join(directory, "bridge.spool");
    const pidFile = join(directory, "bridge.pid");
    writeFileSync(pidFile, "4321\n");
    const spool = new BridgeSpool(spoolFile);
    spool.setIdentity("endpointId", "endpoint-1");
    spool.setIdentity("launchRuntime", "codex");
    spool.setIdentity("launchCapabilitySurface", "full-agent");
    spool.setIdentity("launchWorkspace", "/tmp/project");
    spool.close();

    expect(inspectManagedBridge({ spoolFile, pidFile, probe: (pid) => pid === 4321 })).toMatchObject({
      running: true,
      pid: 4321,
      endpointId: "endpoint-1",
      runtime: "codex",
      capabilitySurface: "full-agent",
      workspace: "/tmp/project",
    });
  });

  it("separates the surface a degraded bridge asked for from the one it is running", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-bridge-degraded-"));
    const spoolFile = join(directory, "bridge.spool");
    const pidFile = join(directory, "bridge.pid");
    writeFileSync(pidFile, "4321\n");
    const spool = new BridgeSpool(spoolFile);
    spool.setIdentity("launchRuntime", "codex");
    spool.setIdentity("launchCapabilitySurface", "restricted");
    spool.setIdentity("launchRequestedCapabilitySurface", "full-agent");
    spool.setIdentity("launchWorkspace", "/tmp/project");
    spool.close();

    const status = inspectManagedBridge({ spoolFile, pidFile, probe: (pid) => pid === 4321 });
    expect(status).toMatchObject({
      capabilitySurface: "restricted",
      requestedCapabilitySurface: "full-agent",
    });

    // The relaunch comparison must run on what was asked for. Comparing the active surface would
    // see "restricted" against a "full-agent" request and kill a healthy bridge on every onboard.
    const requested = {
      runtime: "codex" as const,
      capabilitySurface: "full-agent" as const,
      workspace: "/tmp/project",
    };
    expect(bridgeLaunchConfigMatches(
      { ...requested, capabilitySurface: status.requestedCapabilitySurface! },
      requested,
    )).toBe(true);
    expect(bridgeLaunchConfigMatches(
      { ...requested, capabilitySurface: status.capabilitySurface! },
      requested,
    )).toBe(false);
  });

  it("formats a degraded capability surface for the onboarding terminal", () => {
    expect(formatCapabilitySurfaceStatus({
      requested: "full-agent",
      active: "restricted",
    })).toBe("Capability: restricted (requested full-agent; local rebuild health is outside its limits)");
    expect(formatCapabilitySurfaceStatus({
      requested: "full-agent",
      active: "full-agent",
    })).toBe("Capability: full-agent");
  });

  it("stops the exact managed PID and removes its stale PID file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-bridge-stop-"));
    const pidFile = join(directory, "bridge.pid");
    writeFileSync(pidFile, "4321\n");
    let running = true;

    await expect(stopManagedBridgeFromPidFile(pidFile, {
      probe: () => running,
      signalProcess: () => {
        running = false;
      },
      delay: vi.fn().mockResolvedValue(undefined),
    })).resolves.toEqual({ stopped: true, pid: 4321 });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not reuse a running bridge whose persisted health stopped advancing", () => {
    const spoolFile = join(mkdtempSync(join(tmpdir(), "ccd-bridge-stale-")), "bridge.spool");
    const spool = new BridgeSpool(spoolFile);
    spool.setIdentity("bridgeHealth", JSON.stringify({
      status: "healthy",
      consecutiveHeartbeatFailures: 0,
      nextHeartbeatInMs: 10_000,
      eventLoopLagMs: 0,
      updatedAt: "2026-08-29T00:00:00.000Z",
    }));
    spool.close();

    expect(managedBridgeHealthAllowsReuse(spoolFile, Date.parse("2026-08-29T00:02:00.000Z")))
      .toBe(false);
  });

  it("isolates detached PID and log files for custom spools in one directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-onboarding-profiles-"));
    const defaultSpool = join(directory, "bridge.spool");
    const abhinav = resolveOnboardingRuntimeFiles(join(directory, "abhinav.spool"), defaultSpool);
    const omkar = resolveOnboardingRuntimeFiles(join(directory, "omkar.spool"), defaultSpool);

    expect(abhinav).toEqual({
      logFile: join(directory, "abhinav.spool.bridge.log"),
      pidFile: join(directory, "abhinav.spool.bridge.pid"),
    });
    expect(omkar).toEqual({
      logFile: join(directory, "omkar.spool.bridge.log"),
      pidFile: join(directory, "omkar.spool.bridge.pid"),
    });
    expect(abhinav).not.toEqual(omkar);
    expect(resolveOnboardingRuntimeFiles(defaultSpool, defaultSpool)).toEqual({
      logFile: join(directory, "bridge.log"),
      pidFile: join(directory, "bridge.pid"),
    });
  });

  it("propagates the selected server and spool to managed agent commands", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-onboarding-env-"));
    const spawnProcess = vi.fn().mockReturnValue({ pid: 4321, unref: vi.fn() });

    launchDetachedBridge({
      cliEntry: "/tmp/ccd.js",
      runtime: "codex",
      spoolFile: join(directory, "omkar.spool"),
      logFile: join(directory, "bridge.log"),
      pidFile: join(directory, "bridge.pid"),
      serverUrl: "http://localhost:3000",
      capabilitySurface: "full-agent",
      spawnProcess: spawnProcess as never,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          CCD_SERVER_URL: "http://localhost:3000",
          CCD_SPOOL: join(directory, "omkar.spool"),
        }),
      }),
    );
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "--codex-app-server",
    ]));
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "--capability-surface",
      "full-agent",
    ]));
  });

  it("introduces team agents after the bridge connects", () => {
    expect(formatTeamAgentWelcome({
      team: { id: "team-1", name: "Research" },
      agents: [
        {
          principalId: "peer-1",
          handle: "alex",
          displayName: "Alex Chen",
          teamRole: "member",
          relationships: ["team"],
          role: "Engineering",
          connectionState: "contact",
          availability: "unknown",
          agentCard: {
            name: "Alex Engineering Agent",
            description: "Checks technical feasibility.",
            supportedInterfaces: [],
            provider: { organization: "Aicoo", url: "https://www.aicoo.io" },
            version: "1.0.0",
            capabilities: {},
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [{
              id: "feasibility",
              name: "Technical feasibility",
              description: "Checks technical feasibility.",
              tags: ["engineering"],
            }],
          },
          accessibleResources: [],
          authorityBoundaries: [],
        },
      ],
    })).toEqual([
      "Bridge connected. Here are your Team and connected friend agents:",
      "- Alex Engineering Agent [Team] — Alex Chen's agent (Engineering; contact) — Technical feasibility",
      "Give me a task, or tell me whose agent you want to connect with.",
    ]);
  });

  it("avoids a cold-start dead end when no teammate agent exists yet", () => {
    expect(formatTeamAgentWelcome({
      team: { id: "team-1", name: "Research" },
      agents: [],
    })).toContain("The first task plan will still be created locally.");
  });

  it("introduces accepted friend agents even when the owner has no Team", () => {
    const output = formatTeamAgentWelcome({
      team: null,
      agents: [
        {
          principalId: "friend-1",
          handle: "sam",
          displayName: "Sam Lee",
          relationships: ["friend"],
          role: "Designer",
          connectionState: "connected",
          availability: "available",
          agentCard: {
            name: "Sam's agent",
            description: "Design collaboration",
            supportedInterfaces: [],
            provider: { organization: "Aicoo", url: "https://www.aicoo.io" },
            version: "1.0.0",
            capabilities: {},
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [],
          },
          accessibleResources: [],
          authorityBoundaries: [],
        },
      ],
    });

    expect(output[0]).toBe("Bridge connected. Here are your Team and connected friend agents:");
    expect(output[1]).toContain("Sam's agent [Friend]");
  });

  it("labels a peer discovered through both relationships only once", () => {
    const output = formatTeamAgentWelcome({
      team: { id: "team-1", name: "Research" },
      agents: [
        {
          principalId: "peer-1",
          handle: "sam",
          displayName: "Sam Lee",
          teamRole: "member",
          relationships: ["team", "friend"],
          role: "Engineering",
          connectionState: "connected",
          availability: "away",
          agentCard: {
            name: "Sam's agent",
            description: "Engineering collaboration",
            supportedInterfaces: [],
            provider: { organization: "Aicoo", url: "https://www.aicoo.io" },
            version: "1.0.0",
            capabilities: {},
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [],
          },
          accessibleResources: [],
          authorityBoundaries: [],
        },
      ],
    });

    expect(output.filter((line) => line.includes("Sam's agent"))).toEqual([
      "- Sam's agent [Team + Friend] — Sam Lee's agent (Engineering; connected, away) — Engineering collaboration",
    ]);
  });
});
