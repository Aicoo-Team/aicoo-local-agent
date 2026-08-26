import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}

/**
 * Plain `chat-only` gets no profile at all. When exact MCP tools are granted, however, it gets a
 * private profile with no workspace roots so Codex can load only those tools without gaining
 * project access or inheriting the owner's settings.
 */
export function renderCodexPermissionProfile(input: CodexPermissionProfileInput): string | undefined {
  const mcpServers = parseRemoteMcpGrants(input.mcpServers ?? []);
  if (input.preset === "chat-only" && mcpServers.length === 0) return undefined;
  const folders = input.preset === "chat-only"
    ? []
    : [...new Set(input.folders)].filter((folder) => folder.trim().length > 0);
  if (folders.length === 0 && mcpServers.length === 0) return undefined;

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

  return [
    `default_permissions = ${tomlString(name)}`,
    // The private home must not fall back to owner OAuth stored in a system keyring. A granted
    // server either uses its named bearer environment variable or connects without credentials.
    'mcp_oauth_credentials_store = "file"',
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

export interface PreparedCodexProfile {
  /** Value for the CODEX_HOME environment variable of the spawned process. */
  codexHome: string;
  profileName: string;
  workspaceRoots?: string[];
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
  const profile = renderCodexPermissionProfile(input);
  if (!profile) return undefined;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
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
  return {
    codexHome: directory,
    profileName: input.profileName ?? CODEX_PROFILE_NAME,
    workspaceRoots: [...new Set(input.folders)],
  };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
