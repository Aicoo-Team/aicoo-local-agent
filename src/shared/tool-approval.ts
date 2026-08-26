import type {
  BoundaryActivation,
  ToolApprovalRequest,
} from "./aicoo-transport.js";

/**
 * Just-in-time tool approval.
 *
 * The relationship policy answers "is this pre-authorized?". When it says no, that used to end the
 * turn: the tool was denied and the peer got a refusal for something its owner would very likely
 * have allowed if anyone had asked. This asks.
 *
 * `canUseTool` in the Claude Agent SDK is an async callback, so the turn can simply wait on a
 * network round trip — there is no terminal prompt involved and no TTY required. The control plane
 * already implements the other half: it auto-allows a policy hit silently, and otherwise creates a
 * pending approval and pushes it to the owner's chat as a popup.
 *
 * Failure is always a deny. A network error, an expiry, or a timeout must not fall through to
 * "allow" — the whole point is that nobody authorized this yet.
 */

export interface ToolApprovalGateway {
  requestToolApproval(
    input: ToolApprovalRequest,
  ): Promise<ToolApprovalState & { approvalId: string }>;
  getToolApproval(approvalId: string): Promise<ToolApprovalState>;
}

export type ToolApprovalScope = "once" | "session";

export interface ToolApprovalState {
  approvalId?: string;
  status: string;
  decision: "allow" | "deny" | null;
  scope?: ToolApprovalScope | null;
  activation?: BoundaryActivation | null;
}

export type ToolApprovalOutcome =
  | { behavior: "allow"; scope: ToolApprovalScope; activation?: BoundaryActivation }
  | { behavior: "deny"; message: string };

export interface AwaitToolApprovalOptions {
  /** How often to re-check a pending approval. */
  pollMs?: number;
  /**
   * Give up waiting after this long. Deliberately equal to the control plane's approval TTL, so
   * neither side keeps waiting on a decision the other has already written off. Both ends of that
   * race are a deny, and the owner is told their late answer missed.
   */
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Injected so tests don't spend real time asleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onApprovalCreated?: (approvalId: string) => void | Promise<void>;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * `auto_allow` is the silent path: the owner's policy already covers this tool, so the control
 * plane resolves it without notifying anyone. Only `pending` reaches a human.
 */
export async function awaitToolApproval(
  gateway: ToolApprovalGateway,
  input: ToolApprovalRequest,
  options: AwaitToolApprovalOptions = {},
): Promise<ToolApprovalOutcome> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  let requested: ToolApprovalState & { approvalId: string };
  try {
    requested = await gateway.requestToolApproval(input);
    await options.onApprovalCreated?.(requested.approvalId);
  } catch (error) {
    return denied(`could not ask ${input.toolName} approval: ${String(error)}`, options.log);
  }

  const requiresActivation = input.boundaryExpansion?.requiresSessionRebuild === true;
  const initial = decide(
    requested.status,
    requested.decision,
    requested.scope,
    requested.activation,
    requiresActivation,
  );
  if (initial) {
    options.log?.(
      initial.behavior === "allow"
        ? `tool approval resolved without asking (${requested.status}): ${input.toolName}`
        : `tool approval refused immediately (${requested.status}): ${input.toolName}`,
    );
    return initial;
  }

  options.log?.(`waiting for owner approval of ${input.toolName} (${requested.approvalId})`);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    let current: ToolApprovalState;
    try {
      current = await gateway.getToolApproval(requested.approvalId);
    } catch (error) {
      // A single failed poll is not a decision — the owner may still be looking at the prompt.
      // Keep waiting; the deadline is what ends this.
      options.log?.(`tool approval poll failed, still waiting: ${String(error)}`);
      continue;
    }
    const resolved = decide(
      current.status,
      current.decision,
      current.scope,
      current.activation,
      requiresActivation,
    );
    if (resolved) {
      options.log?.(`tool approval ${resolved.behavior} for ${input.toolName} (${current.status})`);
      return resolved;
    }
  }

  return denied(`${input.toolName} was not approved in time`, options.log);
}

/** Returns undefined while the approval is still pending. */
function decide(
  status: string,
  decision: string | null,
  scope: ToolApprovalScope | null | undefined = "once",
  activation: BoundaryActivation | null | undefined = undefined,
  requiresActivation = false,
): ToolApprovalOutcome | undefined {
  if (decision === "allow") return allowed(scope, activation, requiresActivation);
  if (decision === "deny") return { behavior: "deny", message: "the owner declined this tool call" };
  // No decision yet. `pending` is the normal case; anything else terminal (expired, revoked) is a
  // deny — an approval that ended without an allow was never granted.
  if (status === "pending") return undefined;
  if (status === "auto_allow") return allowed(scope, activation, requiresActivation);
  return { behavior: "deny", message: `approval ended as ${status}` };
}

function allowed(
  scope: ToolApprovalScope | null | undefined,
  activation: BoundaryActivation | null | undefined,
  requiresActivation: boolean,
): ToolApprovalOutcome {
  const verifiedActivation = validActivation(activation) ? activation : undefined;
  if (requiresActivation && !verifiedActivation) {
    return {
      behavior: "deny",
      message: "Aicoo: approval did not include an activatable kernel boundary",
    };
  }
  return {
    behavior: "allow",
    scope: scope === "session" ? "session" : "once",
    ...(verifiedActivation ? { activation: verifiedActivation } : {}),
  };
}

function validActivation(value: BoundaryActivation | null | undefined): value is BoundaryActivation {
  return Boolean(
    value
    && typeof value.grantId === "string" && value.grantId.trim() && value.grantId.length <= 512
    && Number.isSafeInteger(value.grantRevision) && value.grantRevision >= 0
    && typeof value.canonicalFolder === "string" && value.canonicalFolder.trim()
    && value.canonicalFolder.length <= 4_096
    && (value.accessPreset === "read-project" || value.accessPreset === "edit-project")
    && typeof value.expectedBoundaryManifestHash === "string"
    && value.expectedBoundaryManifestHash.trim()
    && value.expectedBoundaryManifestHash.length <= 512,
  );
}

function denied(reason: string, log?: (line: string) => void): ToolApprovalOutcome {
  log?.(`tool denied: ${reason}`);
  return { behavior: "deny", message: `Aicoo: ${reason}` };
}
