import { describe, expect, it } from "vitest";
import { evaluateRuntimePlatformReadiness } from "../../src/shared/runtime-platform-readiness.js";

describe("full-agent runtime platform readiness", () => {
  it("rejects native Windows Claude because its required sandbox is unavailable", () => {
    expect(evaluateRuntimePlatformReadiness("claude-code", "win32", "10.0.26100")).toEqual({
      ready: false,
      reason: "Claude Code full-agent requires macOS, Linux, or WSL2; native Windows sandboxing is unavailable",
    });
  });

  it("accepts Claude on macOS and WSL2 but rejects WSL1", () => {
    expect(evaluateRuntimePlatformReadiness("claude-code", "darwin", "24.6.0")).toEqual({ ready: true });
    expect(evaluateRuntimePlatformReadiness("claude-code", "linux", "5.15.153.1-microsoft-standard-WSL2"))
      .toEqual({ ready: true });
    expect(evaluateRuntimePlatformReadiness("claude-code", "linux", "4.4.0-19041-Microsoft"))
      .toEqual({ ready: false, reason: "Claude Code full-agent requires WSL2; WSL1 sandboxing is unavailable" });
  });

  it("allows Codex to proceed to its executable sandbox probe on macOS and Windows", () => {
    expect(evaluateRuntimePlatformReadiness("codex", "darwin", "24.6.0")).toEqual({ ready: true });
    expect(evaluateRuntimePlatformReadiness("codex", "win32", "10.0.26100")).toEqual({ ready: true });
  });
});
