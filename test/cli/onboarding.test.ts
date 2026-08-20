import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeDevice,
  formatTeamAgentWelcome,
  nodeMeetsMinimumVersion,
  readRunningProcessId,
  waitForBridgeReady,
  type DeviceAuthorizationClient,
} from "../../src/cli/onboarding.js";
import { ApiError } from "../../src/shared/http-client.js";

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

  it("introduces team agents after the bridge connects", () => {
    expect(formatTeamAgentWelcome({
      team: { id: "team-1", name: "Research" },
      agents: [
        {
          principalId: "peer-1",
          handle: "alex",
          displayName: "Alex Chen",
          teamRole: "member",
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
      "Bridge connected. Here are the agents in Research and what they can help with:",
      "- Alex Engineering Agent — Alex Chen's agent (Engineering; contact) — Technical feasibility",
      "Give me a task, or tell me whose agent you want to connect with.",
    ]);
  });

  it("avoids a cold-start dead end when no teammate agent exists yet", () => {
    expect(formatTeamAgentWelcome({
      team: { id: "team-1", name: "Research" },
      agents: [],
    })).toContain("No other team agents are available yet. The first task plan will still be created locally.");
  });
});
