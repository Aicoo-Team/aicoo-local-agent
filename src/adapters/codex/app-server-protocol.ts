import type { CodexThreadEvent, CodexThreadItem } from "./driver.js";

/**
 * Pure translation between the Codex `app-server` JSON-RPC protocol and the event shape this
 * codebase already speaks (which came from `codex exec --json`).
 *
 * Kept free of process and socket plumbing so every rule below is unit-testable without spawning
 * Codex. The live behaviour these rules encode is recorded in docs/CODEX-APP-SERVER-APPROVAL.md.
 */

/** Server-to-client approval methods, and what a `decision` field means for each. */
export const APPROVAL_METHODS = {
  commandExecution: "item/commandExecution/requestApproval",
  fileChange: "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval",
} as const;

export type CodexApprovalKind = keyof typeof APPROVAL_METHODS;

export interface CodexApprovalRequest {
  kind: CodexApprovalKind;
  /** The concrete thing about to happen, for the owner's prompt. Never a bare tool name. */
  summary: string;
  command?: string;
  cwd?: string;
  reason?: string;
}

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline";

/**
 * Recognize an approval request. Anything unrecognized returns null, and the caller must treat
 * that as a deny: an approval kind we cannot describe to the owner is one we must not answer for
 * them. A spike that answered every approval blindly let Codex's own memory plugin write outside
 * the workspace, which is the exact failure this whole feature exists to prevent.
 */
export function classifyApproval(method: string, params: unknown): CodexApprovalRequest | null {
  const kind = (Object.keys(APPROVAL_METHODS) as CodexApprovalKind[])
    .find((key) => APPROVAL_METHODS[key] === method);
  if (!kind) return null;

  const p = (params ?? {}) as Record<string, unknown>;
  const command = typeof p.command === "string" ? p.command : undefined;
  const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
  const reason = typeof p.reason === "string" ? p.reason : undefined;

  return {
    kind,
    summary: summarizeApproval(kind, p, command),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(reason ? { reason } : {}),
  };
}

function summarizeApproval(
  kind: CodexApprovalKind,
  params: Record<string, unknown>,
  command: string | undefined,
): string {
  if (kind === "commandExecution") return command ? `Run: ${command}` : "Run a shell command";
  if (kind === "fileChange") {
    const paths = fileChangePaths(params);
    return paths.length > 0 ? `Modify: ${paths.join(", ")}` : "Modify files";
  }
  return "Widen this session's sandbox permissions";
}

function fileChangePaths(params: Record<string, unknown>): string[] {
  const changes = params.changes ?? params.fileChanges;
  if (Array.isArray(changes)) {
    return changes
      .map((change) => (change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined))
      .filter((path): path is string => typeof path === "string");
  }
  if (changes && typeof changes === "object") return Object.keys(changes as Record<string, unknown>);
  return [];
}

/**
 * The JSON-RPC result for an approval.
 *
 * `permissions` requests are answered with an empty grant no matter what the owner said. A remote
 * caller's reach is defined by the relationship policy and the sandbox profile built from it; this
 * path exists for Codex to ask for *more* than that, and the answer is always no. Replying with an
 * empty grant refuses without leaving Codex waiting on a request nobody answered.
 */
export function approvalResponse(
  request: CodexApprovalRequest,
  decision: CodexApprovalDecision,
): Record<string, unknown> {
  if (request.kind === "permissions") return { permissions: {}, scope: "turn" };
  return { decision };
}

/** Answer for a request we could not classify. Always a refusal, in a shape Codex accepts. */
export const UNKNOWN_APPROVAL_RESPONSE: Record<string, unknown> = { decision: "decline" };

/**
 * `codex exec --json` names item types in snake_case and the adapter matches on that; the
 * app-server uses camelCase for the same items. Without this, `agentMessage` never matches
 * `agent_message` and the peer's reply silently never arrives — it looks exactly like a peer who
 * received the message and chose not to answer.
 */
export function normalizeItemType(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  return type.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function normalizeItem(item: unknown): CodexThreadItem {
  if (!item || typeof item !== "object") return {};
  const source = item as Record<string, unknown>;
  const type = normalizeItemType(source.type);
  return { ...source, ...(type ? { type } : {}) } as CodexThreadItem;
}

/**
 * Map one app-server notification onto the event stream the adapter consumes.
 * Returns undefined for notifications that carry no meaning for a turn (token usage, rate limits,
 * deltas) so the caller can ignore them without a growing list of special cases.
 */
export function mapNotification(method: string, params: unknown): CodexThreadEvent | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "thread/started":
      return typeof p.threadId === "string" ? { type: "thread.started", thread_id: p.threadId } : undefined;
    case "turn/started":
      return { type: "turn.started" };
    case "item/started":
      return { type: "item.started", item: normalizeItem(p.item) };
    case "item/updated":
      return { type: "item.updated", item: normalizeItem(p.item) };
    case "item/completed":
      return { type: "item.completed", item: normalizeItem(p.item) };
    case "turn/completed":
      return { type: "turn.completed" };
    case "turn/failed":
      return {
        type: "turn.failed",
        error: { message: turnFailureMessage(p) },
      };
    default:
      return undefined;
  }
}

function turnFailureMessage(params: Record<string, unknown>): string {
  const error = params.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "codex turn failed";
}

/** True for the notifications that end a turn, so the caller knows when to stop reading. */
export function isTerminalNotification(method: string): boolean {
  return method === "turn/completed" || method === "turn/failed";
}
