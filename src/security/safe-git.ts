import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type GitToolName = "GitStatus" | "GitDiff" | "GitLog" | "GitAdd" | "GitCommit";

export interface SafeGitOperation {
  toolName: GitToolName;
  repository: string;
  args: string[];
  summary: string;
}

const READ_TOOLS = new Set<GitToolName>(["GitStatus", "GitDiff", "GitLog"]);
const FORBIDDEN_SHELL_CHARACTERS = /[\n\r;&|<>`$]/u;

export function isGitToolName(value: string): value is GitToolName {
  return ["GitStatus", "GitDiff", "GitLog", "GitAdd", "GitCommit"].includes(value);
}

export function parseSafeGitCommand(command: string, cwd: string): SafeGitOperation | undefined {
  if (!command.trim() || FORBIDDEN_SHELL_CHARACTERS.test(command)) return undefined;
  const tokens = tokenize(command);
  if (!tokens || tokens[0] !== "git") return undefined;
  let index = 1;
  let repository = cwd;
  if (tokens[index] === "-C") {
    const requested = tokens[index + 1];
    if (!requested) return undefined;
    repository = isAbsolute(requested) ? requested : resolve(cwd, requested);
    index += 2;
  }
  const subcommand = tokens[index++];
  const rest = tokens.slice(index);
  if (!subcommand) return undefined;
  if (subcommand === "status" && rest.every(isStatusArgument)) {
    return operation("GitStatus", repository, ["status", ...rest]);
  }
  if (subcommand === "diff" && isSafeDiffArguments(rest)) {
    return operation("GitDiff", repository, ["diff", "--no-ext-diff", "--no-textconv", ...rest]);
  }
  if (subcommand === "log" && isSafeLogArguments(rest)) {
    return operation("GitLog", repository, ["log", ...rest]);
  }
  if (subcommand === "add" && isSafeAddArguments(rest)) {
    const paths = rest[0] === "--" ? rest.slice(1) : rest;
    return operation("GitAdd", repository, ["add", "--", ...paths]);
  }
  if (subcommand === "commit" && rest.length === 2 && rest[0] === "-m" && Boolean(rest[1]?.trim())) {
    return operation("GitCommit", repository, ["commit", "--no-verify", "--no-gpg-sign", "-m", rest[1]!]);
  }
  return undefined;
}

export function safeGitOperation(input: {
  toolName: GitToolName;
  repository: string;
  staged?: boolean;
  paths?: string[];
  maxCount?: number;
  message?: string;
}): SafeGitOperation | undefined {
  const repository = input.repository;
  if (input.toolName === "GitStatus") return operation(input.toolName, repository, ["status", "--short", "--branch"]);
  if (input.toolName === "GitDiff") {
    const paths = cleanPaths(input.paths);
    if (input.paths && !paths) return undefined;
    return operation(input.toolName, repository, [
      "diff", "--no-ext-diff", "--no-textconv",
      ...(input.staged ? ["--staged"] : []),
      ...(paths?.length ? ["--", ...paths] : []),
    ]);
  }
  if (input.toolName === "GitLog") {
    const maxCount = Math.min(Math.max(Math.trunc(input.maxCount ?? 20), 1), 100);
    return operation(input.toolName, repository, [
      "log", "--no-ext-diff", "--no-textconv", "--oneline", `--max-count=${maxCount}`,
    ]);
  }
  if (input.toolName === "GitAdd") {
    const paths = cleanPaths(input.paths);
    if (!paths?.length) return undefined;
    return operation(input.toolName, repository, ["add", "--", ...paths]);
  }
  if (input.toolName === "GitCommit") {
    const message = input.message?.trim();
    if (!message || message.length > 500 || /[\r\n]/u.test(message)) return undefined;
    return operation(input.toolName, repository, ["commit", "--no-verify", "--no-gpg-sign", "-m", message]);
  }
  return undefined;
}

export function executeSafeGit(operation: SafeGitOperation): string {
  const repository = canonical(operation.repository);
  validatePathArguments(repository, operation);
  if (operation.toolName === "GitAdd") {
    return stageFilesWithoutFilters(repository, operation.args.slice(2), process.platform);
  }
  const output = execFileSync(
    "git",
    [...secureGitPrefix(repository, process.platform), ...operation.args],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_000_000,
      env: gitEnvironment(operation.toolName, process.platform),
    },
  );
  return output.slice(0, 128_000);
}

export function safeGitShellInput(
  operation: SafeGitOperation,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const repository = canonical(operation.repository);
  validatePathArguments(repository, operation);
  if (operation.toolName === "GitAdd") {
    const commands = operation.args.slice(2).map((path) => {
      const mode = safeFileMode(repository, path);
      const hash = gitShell(repository, ["hash-object", "-w", "--no-filters", "--", path], platform);
      const updatePrefix = [
        "git", ...secureGitPrefix(repository, platform), "update-index", "--add", "--cacheinfo", mode,
      ].map(shellQuote).join(" ");
      return `oid=$(${hash}) && ${shellEnvironment(platform)} ${updatePrefix} "$oid" ${shellQuote(path)}`;
    });
    return { command: commands.map((command) => `(${command})`).join(" && ") };
  }
  return { command: gitShell(repository, operation.args, platform) };
}

function operation(toolName: GitToolName, repository: string, args: string[]): SafeGitOperation {
  return { toolName, repository, args, summary: `${toolName} ${repository}` };
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote) return undefined;
  if (started) tokens.push(token);
  return tokens;
}

function isStatusArgument(value: string): boolean {
  return ["--short", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2",
    "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"].includes(value);
}

function isSafeDiffArguments(args: string[]): boolean {
  let paths = false;
  return args.every((value) => {
    if (paths) return isSafeRelativePath(value);
    if (value === "--") {
      paths = true;
      return true;
    }
    return ["--staged", "--cached", "--stat", "--name-only", "--name-status"].includes(value);
  });
}

function isSafeLogArguments(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (["--oneline", "--decorate", "--stat"].includes(value)) continue;
    if (/^--max-count=\d{1,3}$/u.test(value)) continue;
    if (value === "-n" && /^\d{1,3}$/u.test(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isSafeAddArguments(args: string[]): boolean {
  const paths = args[0] === "--" ? args.slice(1) : args;
  return paths.length > 0 && paths.every(isSafeRelativePath);
}

function cleanPaths(paths: string[] | undefined): string[] | undefined {
  if (!paths) return [];
  const clean = paths.map((value) => value.trim()).filter(Boolean);
  return clean.length === paths.length && clean.every(isSafeRelativePath) ? clean : undefined;
}

function isSafeRelativePath(value: string): boolean {
  return Boolean(value) && !isAbsolute(value) && !/^\.\.(?:[\\/]|$)/u.test(value) && !value.startsWith("-");
}

function validatePathArguments(repository: string, operation: SafeGitOperation): void {
  const marker = operation.args.indexOf("--");
  if (marker < 0) return;
  for (const path of operation.args.slice(marker + 1)) {
    if (path === ".") continue;
    const candidate = resolve(repository, path);
    const rel = relative(repository, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Git path is outside the approved repository");
    }
  }
}

function stageFilesWithoutFilters(
  repository: string,
  paths: string[],
  platform: NodeJS.Platform,
): string {
  for (const path of paths) {
    const mode = safeFileMode(repository, path);
    const oid = execFileSync(
      "git",
      [...secureGitPrefix(repository, platform), "hash-object", "-w", "--no-filters", "--", path],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 128_000,
        env: gitEnvironment("GitAdd", platform),
      },
    ).trim();
    execFileSync(
      "git",
      [...secureGitPrefix(repository, platform), "update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 128_000,
        env: gitEnvironment("GitAdd", platform),
      },
    );
  }
  return "";
}

function safeFileMode(repository: string, path: string): "100644" | "100755" {
  const stat = lstatSync(resolve(repository, path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GitAdd supports regular files only");
  return stat.mode & 0o111 ? "100755" : "100644";
}

function secureGitPrefix(repository: string, platform: NodeJS.Platform): string[] {
  return [
    "-c", `core.hooksPath=${nullDevice(platform)}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
    "-C", repository,
  ];
}

function gitShell(repository: string, args: string[], platform: NodeJS.Platform): string {
  const command = ["git", ...secureGitPrefix(repository, platform), ...args].map(shellQuote).join(" ");
  return `${shellEnvironment(platform)} ${command}`;
}

function gitEnvironment(toolName: GitToolName, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(platform),
    GIT_OPTIONAL_LOCKS: READ_TOOLS.has(toolName) ? "0" : "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function shellEnvironment(platform: NodeJS.Platform): string {
  return [
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_CONFIG_GLOBAL", nullDevice(platform)],
    ["GIT_TERMINAL_PROMPT", "0"],
  ].map(([name, value]) => `${name}=${shellQuote(value!)}`).join(" ");
}

function nullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

function canonical(path: string): string {
  return realpathSync.native(resolve(path));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
