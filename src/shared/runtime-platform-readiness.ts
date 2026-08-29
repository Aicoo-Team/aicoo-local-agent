export type GovernedRuntime = "claude-code" | "codex";

export type RuntimePlatformReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/** Platform gate evaluated before a bridge may advertise the governed-agent surface. */
export function evaluateRuntimePlatformReadiness(
  runtime: GovernedRuntime,
  platform: NodeJS.Platform = process.platform,
  osRelease = "",
): RuntimePlatformReadiness {
  if (runtime === "codex") return { ready: true };
  if (platform === "win32") {
    return {
      ready: false,
      reason: "Claude Code full-agent requires macOS, Linux, or WSL2; native Windows sandboxing is unavailable",
    };
  }
  const normalizedRelease = osRelease.toLowerCase();
  if (platform === "linux" && normalizedRelease.includes("microsoft") && !normalizedRelease.includes("wsl2")) {
    return {
      ready: false,
      reason: "Claude Code full-agent requires WSL2; WSL1 sandboxing is unavailable",
    };
  }
  if (platform === "darwin" || platform === "linux") return { ready: true };
  return {
    ready: false,
    reason: `Claude Code full-agent sandboxing is unavailable on ${platform}`,
  };
}
