import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, parse } from "node:path";
import type { RelationshipAccessPreset } from "../../security/relationship-policy.js";
import {
  parseRemoteMcpGrants,
  renderCodexRemoteMcpGrants,
  type RemoteMcpGrantInput,
} from "../../security/mcp-capability-grant.js";

/**
 * Codex permission profiles: kernel-enforced scoping for a c2c relationship.
 *
 * The adapter used to hand Codex no tools at all and instead have it emit JSON describing file
 * operations that we executed after checking the paths ourselves. That put the security boundary
 * in our string comparisons, which is the weakest possible place for it — every finding in the
 * policy review was a path-parsing bug.
 *
 * Codex already ships a stronger boundary. A `[permissions]` profile compiles to a Seatbelt
 * profile on macOS and Landlock+seccomp on Linux, so the kernel refuses out-of-scope access
 * whatever the model was talked into attempting.
 *
 * The two keys that matter, and why `writable_roots` alone is not enough:
 *   `":root" = "deny"`   revokes the root-level read the built-in presets grant. Without it the
 *                        session can read the whole disk — `writable_roots` scopes writes only,
 *                        and readable roots are a separate policy.
 *   `":minimal" = "read"` restores the handful of system paths a process needs to exec at all
 *                        (loader, shell, tool binaries). Omit it and the sandbox aborts with
 *                        SIGABRT before the command runs.
 *
 * Verified against codex-cli 0.146 with `codex sandbox -P <name>`: reads and writes outside the
 * granted folder are refused, `~/.ssh` is refused, commands inside the folder run, and network
 * egress is refused — which is what lets a peer's agent actually do work without being able to
 * send anything out.
 */

export const CODEX_PROFILE_NAME = "aicoo-c2c";

export interface CodexPermissionProfileInput {
  preset: RelationshipAccessPreset;
  /** Absolute folder paths granted for this relationship. */
  folders: readonly string[];
  /** Subset of `folders` that may be modified. All remaining folders stay read-only. */
  writableFolders?: readonly string[];
  profileName?: string;
  /** Override used by tests; defaults to the active Codex login's auth.json. */
  authFile?: string;
  /** Exact relationship grants; never inferred by copying the owner's Codex configuration. */
  mcpServers?: readonly RemoteMcpGrantInput[];
  /** Test seam for platform-specific system-tool dependencies. */
  platform?: NodeJS.Platform;
  /** Test seam; production discovers the active macOS toolchain with xcode-select. */
  developerDirectory?: string;
  /** Private scratch directory for system-tool caches; never shared with the project. */
  runtimeTempDirectory?: string;
  /** Exact Codex launcher used by app-server when it creates its sandbox helper process. */
  runtimeExecutable?: string;
  /** Test seam; production discovers only known language/package-manager launchers on PATH. */
  commandExecutables?: readonly string[];
  /** Test seam for the shell PATH written into the isolated runtime environment. */
  commandSearchPath?: string;
  /** Create a private, deny-by-default runtime even when no project or MCP grant is active. */
  isolateRuntime?: boolean;
  /** Import skill bundles only; plugin manifests, hooks, settings, and MCP config are never copied. */
  includeOwnerSkills?: boolean;
  /** Test seam; production discovers the owner's standard Codex and agent skill roots. */
  ownerSkillRoots?: readonly string[];
  /** Internal path granted read access after sanitized skill import. */
  runtimeSkillsDirectory?: string;
}

const PROJECT_COMMAND_EXECUTABLES = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "bun",
  "deno",
] as const;

/**
 * Plain `chat-only` gets no profile at all. When exact MCP tools are granted, however, it gets a
 * private profile with no workspace roots so Codex can load only those tools without gaining
 * project access or inheriting the owner's settings.
 */
