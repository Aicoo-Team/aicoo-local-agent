import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import type { InboundMessage } from "../adapters/runtime-adapter.js";
import {
  markTrustedToolPolicyUsed,
  policyMatchesOwner,
  readTrustedToolPolicies,
  type TrustedToolPolicy,
  type TrustedToolPolicyIdentity,
} from "./trusted-tool-policy.js";

const policySchema = z.object({
  version: z.literal(1),
  relationships: z.array(z.object({
    principalId: z.string().trim().min(1),
    deviceId: z.string().trim().min(1),
    tools: z.array(z.string().trim().min(1)).default([]),
    folders: z.array(z.string().trim().min(1)).default([]),
  }).strict()),
}).strict();

export type RelationshipPolicyDocument = z.infer<typeof policySchema>;
export type RelationshipAccessPreset = "chat-only" | "read-project" | "edit-project";

export interface ToolPermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

interface CompiledRelationship {
  principalId: string;
  deviceId: string;
  tools: ReadonlySet<string>;
  folders: readonly string[];
}

interface RelationshipPolicyOptions extends Partial<TrustedToolPolicyIdentity> {
  trustedToolPolicyFile?: string;
}

const PATH_INPUTS = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  GitStatus: ["repository"],
  GitDiff: ["repository"],
  GitLog: ["repository"],
  GitAdd: ["repository"],
  GitCommit: ["repository"],
} as const;

const POLICY_SUPPORTED_TOOLS = Object.keys(PATH_INPUTS).sort();
const POLICY_SUPPORTED_TOOL_SET = new Set<string>(POLICY_SUPPORTED_TOOLS);
const CREDENTIAL_PATH_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".config/gcloud",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
]);
const CREDENTIAL_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".netrc",
  "credentials",
]);
const EXECUTION_ON_NEXT_USE_PATHS = new Set([
  ".gitattributes",
  ".git/config",
  ".git/hooks",
  ".vscode/tasks.json",
  "Makefile",
  "package.json",
]);

const PRESET_TOOLS: Readonly<Record<RelationshipAccessPreset, readonly string[]>> = {
  "chat-only": [],
  "read-project": ["Read"],
  "edit-project": ["Read", "Write", "Edit"],
};

export const DEFAULT_RELATIONSHIP_POLICY_FILE = join(
  homedir(),
  ".aicoo",
  "local-agent",
  "relationships.json",
);

export class RelationshipPolicy {
  readonly #relationships: readonly CompiledRelationship[];
  readonly #cwd: string;
  readonly #policyFile: string;
  readonly #trustedToolPolicyFile?: string;
  readonly #trustedPolicies: readonly TrustedToolPolicy[];

