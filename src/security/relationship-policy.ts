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

const PATH_INPUTS = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
} as const;

const POLICY_SUPPORTED_TOOLS = Object.keys(PATH_INPUTS).sort();
const POLICY_SUPPORTED_TOOL_SET = new Set<string>(POLICY_SUPPORTED_TOOLS);

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

  private constructor(document: RelationshipPolicyDocument, cwd: string, policyFile: string) {
    this.#cwd = canonicalPath(cwd);
    this.#policyFile = canonicalPath(policyFile);
    this.#relationships = document.relationships.map((relationship) => ({
      principalId: relationship.principalId,
      deviceId: relationship.deviceId,
      tools: new Set(relationship.tools),
      folders: relationship.folders.map((folder) =>
        canonicalPath(toLiteralAbsolute(cwd, folder))),
    }));
    for (const relationship of this.#relationships) {
      for (const folder of relationship.folders) {
        if (folder === normalizeCase(parse(folder).root)) {
          throw new Error("Filesystem root cannot be granted");
        }
        if (isWithin(folder, this.#policyFile)) {
          throw new Error("Relationship policy must be stored outside every granted folder");
        }
      }
    }
  }

  static fromFile(file: string, cwd: string): RelationshipPolicy {
    return new RelationshipPolicy(readPolicyDocument(file), cwd, file);
  }

  static supportedTools(): string[] {
    return [...POLICY_SUPPORTED_TOOLS];
  }

  enabledTools(): string[] {
    return [...new Set(this.#relationships.flatMap((relationship) => [...relationship.tools]))]
      .filter((tool) => POLICY_SUPPORTED_TOOL_SET.has(tool))
      .sort();
  }

  hasToolAccess(message: InboundMessage | undefined): boolean {
    if (!message?.senderDeviceId) return false;
    const relationship = this.#relationships.find((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId);
    return Boolean(relationship && relationship.tools.size > 0);
  }

  authorize(
    action: { toolName: string; input: Record<string, unknown> },
    message: InboundMessage | undefined,
  ): ToolPermissionDecision {
    if (!message) return deny("No active verified c2c message");
    if (!message.senderDeviceId) return deny("Sender device identity is unavailable");

    const relationship = this.#relationships.find((candidate) =>
      candidate.principalId === message.senderPrincipalId
      && candidate.deviceId === message.senderDeviceId);
    if (!relationship) return deny("No policy for this user and device");
    if (!POLICY_SUPPORTED_TOOL_SET.has(action.toolName) || action.toolName.startsWith("mcp__")) {
      return deny(`Unsupported tool ${action.toolName}`);
    }
    if (!relationship.tools.has(action.toolName)) return deny(`Tool ${action.toolName} is not allowed`);

    const pathKeys = PATH_INPUTS[action.toolName as keyof typeof PATH_INPUTS];
    if (relationship.folders.length === 0) return deny(`Tool ${action.toolName} requires an allowed folder`);

    const paths = pathKeys.flatMap((key) => {
      const value = action.input[key];
      return typeof value === "string" && value.trim() ? [{ key, value }] : [];
    });
    if (paths.length === 0) return deny(`Tool ${action.toolName} did not provide a path`);

    const updatedInput = { ...action.input };
    for (const path of paths) {
      let candidate: string;
      try {
        candidate = resolveRelationshipPath(this.#cwd, relationship.folders, path.value);
      } catch {
        return deny("Path could not be resolved safely");
      }
      if (candidate === this.#policyFile) return deny("Relationship policy cannot be accessed by a remote tool");
      if (!relationship.folders.some((folder) => isWithin(folder, candidate))) {
        return deny(`Path is outside the folders allowed for this relationship`);
      }
      updatedInput[path.key] = candidate;
    }
    return { behavior: "allow", updatedInput };
  }
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

  const existing = readPolicyDocument(input.file);
  const canonicalFolder = folder ? canonicalPath(folder) : undefined;
  if (canonicalFolder && canonicalFolder === normalizeCase(parse(canonicalFolder).root)) {
    throw new Error("Filesystem root cannot be granted");
  }
  if (canonicalFolder && isWithin(canonicalFolder, canonicalPath(input.file))) {
    throw new Error("Relationship policy must be stored outside the granted folder");
  }
  const nextRelationship: RelationshipPolicyDocument["relationships"][number] = {
    principalId: input.principalId,
    deviceId: input.deviceId,
    tools: [...PRESET_TOOLS[input.preset]],
    folders: canonicalFolder ? [canonicalFolder] : [],
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