export function renderCodexPermissionProfile(input: CodexPermissionProfileInput): string | undefined {
  const mcpServers = parseRemoteMcpGrants(input.mcpServers ?? []);
  if (input.preset === "chat-only" && mcpServers.length === 0 && !input.isolateRuntime) return undefined;
  const folders = input.preset === "chat-only"
    ? []
    : [...new Set(input.folders)].filter((folder) => folder.trim().length > 0);
  if (folders.length === 0 && mcpServers.length === 0 && !input.isolateRuntime) return undefined;

  const name = input.profileName ?? CODEX_PROFILE_NAME;
  // read-project may only read; edit-project may also write. Codex resolves "deny" ahead of any
  // broader grant, so ":root" = "deny" survives the more specific workspace-root entry below.
  const requestedWritable = input.writableFolders
    ?? (input.preset === "edit-project" ? folders : []);
  const folderSet = new Set(folders);
  const writableFolders = [...new Set(requestedWritable)].filter((folder) => folderSet.has(folder));
  const writable = writableFolders.length > 0;
  const base = writable ? ":workspace" : ":read-only";
  const workspaceAccess = writableFolders.length === folders.length ? "write" : "read";
  const mcpConfig = renderCodexRemoteMcpGrants(mcpServers);
  const shellEnvironmentExclusions = [...new Set([
    "*TOKEN*",
    "*SECRET*",
    "*PASSWORD*",
    "*PASSWD*",
    "*API_KEY*",
    "*PRIVATE_KEY*",
    "DATABASE_URL",
    ...mcpServers.flatMap((server) => server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []),
  ])];
  const developerDirectory = folders.length > 0 ? resolveDeveloperDirectory(input) : undefined;
  const runtimeTempDirectory = folders.length > 0 ? input.runtimeTempDirectory : undefined;
  // app-server launches its sandbox helper through the Codex executable even for a zero-grant
  // thread. Keep that exact launcher/runtime readable inside every isolated profile; otherwise
  // the private home fails before a model turn can start.
  const runtimeExecutablePaths = resolveRuntimeExecutablePaths(input.runtimeExecutable);
  const commandRuntimePaths = folders.length > 0
    ? resolveCommandExecutablePaths(input.commandExecutables ?? [], input.platform ?? process.platform)
    : [];
  const gitConfigGlobal = nullDevice(input.platform ?? process.platform);
  const shellEnvironment = runtimeTempDirectory
    ? shellEnvironmentValues(input, runtimeTempDirectory, gitConfigGlobal, developerDirectory)
    : undefined;

  return [
    `default_permissions = ${tomlString(name)}`,
    // The private home must not fall back to owner OAuth stored in a system keyring. A granted
    // server either uses its named bearer environment variable or connects without credentials.
    'mcp_oauth_credentials_store = "file"',
    "",
    "[features]",
    // Account-backed plugins/apps can be reported as installed even with a fresh CODEX_HOME.
    // Disable their runtime injection explicitly; sanitized skills and exact relationship MCP
    // grants below are the only capability sources this session receives.
    "plugins = false",
    "apps = false",
    "remote_plugin = false",
    "hooks = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[memories]",
    "disable_on_external_context = true",
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    `exclude = [${shellEnvironmentExclusions.map(tomlString).join(", ")}]`,
    ...(shellEnvironment ? [
      `set = { ${Object.entries(shellEnvironment).map(([name, value]) => `${name} = ${tomlString(value)}`).join(", ")} }`,
    ] : []),
    "",
    `[permissions.${name}]`,
    `description = "Aicoo c2c relationship (${input.preset})"`,
    `extends = "${base}"`,
    "",
    ...(folders.length > 0 ? [
      `[permissions.${name}.workspace_roots]`,
      ...folders.map((folder) => `${tomlString(folder)} = true`),
      "",
    ] : []),
    `[permissions.${name}.filesystem]`,
    // Order matters far less than presence: deny the root read the preset would otherwise grant,
    // then add back only what a process needs to start.
    '":root" = "deny"',
    '":minimal" = "read"',
    ...(developerDirectory ? [`${tomlString(developerDirectory)} = "read"`] : []),
    ...runtimeExecutablePaths.map((path) => `${tomlString(path)} = "read"`),
    ...commandRuntimePaths.map((path) => `${tomlString(path)} = "read"`),
    ...(runtimeTempDirectory ? [`${tomlString(runtimeTempDirectory)} = "write"`] : []),
    ...(input.runtimeSkillsDirectory ? [`${tomlString(input.runtimeSkillsDirectory)} = "read"`] : []),
    ...writableFolders.map((folder) => `${tomlString(folder)} = "write"`),
    "",
    ...(folders.length > 0 ? [
      `[permissions.${name}.filesystem.":workspace_roots"]`,
      `"." = "${workspaceAccess}"`,
      "",
    ] : []),
    `[permissions.${name}.network]`,
    // Off for every preset. A peer's agent that can read your files and reach the network can
    // copy them out; keeping egress closed is what makes granting a folder a bounded decision.
    "enabled = false",
    "",
    ...(mcpConfig ? [mcpConfig, ""] : []),
  ].join("\n");
}

function resolveRuntimeExecutablePaths(executable: string | undefined): string[] {
  if (!executable?.trim()) return [];
  const configured = executable.trim();
  if (!existsSync(configured)) return [];
  try {
    const target = realpathSync.native(configured);
    // macOS Seatbelt needs directory traversal permission before execvp can reach an
    // otherwise-readable file. Keep this narrow: grant only each executable's direct
    // parent plus the configured launcher and resolved target, never an ancestor tree.
    return [...new Set([dirname(configured), configured, dirname(target), target])];
  } catch {
    return [dirname(configured), configured];
  }
}