  private constructor(
    document: RelationshipPolicyDocument,
    cwd: string,
    policyFile: string,
    options: RelationshipPolicyOptions = {},
  ) {
    this.#cwd = canonicalPath(cwd);
    this.#policyFile = canonicalPath(policyFile);
    this.#trustedToolPolicyFile = options.trustedToolPolicyFile
      ? canonicalPath(options.trustedToolPolicyFile)
      : undefined;
    const trustedIdentity = trustedPolicyIdentity(options);
    this.#trustedPolicies = this.#trustedToolPolicyFile && trustedIdentity
      ? readTrustedToolPolicies(this.#trustedToolPolicyFile).policies.filter((policy) =>
        policyMatchesOwner(policy, trustedIdentity))
      : [];
    this.#relationships = document.relationships.map((relationship) => ({
      principalId: relationship.principalId,
      deviceId: relationship.deviceId,
      tools: new Set(relationship.tools),
      folders: relationship.folders.map((folder) =>
        canonicalPath(toLiteralAbsolute(cwd, folder))),
    }));
    for (const relationship of this.#relationships) {
      for (const folder of relationship.folders) {
        if (folder !== normalizeCase(parse(folder).root) && isWithin(folder, this.#policyFile)) {
          throw new Error("Relationship policy must be stored outside every granted folder");
        }
      }
    }
    for (const policy of this.#trustedPolicies) {
      if (isWithin(policy.canonicalFolder, this.#policyFile)) {
        throw new Error("Relationship policy must be stored outside every granted folder");
      }
      if (this.#trustedToolPolicyFile && isWithin(policy.canonicalFolder, this.#trustedToolPolicyFile)) {
        throw new Error("Trusted tool policy must be stored outside every granted folder");
      }
    }
  }

  static fromFile(file: string, cwd: string, options: RelationshipPolicyOptions = {}): RelationshipPolicy {
    return new RelationshipPolicy(readPolicyDocument(file), cwd, file, options);
  }

  static supportedTools(): string[] {
    return [...POLICY_SUPPORTED_TOOLS];
  }

  enabledTools(): string[] {
    return [...new Set([
      ...this.#relationships.flatMap((relationship) => [...relationship.tools]),
      ...this.#trustedPolicies.map((policy) => policy.normalizedTool),
    ])]
      .filter((tool) => POLICY_SUPPORTED_TOOL_SET.has(tool))
      .sort();
  }

  grantedFolders(): string[] {
    return [...new Set([
      ...this.#relationships.flatMap((relationship) => relationship.folders),
      ...this.#trustedPolicies.map((policy) => policy.canonicalFolder),
    ])].sort();
  }

  writableFolders(): string[] {
    return [...new Set([
      ...this.#relationships
      .filter((relationship) => relationship.tools.has("Write") || relationship.tools.has("Edit"))
      .flatMap((relationship) => relationship.folders),
      ...this.#trustedPolicies
        .filter((policy) => ["Write", "Edit", "GitAdd", "GitCommit"].includes(policy.normalizedTool))
        .map((policy) => policy.canonicalFolder),
    ])]
      .sort();
  }

  sandboxDenyReadPaths(): string[] {
    return dangerousSandboxPaths(this.grantedFolders(), "read");
  }

  sandboxDenyWritePaths(): string[] {
    return dangerousSandboxPaths(this.grantedFolders(), "write");
  }

  hasToolAccess(message: InboundMessage | undefined): boolean {
    if (!message?.senderDeviceId) return false;
    const relationship = this.#relationships.find((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId);
    return Boolean(
      (relationship && relationship.tools.size > 0)
      || this.#trustedPolicies.some((policy) =>
        policy.requesterPrincipalId === message.senderPrincipalId
        && policy.requesterDeviceId === message.senderDeviceId),
    );
  }

  authorize(
    action: { toolName: string; input: Record<string, unknown> },
    message: InboundMessage | undefined,
  ): ToolPermissionDecision {
    return this.#authorize(action, message, true);
  }

  /** Validate the verified relationship and folder without treating that as a per-tool grant. */
  authorizeBoundary(
    action: { toolName: string; input: Record<string, unknown> },
    message: InboundMessage | undefined,
  ): ToolPermissionDecision {
    return this.#authorize(action, message, false);
  }

  #authorize(
    action: { toolName: string; input: Record<string, unknown> },
    message: InboundMessage | undefined,
    requireToolGrant: boolean,
  ): ToolPermissionDecision {
    if (!message) return deny("No active verified c2c message");
    if (!message.senderDeviceId) return deny("Sender device identity is unavailable");

    const relationship = this.#relationships.find((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId);
    const trustedPolicies = this.#trustedPolicies.filter((policy) =>
      policy.requesterPrincipalId === message.senderPrincipalId
      && policy.requesterDeviceId === message.senderDeviceId);
    if (!relationship && trustedPolicies.length === 0) return deny("No policy for this user and device");
    if (!POLICY_SUPPORTED_TOOL_SET.has(action.toolName) || action.toolName.startsWith("mcp__")) {
      return deny(`Unsupported tool ${action.toolName}`);
    }
    const trustedToolPolicies = trustedPolicies.filter((policy) => policy.normalizedTool === action.toolName);
    const relationshipAllowsTool = relationship?.tools.has(action.toolName) ?? false;
    if (requireToolGrant && !relationshipAllowsTool && trustedToolPolicies.length === 0) {
      const boundary = this.#authorize(action, message, false);
      return boundary.behavior === "allow"
        ? { behavior: "deny", message: `Tool ${action.toolName} is not allowed`, updatedInput: boundary.updatedInput }
        : boundary;
    }

    const pathKeys = PATH_INPUTS[action.toolName as keyof typeof PATH_INPUTS];
    const relationshipFolders = requireToolGrant && !relationshipAllowsTool
      ? []
      : relationship?.folders ?? [];
    const trustedFolders = (requireToolGrant ? trustedToolPolicies : trustedPolicies)
      .map((policy) => policy.canonicalFolder);
    const allowedFolders = [...new Set([...relationshipFolders, ...trustedFolders])];
    if (allowedFolders.length === 0) return deny(`Tool ${action.toolName} requires an allowed folder`);

    const paths = pathKeys.flatMap((key) => {
      const value = action.input[key];
      return typeof value === "string" && value.trim() ? [{ key, value }] : [];
    });
    if (paths.length === 0) return deny(`Tool ${action.toolName} did not provide a path`);

    const updatedInput = { ...action.input };
    for (const path of paths) {
      let candidate: string;
      try {
        candidate = resolveRelationshipPath(this.#cwd, allowedFolders, path.value);
      } catch {
        return deny("Path could not be resolved safely");
      }
      if (candidate === this.#policyFile) return deny("Relationship policy cannot be accessed by a remote tool");
      const dangerous = dangerousPathDecision(action.toolName, candidate);
      if (dangerous) return deny(dangerous);
      if (!allowedFolders.some((folder) => isWithin(folder, candidate))) {
        return deny(`Path is outside the folders allowed for this relationship`);
      }
      updatedInput[path.key] = candidate;
    }
    if (requireToolGrant && this.#trustedToolPolicyFile) {
      const matches = (policy: TrustedToolPolicy) =>
        paths.every((path) => {
          const candidate = updatedInput[path.key];
          return typeof candidate === "string" && isWithin(policy.canonicalFolder, candidate);
        });
      const matched = trustedToolPolicies.find((policy) => policy.createdFrom !== "cli" && matches(policy))
        ?? trustedToolPolicies.find(matches);
      if (matched) markTrustedToolPolicyUsed(this.#trustedToolPolicyFile, matched.policyId);
    }
    return { behavior: "allow", updatedInput };
  }
}

function trustedPolicyIdentity(options: RelationshipPolicyOptions): TrustedToolPolicyIdentity | undefined {
  return options.ownerPrincipalId && options.ownerDeviceId && options.bridgeInstanceId
    ? {
      ownerPrincipalId: options.ownerPrincipalId,
      ownerDeviceId: options.ownerDeviceId,
      bridgeInstanceId: options.bridgeInstanceId,
    }
    : undefined;
}

export function upsertRelationshipPreset(input: {
  file: string;
  principalId: string;
  deviceId: string;
  preset: RelationshipAccessPreset;
  folder?: string;
}): RelationshipPolicyDocument {
  const folder = input.folder?.trim();
  if (input.preset !== "chat-only" && !folder) {
    throw new Error(`--folder is required for ${input.preset}`);
  }

  return upsertRelationshipPolicy({
    file: input.file,
    principalId: input.principalId,
    deviceId: input.deviceId,
    tools: [...PRESET_TOOLS[input.preset]],
    folders: folder ? [folder] : [],
  });
}

/** Start or end an ephemeral bridge run with no remembered peer file permissions. */
export function resetRelationshipPolicy(file: string): void {
  writePolicyDocument(file, { version: 1, relationships: [] });
}

/** Persist the server's exact folder boundary and per-tool policy without expanding presets. */
export function upsertRelationshipPolicy(input: {
  file: string;
  principalId: string;
  deviceId: string;
  tools: readonly string[];
  folders: readonly string[];
}): RelationshipPolicyDocument {
  const unsupported = input.tools.find((tool) => !POLICY_SUPPORTED_TOOL_SET.has(tool));
  if (unsupported) throw new Error(`Unsupported relationship tool ${unsupported}`);

  const existing = readPolicyDocument(input.file);
  const canonicalFolders = [...new Set(input.folders
    .map((folder) => folder.trim())
    .filter(Boolean)
    .map(canonicalPath))];
  for (const canonicalFolder of canonicalFolders) {
    if (
      canonicalFolder !== normalizeCase(parse(canonicalFolder).root)
      && isWithin(canonicalFolder, canonicalPath(input.file))
    ) {
      throw new Error("Relationship policy must be stored outside the granted folder");
    }
  }
  const nextRelationship: RelationshipPolicyDocument["relationships"][number] = {
    principalId: input.principalId,
    deviceId: input.deviceId,
    tools: [...new Set(input.tools)].sort(),
    folders: canonicalFolders.sort(),
  };
  const relationships = existing.relationships.filter((relationship) =>
    relationship.principalId !== input.principalId || relationship.deviceId !== input.deviceId);
  relationships.push(nextRelationship);
  relationships.sort((left, right) =>
    `${left.principalId}\u0000${left.deviceId}`.localeCompare(`${right.principalId}\u0000${right.deviceId}`));

  const document: RelationshipPolicyDocument = { version: 1, relationships };
  writePolicyDocument(input.file, document);
  return document;
}

function readPolicyDocument(file: string): RelationshipPolicyDocument {
  if (!existsSync(file)) return { version: 1, relationships: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read relationship policy ${file}: ${String(error)}`);
  }
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid relationship policy ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function writePolicyDocument(file: string, document: RelationshipPolicyDocument): void {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function deny(message: string): ToolPermissionDecision {
  return { behavior: "deny", message };
}

/**
 * Resolve the literal path component-by-component through the filesystem.
 * Crucially, do not call path.resolve() first: it would collapse `..` before a
 * preceding symlink is followed, authorizing a different path than the kernel.
 */
function canonicalPath(input: string): string {
  try {
    return normalizeCase(realpathSync.native(input));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parent = dirname(input);
    if (parent === input) throw error;
    return normalizeCase(join(canonicalPath(parent), basename(input)));
  }
}

function toLiteralAbsolute(cwd: string, input: string): string {
  return isAbsolute(input) ? input : `${cwd}${sep}${input}`;
}

function resolveRelationshipPath(cwd: string, folders: readonly string[], input: string): string {
  const cwdCandidate = canonicalPath(toLiteralAbsolute(cwd, input));
  if (folders.some((folder) => isWithin(folder, cwdCandidate))) return cwdCandidate;
  if (isAbsolute(input)) return cwdCandidate;
  for (const folder of folders) {
    const folderCandidate = canonicalPath(toLiteralAbsolute(folder, input));
    if (isWithin(folder, folderCandidate)) return folderCandidate;
  }
  return cwdCandidate;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithin(folder: string, candidate: string): boolean {
  if (folder === normalizeCase(parse(folder).root)) return candidate.startsWith(folder);
  return candidate === folder || candidate.startsWith(`${folder}${sep}`);
}

function normalizeCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function dangerousPathDecision(toolName: string, candidate: string): string | undefined {
  const normalized = normalizeCase(candidate);
  const segments = normalized.split(sep).filter(Boolean);
  for (const credential of CREDENTIAL_PATH_SEGMENTS) {
    const credentialParts = credential.split("/");
    for (let index = 0; index <= segments.length - credentialParts.length; index += 1) {
      if (credentialParts.every((part, offset) => segments[index + offset] === part)) {
        return "Credential paths cannot be accessed by a remote relationship";
      }
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join("/");
    if (CREDENTIAL_PATH_SEGMENTS.has(suffix)) {
      return "Credential paths cannot be accessed by a remote relationship";
    }
  }
  const fileName = basename(normalized);
  if (CREDENTIAL_FILE_NAMES.has(fileName) || fileName.startsWith(".env.")) {
    return "Credential files cannot be accessed by a remote relationship";
  }
  if ((toolName === "Write" || toolName === "Edit") && isExecutionOnNextUsePath(normalized)) {
    return "Execution-on-next-use files cannot be modified by a remote relationship";
  }
  return undefined;
}

function isExecutionOnNextUsePath(normalized: string): boolean {
  const portable = normalized.split(sep).join("/");
  return [...EXECUTION_ON_NEXT_USE_PATHS].some((dangerous) =>
    portable.endsWith(`/${dangerous}`) || portable === dangerous);
}

function dangerousSandboxPaths(folders: readonly string[], mode: "read" | "write"): string[] {
  const paths = new Set<string>();
  for (const folder of folders) {
    for (const credential of CREDENTIAL_PATH_SEGMENTS) paths.add(join(folder, ...credential.split("/")));
    for (const credential of CREDENTIAL_FILE_NAMES) paths.add(join(folder, credential));
    if (mode === "write") {
      for (const dangerous of EXECUTION_ON_NEXT_USE_PATHS) paths.add(join(folder, ...dangerous.split("/")));
    }
  }
  const home = canonicalPath(homedir());
  for (const credential of CREDENTIAL_PATH_SEGMENTS) paths.add(join(home, ...credential.split("/")));
  for (const credential of CREDENTIAL_FILE_NAMES) paths.add(join(home, credential));
  return [...paths].sort();
}
