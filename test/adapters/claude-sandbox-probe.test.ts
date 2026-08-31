import { describe, expect, it, vi } from "vitest";
import { verifyClaudeFullAgentSandbox } from "../../src/adapters/claude-code/sandbox-probe.js";

describe("Claude governed sandbox prerequisites", () => {
  it("uses the built-in Seatbelt sandbox on macOS", async () => {
    const findExecutable = vi.fn();
    const run = vi.fn();

    await expect(verifyClaudeFullAgentSandbox({ platform: "darwin", findExecutable, run }))
      .resolves.toBeUndefined();
    expect(findExecutable).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("requires bubblewrap and socat on Linux and WSL2", async () => {
    await expect(verifyClaudeFullAgentSandbox({
      platform: "linux",
      findExecutable: async (name) => name === "bwrap" ? "/usr/bin/bwrap" : undefined,
      run: () => ({ status: 0, stderr: "" }),
    })).rejects.toThrow("socat");
  });

  it("fails closed when bubblewrap cannot create an isolated process", async () => {
    await expect(verifyClaudeFullAgentSandbox({
      platform: "linux",
      findExecutable: async (name) => `/usr/bin/${name}`,
      run: () => ({ status: 1, stderr: "user namespaces denied" }),
    })).rejects.toThrow("user namespaces denied");
  });
});