function resolveCommandExecutablePaths(
  executables: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const paths = new Set<string>();
  for (const executable of executables) {
    if (!executable.trim() || !existsSync(executable)) continue;
    const configured = executable.trim();
    paths.add(dirname(configured));
    paths.add(configured);
    try {
      const target = realpathSync.native(configured);
      paths.add(dirname(target));
      paths.add(target);
      if (/^node(?:\.exe)?$/iu.test(basename(configured)) && basename(dirname(target)) === "bin") {
        // Dynamically linked Node distributions keep libnode and ICU data beside bin/. Grant the
        // exact versioned runtime root, not the package-manager prefix or the owner's home.
        paths.add(dirname(dirname(target)));
        if (platform === "darwin") {
          for (const dependency of macDynamicLibraryPaths(target)) paths.add(dependency);
        }
      }
      const packageRoot = nearestPackageRoot(target);
      if (packageRoot) paths.add(packageRoot);
    } catch {
      // The launcher and its direct directory remain the narrow fail-closed grant.
    }
  }
  return [...paths];
}

function macDynamicLibraryPaths(executable: string): string[] {
  const paths = new Set<string>();
  const pending = [executable];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < 64) {
    const binary = pending.shift()!;
    if (visited.has(binary)) continue;
    visited.add(binary);
    let output: string;
    try {
      output = execFileSync("/usr/bin/otool", ["-L", binary], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
    } catch {
      continue;
    }
    for (const line of output.split("\n").slice(1)) {
      const dependency = line.trim().match(/^(\/\S+)\s+\(/u)?.[1];
      if (!dependency || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) {
        continue;
      }
      // dyld resolves Homebrew's formula symlink through the shared `opt` directory first. The
      // formula and canonical Cellar roots below constrain the actual library contents.
      paths.add(dirname(dirname(dirname(dependency))));
      paths.add(dirname(dirname(dependency)));
      paths.add(dirname(dependency));
      paths.add(dependency);
      const formulaRoot = dirname(dirname(dependency));
      if (basename(formulaRoot).startsWith("openssl@")) {
        const homebrewPrefix = dirname(dirname(formulaRoot));
        paths.add(join(homebrewPrefix, "etc", basename(formulaRoot)));
      }
      if (!existsSync(dependency)) continue;
      try {
        const target = realpathSync.native(dependency);
        paths.add(dirname(dirname(target)));
        paths.add(dirname(target));
        paths.add(target);
        pending.push(target);
      } catch {
        // Keep the loader-declared path; dyld will fail closed if it is stale.
      }
    }
  }
  return [...paths];
}

function nearestPackageRoot(target: string): string | undefined {
  let current = dirname(target);
  const filesystemRoot = parse(current).root;
  for (let depth = 0; depth < 6 && current !== filesystemRoot; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    current = dirname(current);
  }
  return undefined;
}

function discoverCommandExecutables(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathValue?.trim()) return [];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const suffixes = platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  const discovered = new Set<string>();
  for (const directory of pathValue.split(pathDelimiter).map((value) => value.trim()).filter(Boolean)) {
    for (const name of PROJECT_COMMAND_EXECUTABLES) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`);
        if (existsSync(candidate)) {
          discovered.add(candidate);
          break;
        }
      }
    }
  }
  return [...discovered];
}

function shellEnvironmentValues(
  input: CodexPermissionProfileInput,
  runtimeTempDirectory: string,
  gitConfigGlobal: string,
  developerDirectory: string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {
    TMPDIR: runtimeTempDirectory,
    NPM_CONFIG_CACHE: join(runtimeTempDirectory, "npm-cache"),
    NPM_CONFIG_USERCONFIG: gitConfigGlobal,
    GIT_CONFIG_GLOBAL: gitConfigGlobal,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if ((input.platform ?? process.platform) === "darwin" && developerDirectory) {
    const developerBin = join(developerDirectory, "usr", "bin");
    const existingPath = input.commandSearchPath ?? process.env.PATH ?? "";
    const entries = existingPath.split(":").filter((entry) => entry && entry !== developerBin);
    values.DEVELOPER_DIR = developerDirectory;
    values.PATH = [developerBin, ...entries].join(":");
  }
  return values;
}

function resolveDeveloperDirectory(input: CodexPermissionProfileInput): string | undefined {
  if ((input.platform ?? process.platform) !== "darwin") return undefined;
  if (input.developerDirectory !== undefined) return input.developerDirectory.trim() || undefined;

  try {
    const selected = execFileSync("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    if (!selected || !existsSync(selected)) return undefined;
    return realpathSync.native(selected);
  } catch {
    return undefined;
  }
}

export interface PreparedCodexProfile {
  /** Value for the CODEX_HOME environment variable of the spawned process. */
  codexHome: string;
  profileName: string;
  workspaceRoots?: string[];
  /** Environment required by platform tools without inheriting owner configuration. */
  environment?: Record<string, string>;
}

/**
 * Materialise the profile into a private CODEX_HOME so the spawned session cannot pick up the
 * machine owner's own Codex config — that config is written for the owner working on their own
 * behalf, and would be the wrong permission set for a remote caller.
 */
export function writeCodexPermissionProfile(
  directory: string,
  input: CodexPermissionProfileInput,
): PreparedCodexProfile | undefined {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const hasProjectAccess = input.preset !== "chat-only"
    && input.folders.some((folder) => folder.trim().length > 0);
  const gitConfigGlobal = nullDevice(input.platform ?? process.platform);
  const runtimeTempDirectory = hasProjectAccess ? join(directory, "tmp") : undefined;
  if (runtimeTempDirectory) {
    mkdirSync(runtimeTempDirectory, { recursive: true, mode: 0o700 });
    chmodSync(runtimeTempDirectory, 0o700);
  }
  const platform = input.platform ?? process.platform;
  const developerDirectory = hasProjectAccess ? resolveDeveloperDirectory(input) : undefined;
  const commandExecutables = hasProjectAccess
    ? input.commandExecutables ?? discoverCommandExecutables(input.commandSearchPath ?? process.env.PATH, platform)
    : [];
  const runtimeSkillsDirectory = input.includeOwnerSkills
    ? importOwnerSkills(directory, input.ownerSkillRoots)
    : undefined;
  const profile = renderCodexPermissionProfile({
    ...input,
    platform,
    commandExecutables,
    ...(developerDirectory ? { developerDirectory } : {}),
    ...(runtimeTempDirectory ? { runtimeTempDirectory } : {}),
    ...(runtimeSkillsDirectory ? { runtimeSkillsDirectory } : {}),
  });
  if (!profile) return undefined;
  writeFileSync(join(directory, "config.toml"), profile, { mode: 0o600 });
  // CODEX_HOME isolates the owner's settings, plugins and MCP configuration, but Codex also
  // locates its login there. Copy only the credential file into the private home; the generated
  // filesystem profile denies the model access to this directory.
  const authFile = input.authFile
    ?? join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  if (existsSync(authFile) && authFile !== join(directory, "auth.json")) {
    copyFileSync(authFile, join(directory, "auth.json"));
    chmodSync(join(directory, "auth.json"), 0o600);
  }
  const environment = runtimeTempDirectory
    ? shellEnvironmentValues(input, runtimeTempDirectory, gitConfigGlobal, developerDirectory)
    : undefined;
  return {
    codexHome: directory,
    profileName: input.profileName ?? CODEX_PROFILE_NAME,
    workspaceRoots: [...new Set(input.folders)],
    ...(environment ? { environment } : {}),
  };
}

function importOwnerSkills(directory: string, configuredRoots?: readonly string[]): string | undefined {
  const ownerCodexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const roots = configuredRoots ?? [
    join(ownerCodexHome, "skills"),
    join(homedir(), ".agents", "skills"),
    join(ownerCodexHome, "plugins", "cache"),
  ];
  const skills = [...new Set(roots.flatMap((root) => discoverSkillDirectories(root)))].sort();
  if (skills.length === 0) return undefined;
  const targetRoot = join(directory, "skills");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const source of skills) {
    const slug = basename(source).replace(/[^a-zA-Z0-9_-]/gu, "-") || "skill";
    const suffix = createHash("sha256").update(source).digest("hex").slice(0, 10);
    copySkillTree(source, join(targetRoot, `${slug}-${suffix}`));
  }
  return targetRoot;
}

function discoverSkillDirectories(root: string, depth = 0): string[] {
  if (depth > 10 || !existsSync(root)) return [];
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
    const skillFile = join(root, "SKILL.md");
    if (existsSync(skillFile) && lstatSync(skillFile).isFile() && !lstatSync(skillFile).isSymbolicLink()) {
      return [root];
    }
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") {
        return [];
      }
      return discoverSkillDirectories(join(root, entry.name), depth + 1);
    });
  } catch {
    return [];
  }
}

function copySkillTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copySkillTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function nullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
