import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { PRESET_TOOLS } from "../security/relationship-access.js";
import type { ToolApprovalRequest } from "./aicoo-transport.js";
import type {
  ToolApprovalGateway,
  ToolApprovalScope,
  ToolApprovalState,
} from "./tool-approval.js";

export interface LocalToolApprovalGatewayOptions {
  prompt?: (question: string) => Promise<string>;
  log?: (line: string) => void;
}

/**
 * Which tools an owner may answer once for the whole collaboration.
 *
 * This is the read-only preset, taken from the one table that already defines it rather than
 * restated here. The hand-written list this replaced had the risk ordering backwards: it let a
 * single `s` grant standing `Write` and `Edit` — mutation of the owner's files for the rest of
 * the collaboration — while forcing `GitDiff` and `GitLog`, which are strictly weaker than the
 * `Read` it did allow, back to a prompt on every call and calling them "high-risk" in the log.
 *
 * Deriving it keeps mutation, execution, network, delegation and MCP on `once`, which is the
 * property that matters, and it removes a seventh copy of the tool vocabulary.
 */
const SESSION_SCOPE_TOOLS = new Set<string>(PRESET_TOOLS["read-project"]);

/**
 * Foreground-only approval gateway for the self-hosted localhost control plane.
 * Hosted bridges continue to use Aicoo's durable approval API. This gateway deliberately
 * refuses boundary expansion because a terminal answer cannot mint and attest a server grant.
 */
export class LocalToolApprovalGateway implements ToolApprovalGateway {
  readonly #states = new Map<string, ToolApprovalState>();
  readonly #prompt: (question: string) => Promise<string>;
  readonly #log?: (line: string) => void;
  #promptTail = Promise.resolve();

  constructor(options: LocalToolApprovalGatewayOptions = {}) {
    this.#prompt = options.prompt ?? terminalPrompt;
    this.#log = options.log;
  }

  async requestToolApproval(
    input: ToolApprovalRequest,
  ): Promise<ToolApprovalState & { approvalId: string }> {
    const approvalId = `local_appr_${randomUUID()}`;
    if (input.boundaryExpansion?.requiresSessionRebuild) {
      const state = {
        approvalId,
        status: "unsupported",
        decision: "deny" as const,
        scope: "once" as const,
      };
      this.#states.set(approvalId, state);
      this.#log?.("localhost approval denied: boundary expansion requires an activatable control-plane grant");
      return state;
    }

    let release!: () => void;
    const previous = this.#promptTail;
    this.#promptTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const answer = (await this.#prompt(question(input))).trim().toLowerCase();
      const allowed = answer === "y" || answer === "yes" || answer === "s" || answer === "session";
      const requestedSession = answer === "s" || answer === "session";
      const scope: ToolApprovalScope = requestedSession && SESSION_SCOPE_TOOLS.has(input.toolName)
        ? "session"
        : "once";
      if (requestedSession && scope === "once") {
        this.#log?.(
          `localhost approval for ${input.toolName} limited to once because standing approval is `
          + "only offered for read-only project tools",
        );
      }
      const state = {
        approvalId,
        status: allowed ? "allow" : "deny",
        decision: allowed ? "allow" as const : "deny" as const,
        scope,
      };
      this.#states.set(approvalId, state);
      return state;
    } finally {
      release();
    }
  }

  async getToolApproval(approvalId: string): Promise<ToolApprovalState> {
    return this.#states.get(approvalId) ?? {
      approvalId,
      status: "unknown",
      decision: "deny",
      scope: "once",
    };
  }
}

function question(input: ToolApprovalRequest): string {
  return [
    "\nAicoo localhost tool approval",
    `Capability: ${input.toolName}`,
    `Action: ${input.toolInputSummary}`,
    `Collaboration: ${input.communicationSessionId}`,
    "Allow [y] once, allow [s] for this collaboration, or [N] deny? ",
  ].join("\n");
}

async function terminalPrompt(questionText: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(questionText);
  } finally {
    terminal.close();
  }
}
