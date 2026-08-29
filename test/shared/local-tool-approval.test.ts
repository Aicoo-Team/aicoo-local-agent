import { describe, expect, it, vi } from "vitest";
import { LocalToolApprovalGateway } from "../../src/shared/local-tool-approval.js";

const request = {
  communicationSessionId: "comm-1",
  sessionHandle: "session-1",
  toolName: "Bash",
  toolInputSummary: "Bash npm test",
};

describe("localhost tool approval", () => {
  it.each([
    ["y", "once"],
  ] as const)("allows %s with %s scope", async (answer, scope) => {
    const gateway = new LocalToolApprovalGateway({ prompt: async () => answer });

    const result = await gateway.requestToolApproval(request);

    expect(result).toMatchObject({ status: "allow", decision: "allow", scope });
    await expect(gateway.getToolApproval(result.approvalId)).resolves.toEqual(result);
  });

  it("limits high-risk tools to allow-once even when session approval is requested", async () => {
    const gateway = new LocalToolApprovalGateway({ prompt: async () => "session" });

    await expect(gateway.requestToolApproval(request)).resolves.toMatchObject({
      status: "allow",
      decision: "allow",
      scope: "once",
    });
  });

  it("allows session scope for bounded filesystem tools", async () => {
    const gateway = new LocalToolApprovalGateway({ prompt: async () => "session" });

    await expect(gateway.requestToolApproval({ ...request, toolName: "Read" })).resolves.toMatchObject({
      status: "allow",
      decision: "allow",
      scope: "session",
    });
  });

  it("denies by default", async () => {
    const gateway = new LocalToolApprovalGateway({ prompt: async () => "" });
    await expect(gateway.requestToolApproval(request)).resolves.toMatchObject({
      status: "deny",
      decision: "deny",
      scope: "once",
    });
  });

  it("does not pretend a terminal answer can activate a wider kernel boundary", async () => {
    const prompt = vi.fn(async () => "y");
    const gateway = new LocalToolApprovalGateway({ prompt });

    await expect(gateway.requestToolApproval({
      ...request,
      boundaryExpansion: {
        continuationId: "cont-1",
        attemptId: "attempt-1",
        resourceKind: "filesystem",
        canonicalResource: "/outside/project",
        requestedAccessPreset: "read-project",
        requiresSessionRebuild: true,
      },
    })).resolves.toMatchObject({ status: "unsupported", decision: "deny" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("serializes concurrent prompts so terminal questions cannot overlap", async () => {
    const releases: Array<() => void> = [];
    const prompt = vi.fn(() => new Promise<string>((resolve) => releases.push(() => resolve("y"))));
    const gateway = new LocalToolApprovalGateway({ prompt });

    const first = gateway.requestToolApproval(request);
    const second = gateway.requestToolApproval({ ...request, toolName: "Read" });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    releases.shift()?.();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
