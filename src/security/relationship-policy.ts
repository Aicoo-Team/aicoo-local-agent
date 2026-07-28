import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
}

interface CompiledRelationship {
  principalId: string;
  deviceId: string;
  tools: ReadonlySet<string>;
  folders: readonly string[];
}

const PATH_INPUTS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["path"],
  Grep: ["path"],
  NotebookEdit: ["notebook_path"],
};

// These tools can escape a folder allowlist or delegate work whose paths cannot
// be checked reliably. Keep them blocked until the runtime supplies a stronger
// OS sandbox and structured child-tool authorization.
const UNSCOPABLE_TOOLS = new Set(["Bash", "Agent", "Task", "Skill", "Mcp"]);
const POLICY_SUPPORTED_TOOLS = [
  "AskUserQuestion",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

const PRESET_TOOLS: Readonly<Record<RelationshipAccessPreset, readonly string[]>> = {
  "chat-only": [],
  "read-project": ["Read", "Glob", "Grep"],
  "edit-project": ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"],
};

export class RelationshipPolicy {
  readonly #relationships: readonly CompiledRelationship[];
  readonly #cwd: string;

  private constructor(document: RelationshipPolicyDocument, cwd: string) {
    this.#cwd = canonicalPath(resolve(cwd));
    this.#relationships = document.relationships.map((relationship) => ({
      principalId: relationship.principalId,
      deviceId: relationship.deviceId,
      tools: new Set(relationship.tools),
      folders: relationship.folders.map((folder) =>
        canonicalPath(isAbsolute(folder) ? folder : resolve(cwd, folder))),
    }));
  }

  static fromFile(file: string, cwd: string): RelationshipPolicy {
    return new RelationshipPolicy(readPolicyDocument(file), cwd);
  }

  static supportedTools(): string[] {
    return [...POLICY_SUPPORTED_TOOLS];
  }

  enabledTools(): string[] {
    return [...new Set(this.#relationships.flatMap((relationship) => [...relationship.tools]))]
      .filter((tool) => !UNSCOPABLE_TOOLS.has(tool))
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
    if (!relationship.tools.has(action.toolName)) return deny(`Tool ${action.toolName} is not allowed`);
    if (UNSCOPABLE_TOOLS.has(action.toolName)) {
      return deny(`Tool ${action.toolName} cannot be safely restricted to allowed folders`);
    }

    const pathKeys = PATH_INPUTS[action.toolName];
    if (!pathKeys) return { behavior: "allow" };
    if (relationship.folders.length === 0) return deny(`Tool ${action.toolName} requires an allowed folder`);

    const paths = pathKeys.flatMap((key) => {
      const value = action.input[key];
      return typeof value === "string" && value.trim() ? [value] : [];
    });
    if (paths.length === 0 && (action.toolName === "Glob" || action.toolName === "Grep")) {
      paths.push(this.#cwd);
    }
    if (paths.length === 0) return deny(`Tool ${action.toolName} did not provide a path`);

    for (const path of paths) {
      const candidate = canonicalPath(isAbsolute(path) ? path : resolve(this.#cwd, path));
      if (!relationship.folders.some((folder) => isWithin(folder, candidate))) {
        return deny(`Path is outside the folders allowed for this relationship`);
      }
    }
    return { behavior: "allow" };
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
  const nextRelationship: RelationshipPolicyDocument["relationships"][number] = {
    principalId: input.principalId,
    deviceId: input.deviceId,
    tools: [...PRESET_TOOLS[input.preset]],
    folders: folder ? [resolve(folder)] : [],
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
 * Resolve symlinks in the deepest existing ancestor. This also protects writes
 * to not-yet-created files below a symlinked directory.
 */
function canonicalPath(input: string): string {
  let existing = resolve(input);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalExisting = existsSync(existing) ? realpathSync.native(existing) : existing;
  const suffix = relative(existing, resolve(input));
  return normalizeCase(resolve(canonicalExisting, suffix));
}

function isWithin(folder: string, candidate: string): boolean {
  return candidate === folder || candidate.startsWith(`${folder}${sep}`);
}

function normalizeCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
