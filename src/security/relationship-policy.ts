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
  accessPresetAllowsTool,
  PRESET_TOOLS,
  strongestAccessPreset,
  type RelationshipAccessPreset,
} from "./relationship-access.js";
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
export type { RelationshipAccessPreset } from "./relationship-access.js";

export interface ToolPermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

export type ProjectAccessStatus = "none" | "selected" | "selection_required" | "not_found";

export interface ProjectAccess {
  status: ProjectAccessStatus;
  preset: RelationshipAccessPreset;
  folders: string[];
  writableFolders: string[];
  selectionSource?: "single_active_grant" | "explicit" | "objective_preflight";
  requestedProject?: string;
  requestedProjects?: string[];
  selectedPolicyIds?: string[];
  selectedFolderPaths?: string[];
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
const WRITE_TOOLS = new Set(["Write", "Edit", "GitAdd", "GitCommit"]);

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
      ...this.#trustedPolicies.flatMap((policy) => PRESET_TOOLS[policy.accessPreset]),
    ])]
      .filter((tool) => POLICY_SUPPORTED_TOOL_SET.has(tool))
      .sort();
  }

  grantedFolders(message?: InboundMessage): string[] {
    const relationships = message ? this.relationshipsFor(message) : this.#relationships;
    const trustedPolicies = message ? this.trustedPoliciesFor(message) : this.#trustedPolicies;
    return [...new Set([
      ...relationships.flatMap((relationship) => relationship.folders),
      ...trustedPolicies.map((policy) => policy.canonicalFolder),
    ])].sort();
  }

  writableFolders(message?: InboundMessage): string[] {
    const relationships = message ? this.relationshipsFor(message) : this.#relationships;
    const trustedPolicies = message ? this.trustedPoliciesFor(message) : this.#trustedPolicies;
    return [...new Set([
      ...relationships
        .filter((relationship) => relationship.tools.has("Write") || relationship.tools.has("Edit"))
        .flatMap((relationship) => relationship.folders),
      ...trustedPolicies
        .filter((policy) => policy.accessPreset === "edit-project")
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

  accessFor(message: InboundMessage | undefined, recordUsage = false): ProjectAccess {
    if (!message?.senderDeviceId) {
      return { status: "none", preset: "chat-only", folders: [], writableFolders: [] };
    }
    const relationships = this.relationshipsFor(message);
    const trustedPolicies = this.trustedPoliciesFor(message);
    const availableFolders = [...new Set([
      ...relationships.flatMap((relationship) => relationship.folders),
      ...trustedPolicies.map((policy) => policy.canonicalFolder),
    ])].sort();
    const explicitProjects = projectAccessSelectors(message);
    const preflightProjects = explicitProjects.length === 0
      ? objectivePreflightProjects(message, availableFolders)
      : [];
    const requestedProjects = explicitProjects.length > 0 ? explicitProjects : preflightProjects;
    const selectionSource = explicitProjects.length > 0
      ? "explicit" as const
      : preflightProjects.length > 0
        ? "objective_preflight" as const
        : "single_active_grant" as const;

    let selectedFolders: string[];
    const selectedPolicyIds = new Set<string>();
    const selectedFolderPaths = new Set<string>();
    if (requestedProjects.length > 0) {
      const requestedFolders = new Set<string>();
      for (const requestedProject of requestedProjects) {
        let matched = false;
        for (const policy of trustedPolicies) {
          if (policy.policyId !== requestedProject) continue;
          selectedPolicyIds.add(policy.policyId);
          requestedFolders.add(policy.canonicalFolder);
          matched = true;
        }
        if (isAbsolute(requestedProject)) {
          let requestedFolder: string;
          try {
            requestedFolder = canonicalPath(requestedProject);
          } catch {
            requestedFolder = requestedProject;
          }
          if (availableFolders.includes(requestedFolder)) {
            selectedFolderPaths.add(requestedFolder);
            requestedFolders.add(requestedFolder);
            matched = true;
          }
        }
        if (!matched) {
          return {
            status: "not_found",
            preset: "chat-only",
            folders: [],
            writableFolders: [],
            requestedProjects,
            ...(requestedProjects.length === 1 ? { requestedProject: requestedProjects[0] } : {}),
          };
        }
      }
      selectedFolders = [...requestedFolders].sort();
      if (selectedFolders.length === 0) {
        return {
          status: "not_found",
          preset: "chat-only",
          folders: [],
          writableFolders: [],
          requestedProjects,
          ...(requestedProjects.length === 1 ? { requestedProject: requestedProjects[0] } : {}),
        };
      }
    } else {
      if (availableFolders.length > 1) {
        return {
          status: "selection_required",
          preset: "chat-only",
          folders: [],
          writableFolders: [],
        };
      }
      selectedFolders = availableFolders;
    }

    if (selectedFolders.length === 0) {
      return {
        status: "none",
        preset: "chat-only",
        folders: [],
        writableFolders: [],
        ...(requestedProjects.length > 0 ? { requestedProjects } : {}),
        ...(requestedProjects.length === 1 ? { requestedProject: requestedProjects[0] } : {}),
      };
    }

    const hasExplicitSelection = requestedProjects.length > 0;
    const selectedRelationships = relationships.filter((relationship) =>
      relationship.folders.some((folder) =>
        selectedFolders.includes(folder)
        && (!hasExplicitSelection || selectedFolderPaths.has(folder))));
    const selectedTrustedPolicies = trustedPolicies.filter((policy) =>
      selectedFolders.includes(policy.canonicalFolder)
      && (!hasExplicitSelection
        || selectedPolicyIds.has(policy.policyId)
        || selectedFolderPaths.has(policy.canonicalFolder)));
    const presets: RelationshipAccessPreset[] = [
      ...selectedRelationships.map((relationship) => presetForTools(relationship.tools)),
      ...selectedTrustedPolicies.map((policy) => policy.accessPreset),
    ];
    if (recordUsage && this.#trustedToolPolicyFile) {
      for (const policy of selectedTrustedPolicies) {
        markTrustedToolPolicyUsed(this.#trustedToolPolicyFile, policy.policyId);
      }
    }
    return {
      status: "selected",
      preset: strongestAccessPreset(presets),
      folders: selectedFolders,
      writableFolders: [...new Set([
        ...selectedRelationships
          .filter((relationship) => relationship.tools.has("Write") || relationship.tools.has("Edit"))
          .flatMap((relationship) => relationship.folders),
        ...selectedTrustedPolicies
          .filter((policy) => policy.accessPreset === "edit-project")
          .map((policy) => policy.canonicalFolder),
      ])].filter((folder) => selectedFolders.includes(folder)).sort(),
      selectionSource,
      ...(requestedProjects.length > 0 ? { requestedProjects } : {}),
      ...(requestedProjects.length === 1 ? { requestedProject: requestedProjects[0] } : {}),
      ...(selectedPolicyIds.size > 0 ? { selectedPolicyIds: [...selectedPolicyIds].sort() } : {}),
      ...(selectedFolderPaths.size > 0 ? { selectedFolderPaths: [...selectedFolderPaths].sort() } : {}),
    };
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

    const projectAccess = this.accessFor(message);
    if (projectAccess.status === "selection_required") {
      return deny("Multiple project folders are available; the delegation must select a project");
    }
    if (projectAccess.status === "not_found") {
      return deny("The requested project is not allowed for this relationship");
    }

    const matchingTrustedPolicies = this.trustedPoliciesFor(message);
    const selectedPolicyIds = new Set(projectAccess.selectedPolicyIds ?? []);
    const selectedFolderPaths = new Set(projectAccess.selectedFolderPaths ?? []);
    const hasExplicitSelection = (projectAccess.requestedProjects?.length ?? 0) > 0;
    const relationships = this.#relationships.filter((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId
      && candidate.folders.some((folder) =>
        projectAccess.folders.includes(folder)
        && (!hasExplicitSelection || selectedFolderPaths.has(folder))));
    const trustedPolicies = matchingTrustedPolicies.filter((policy) =>
      projectAccess.folders.includes(policy.canonicalFolder)
      && (!hasExplicitSelection
        || selectedPolicyIds.has(policy.policyId)
        || selectedFolderPaths.has(policy.canonicalFolder)));
    if (relationships.length === 0 && trustedPolicies.length === 0) {
      return deny("No policy for this user and device");
    }
    if (!POLICY_SUPPORTED_TOOL_SET.has(action.toolName) || action.toolName.startsWith("mcp__")) {
      return deny(`Unsupported tool ${action.toolName}`);
    }
    const trustedToolPolicies = trustedPolicies.filter((policy) => accessPresetAllowsTool(policy.accessPreset, action.toolName));
    const relationshipAllowsTool = relationships.some((relationship) => relationship.tools.has(action.toolName));
    if (requireToolGrant && !relationshipAllowsTool && trustedToolPolicies.length === 0) {
      const boundary = this.#authorize(action, message, false);
      return boundary.behavior === "allow"
        ? { behavior: "deny", message: `Tool ${action.toolName} is not allowed`, updatedInput: boundary.updatedInput }
        : boundary;
    }

    const pathKeys = PATH_INPUTS[action.toolName as keyof typeof PATH_INPUTS];
    const relationshipFolders = requireToolGrant && !relationshipAllowsTool
      ? []
      : relationships
        .flatMap((relationship) => relationship.folders)
        .filter((folder) => projectAccess.folders.includes(folder));
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

  private relationshipsFor(message: InboundMessage): CompiledRelationship[] {
    if (!message.senderDeviceId) return [];
    return this.#relationships.filter((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId);
  }

  private trustedPoliciesFor(message: InboundMessage): TrustedToolPolicy[] {
    if (!message.senderDeviceId) return [];
    return this.#trustedPolicies.filter((policy) =>
      policy.requesterPrincipalId === message.senderPrincipalId
      && policy.requesterDeviceId === message.senderDeviceId);
  }
}

/**
 * Project selection travels inside the structured delegation task so both the
 * reference server and older hosted relays can forward it without a new route.
 */
export function projectAccessSelector(message: InboundMessage | undefined): string | undefined {
  const selectors = projectAccessSelectors(message);
  return selectors.length === 1 ? selectors[0] : undefined;
}

/**
 * An objective may select several exact grants so the runtime can build one immutable boundary
 * before work starts. The plural field is additive protocol evolution; the singular field stays
 * readable for older senders and relays.
 */
export function projectAccessSelectors(message: InboundMessage | undefined): string[] {
  const task = message?.payload.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return [];
  const record = task as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "projectAccessIds")) {
    const selectors = record.projectAccessIds;
    if (
      !Array.isArray(selectors)
      || selectors.length === 0
      || selectors.length > 16
      || selectors.some((selector) => typeof selector !== "string" || !selector.trim() || selector.length > 1_024)
    ) {
      return ["\u0000invalid-project-selection"];
    }
    return [...new Set(selectors.map((selector) => String(selector).trim()))].sort();
  }
  if (!Object.prototype.hasOwnProperty.call(record, "projectAccessId")) return [];
  const selector = record.projectAccessId;
  return typeof selector === "string" && selector.trim() && selector.length <= 1_024
    ? [selector.trim()]
    : ["\u0000invalid-project-selection"];
}

/**
 * Select already-active project grants named by a task objective before the runtime starts.
 * A basename is accepted only when it identifies exactly one available folder; otherwise the
 * caller receives selection_required and must provide an exact grant ID or absolute folder.
 */
function objectivePreflightProjects(
  message: InboundMessage | undefined,
  availableFolders: readonly string[],
): string[] {
  if (message?.kind !== "task_invite" || availableFolders.length < 2) return [];
  const task = message.payload.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return [];
  const text = (task as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) return [];

  const normalizedObjective = text.toLowerCase();
  const foldersByName = new Map<string, string[]>();
  for (const folder of availableFolders) {
    const name = basename(folder).toLowerCase();
    foldersByName.set(name, [...(foldersByName.get(name) ?? []), folder]);
  }

  const selected = new Set<string>();
  for (const folder of availableFolders) {
    if (objectiveNamesProject(normalizedObjective, folder.toLowerCase())) selected.add(folder);
  }
  for (const [name, folders] of foldersByName) {
    if (name.length < 3 || folders.length !== 1 || !objectiveNamesProject(normalizedObjective, name)) continue;
    selected.add(folders[0]!);
  }
  return [...selected].sort();
}

function objectiveNamesProject(objective: string, projectName: string): boolean {
  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, "u").test(objective);
}

/** Check a canonicalized tool action against the immutable access snapshot used to launch a session. */
export function projectAccessAllowsAction(
  access: ProjectAccess | undefined,
  action: { toolName: string; input: Record<string, unknown> },
): boolean {
  if (!access || access.status !== "selected") return false;
  const pathKeys = PATH_INPUTS[action.toolName as keyof typeof PATH_INPUTS];
  if (!pathKeys) return false;
  const paths = pathKeys.flatMap((key) => {
    const value = action.input[key];
    return typeof value === "string" && value.trim() ? [value] : [];
  });
  if (paths.length === 0) return false;
  const allowedFolders = WRITE_TOOLS.has(action.toolName) ? access.writableFolders : access.folders;
  return paths.every((candidate) => allowedFolders.some((folder) => isWithin(folder, candidate)));
}

function presetForTools(tools: ReadonlySet<string>): RelationshipAccessPreset {
  if (["Write", "Edit", "GitAdd", "GitCommit"].some((tool) => tools.has(tool))) return "edit-project";
  if (["Read", "GitStatus", "GitDiff", "GitLog"].some((tool) => tools.has(tool))) return "read-project";
  return "chat-only";
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

/** Persist the server's exact folder boundary and derive its tools from the selected preset. */
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
