import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexSpawnCommand } from "./driver.js";
import { writeCodexPermissionProfile } from "./permission-profile.js";

export interface CodexSandboxProbeInput {
  codexPath: string;
  platform?: NodeJS.Platform;
  run?: (input: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }) => { status: number | null; stdout: string; stderr: string };
}

const PROBE_PREFIX = "AICOO_CODEX_SANDBOX_PROBE:";
const POSIX_PROBE_SCRIPT = [
  'inside_write=false; printf "inside-ok" > "$1" 2>/dev/null && inside_write=true',
  'outside_read=false; cat "$2" >/dev/null 2>&1 && outside_read=true',
  'outside_write=false; printf "outside-bad" > "$3" 2>/dev/null && outside_write=true',
  `printf '${PROBE_PREFIX}{"insideWrite":%s,"outsideRead":%s,"outsideWrite":%s}' "$inside_write" "$outside_read" "$outside_write"`,
].join("; ");

const WINDOWS_PROBE_SCRIPT = [
  "$insideWrite=$false; try { Set-Content -LiteralPath $args[0] -Value 'inside-ok' -ErrorAction Stop; $insideWrite=$true } catch {}",
  "$outsideRead=$false; try { Get-Content -LiteralPath $args[1] -ErrorAction Stop | Out-Null; $outsideRead=$true } catch {}",
  "$outsideWrite=$false; try { Set-Content -LiteralPath $args[2] -Value 'outside-bad' -ErrorAction Stop; $outsideWrite=$true } catch {}",
  `$report=@{insideWrite=$insideWrite;outsideRead=$outsideRead;outsideWrite=$outsideWrite}|ConvertTo-Json -Compress; Write-Output ('${PROBE_PREFIX}'+$report)`,
].join("; ");

/** Executes a real permission profile before full-agent readiness is registered. */
export async function verifyCodexFullAgentSandbox(input: CodexSandboxProbeInput): Promise<void> {
  const platform = input.platform ?? process.platform;
  const root = mkdtempSync(join(tmpdir(), "aicoo-codex-sandbox-probe-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside-secret.txt");
    const outsideWrite = join(root, "outside-write.txt");
    const inside = join(project, "inside-write.txt");
    mkdirSync(project, { mode: 0o700 });
    writeFileSync(outside, "must-not-read", { mode: 0o600 });
    const probeCommand = platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "/bin/sh";
    const profile = writeCodexPermissionProfile(join(root, "codex-home"), {
      preset: "edit-project",
      folders: [project],
      writableFolders: [project],
      platform,
      runtimeExecutable: probeCommand,
      authFile: join(root, "missing-auth.json"),
    });
    if (!profile) throw new Error("Codex governed sandbox probe could not create a permission profile");
    const args = [
      "sandbox",
      "-P",
      profile.profileName,
      "-C",
      project,
      "--",
      probeCommand,
      ...(platform === "win32"
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE_SCRIPT]
        : ["-c", POSIX_PROBE_SCRIPT, "aicoo-sandbox-probe"]),
      inside,
      outside,
      outsideWrite,
    ];
    const spawnInput = buildCodexSpawnCommand(input.codexPath, args, platform);
    const result = (input.run ?? runProbe)({
      ...spawnInput,
      env: { ...process.env, ...profile.environment, CODEX_HOME: profile.codexHome },
    });
    if (result.status !== 0) {
      throw new Error(`Codex governed sandbox probe failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
    }
    const marker = result.stdout.lastIndexOf(PROBE_PREFIX);
    if (marker < 0) throw new Error("Codex governed sandbox probe returned no attestation");
    const report = JSON.parse(result.stdout.slice(marker + PROBE_PREFIX.length)) as {
      insideWrite?: boolean;
      outsideRead?: boolean;
      outsideWrite?: boolean;
    };
    if (!report.insideWrite || report.outsideRead || report.outsideWrite) {
      throw new Error("Codex governed sandbox probe could not enforce the project boundary");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runProbe(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(input.command, input.args, {
    env: input.env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    windowsVerbatimArguments: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
