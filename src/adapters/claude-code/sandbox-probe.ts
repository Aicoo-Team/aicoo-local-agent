import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

export interface ClaudeSandboxProbeInput {
  platform?: NodeJS.Platform;
  findExecutable?: (name: string) => Promise<string | undefined>;
  run?: (command: string, args: string[]) => { status: number | null; stderr: string };
}

/** Validates external Linux prerequisites before Claude may advertise full-agent readiness. */
export async function verifyClaudeFullAgentSandbox(input: ClaudeSandboxProbeInput = {}): Promise<void> {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") return;
  if (platform !== "linux") {
    throw new Error(`Claude Code governed sandbox is unavailable on ${platform}`);
  }
  const findExecutable = input.findExecutable ?? findOnPath;
  const bwrap = await findExecutable("bwrap");
  if (!bwrap) throw new Error("Claude Code full-agent requires bubblewrap (bwrap) on Linux and WSL2");
  const socat = await findExecutable("socat");
  if (!socat) throw new Error("Claude Code full-agent requires socat on Linux and WSL2");
  const result = (input.run ?? runBubblewrap)(bwrap, [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--",
    "/bin/true",
  ]);
  if (result.status !== 0) {
    throw new Error(`Claude Code full-agent sandbox probe failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function runBubblewrap(command: string, args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
