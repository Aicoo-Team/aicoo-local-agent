import { describe, expect, it, vi } from "vitest";
import { verifyCodexFullAgentSandbox } from "../../src/adapters/codex/sandbox-probe.js";

describe("Codex governed sandbox probe", () => {
  it("accepts only an attestation that writes inside and blocks outside access", async () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: 'AICOO_CODEX_SANDBOX_PROBE:{"insideWrite":true,"outsideRead":false,"outsideWrite":false}',
      stderr: "",
    }));

    await expect(verifyCodexFullAgentSandbox({ codexPath: "/bin/codex", run }))
      .resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(["sandbox", "-P", "aicoo-c2c"]),
      env: expect.objectContaining({ CODEX_HOME: expect.any(String) }),
    }));
  });

  it.each([
    { insideWrite: false, outsideRead: false, outsideWrite: false },
    { insideWrite: true, outsideRead: true, outsideWrite: false },
    { insideWrite: true, outsideRead: false, outsideWrite: true },
  ])("fails closed for an unsafe report: %j", async (report) => {
    await expect(verifyCodexFullAgentSandbox({
      codexPath: "/bin/codex",
      run: () => ({
        status: 0,
        stdout: `AICOO_CODEX_SANDBOX_PROBE:${JSON.stringify(report)}`,
        stderr: "",
      }),
    })).rejects.toThrow("could not enforce the project boundary");
  });

  it("fails closed when the sandbox command cannot start", async () => {
    await expect(verifyCodexFullAgentSandbox({
      codexPath: "/bin/codex",
      run: () => ({ status: 1, stdout: "", stderr: "sandbox unavailable" }),
    })).rejects.toThrow("sandbox unavailable");
  });
});
