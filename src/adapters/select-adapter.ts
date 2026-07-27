import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { RuntimeKind } from "../shared/contracts.js";
import { ClaudeCodeAdapter } from "./claude-code/claude-code-adapter.js";
import { CodexAdapter } from "./codex/codex-adapter.js";
import { FakeRuntimeAdapter } from "./fake/fake-adapter.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

export type RuntimeAdapterKind = "fake" | "claude-code" | "codex";

export interface RuntimeAdapterSelectionOptions {
  kind: RuntimeAdapterKind;
  sessions: number;
  fakeBusy?: boolean;
  spoolFile: string;
  workspace: string;
  claudeStateFile?: string;
  claudePath?: string;
  codexStateFile?: string;
  codexPath?: string;
  model?: string;
  log?: (line: string) => void;
}

export interface RuntimeAdapterSelection {
  adapter: RuntimeAdapter;
  adapterVersion: string;
  runtime: RuntimeKind;
  label: string;
}

export async function selectRuntimeAdapter(
  options: RuntimeAdapterSelectionOptions,
): Promise<RuntimeAdapterSelection> {
  if (!Number.isInteger(options.sessions) || options.sessions < 1) {
    throw new Error("--sessions must be a positive integer");
  }
  if (options.kind === "fake") {
    const adapter = new FakeRuntimeAdapter(options.sessions);
    if (options.fakeBusy) adapter.setBusy("fake-session-1");
    return {
      adapter,
      adapterVersion: FakeRuntimeAdapter.adapterVersion,
      runtime: "claude-code",
      label: "[MOCK: FakeRuntimeAdapter]",
    };
  }

  if (options.kind === "codex") {
    const explicitPath = options.codexPath ? resolve(options.codexPath) : undefined;
    if (explicitPath && !(await isExecutable(explicitPath))) {
      throw new Error(`codex executable is not executable: ${explicitPath}`);
    }
    const configuredPath = explicitPath ?? await findExecutableOnPath("codex");
    if (!configuredPath) {
      throw new Error("codex executable not found on PATH; install codex or pass --codex-path");
    }
    const adapter = new CodexAdapter({
      stateFile: resolve(options.codexStateFile ?? `${options.spoolFile}.codex.db`),
      cwd: resolve(options.workspace),
      sessionCount: options.sessions,
      codexPath: configuredPath,
      ...(options.model ? { model: options.model } : {}),
      log: options.log,
    });
    return {
      adapter,
      adapterVersion: CodexAdapter.adapterVersion,
      runtime: "codex",
      label: `CodexAdapter (${configuredPath})`,
    };
  }

  const explicitPath = options.claudePath ? resolve(options.claudePath) : undefined;
  if (explicitPath && !(await isExecutable(explicitPath))) {
    throw new Error(`Claude Code executable is not executable: ${explicitPath}`);
  }
  const configuredPath = explicitPath ?? await findExecutableOnPath("claude");
  const adapter = new ClaudeCodeAdapter({
    stateFile: resolve(options.claudeStateFile ?? `${options.spoolFile}.claude.db`),
    cwd: resolve(options.workspace),
    sessionCount: options.sessions,
    ...(configuredPath ? { pathToClaudeCodeExecutable: configuredPath } : {}),
    ...(options.model ? { model: options.model } : {}),
    log: options.log,
  });
  return {
    adapter,
    adapterVersion: ClaudeCodeAdapter.adapterVersion,
    runtime: "claude-code",
    label: `ClaudeCodeAdapter${configuredPath ? ` (${configuredPath})` : " (SDK bundled CLI)"}`,
  };
}

export async function findClaudeCodeExecutable(): Promise<string | undefined> {
  return findExecutableOnPath("claude");
}

async function findExecutableOnPath(name: string): Promise<string | undefined> {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = executableNames(name);
  for (const directory of directories) {
    for (const executableName of names) {
      const candidate = resolve(directory, executableName);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Windows npm installs both an extensionless POSIX shim and native Windows
 * launchers in the same PATH directory. Never select the extensionless shim on
 * Windows: child_process cannot execute it there. Prefer a native executable,
 * then command shims supported by the Codex driver.
 */
export function executableNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== "win32") return [name];

  const supported = new Set([".exe", ".cmd", ".bat"]);
  const configured = (pathExt ?? "")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => supported.has(extension));
  const extensions = [...configured, ".exe", ".cmd", ".bat"]
    .filter((extension, index, all) => all.indexOf(extension) === index);
  return extensions.map((extension) => `${name}${extension}`);
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
