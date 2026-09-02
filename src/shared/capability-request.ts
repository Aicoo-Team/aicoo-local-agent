export const CAPABILITY_REQUEST_TOOL_NAME = "request_capability";

export interface CapabilityRequestArguments {
  capability: string;
  reason: string;
}

export interface CapabilityCatalogueMcpGrant {
  name: string;
  enabledTools: readonly string[];
}

export const CAPABILITY_REQUEST_DYNAMIC_TOOL = {
  type: "function" as const,
  name: CAPABILITY_REQUEST_TOOL_NAME,
  description: "Ask the owner to enable one unavailable capability. This request never executes the capability.",
  inputSchema: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9._:-]{0,199}$",
        description: "Stable identifier such as mcp.lark.search_messages",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Why the current task needs this capability",
      },
    },
    required: ["capability", "reason"],
    additionalProperties: false,
  },
} as const;

const CAPABILITY_ID = /^[a-z0-9][a-z0-9._:-]{0,199}$/u;

export function parseCapabilityRequest(value: unknown): CapabilityRequestArguments | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const capability = typeof input.capability === "string" ? input.capability.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!CAPABILITY_ID.test(capability) || reason.length < 1 || reason.length > 500) return undefined;
  return { capability, reason };
}

export function capabilityRequestSummary(input: CapabilityRequestArguments): string {
  return `Request ${input.capability}: ${input.reason}`;
}

export function approvedCapabilityRequestText(capability: string): string {
  return `The owner approved the request for ${capability}. It is not active yet. Wait for Aicoo to rebuild and expose the exact tool before using it.`;
}

export function capabilityCatalogue(grants: readonly CapabilityCatalogueMcpGrant[]): string {
  const exactMcp = grants.flatMap((grant) => grant.enabledTools.map((tool) =>
    `- mcp.${grant.name}.${tool}`));
  return [
    "Requestable capability catalogue:",
    "- local.read",
    "- local.write",
    "- process.exec",
    "- network.fetch",
    "- network.search",
    "- agent.delegate",
    "- skill.invoke",
    ...exactMcp,
    "If an integration is not listed, call request_capability with mcp.<service>.<tool>.",
    "That asks the owner; it does not execute or activate the capability.",
    "Use it only after Aicoo rebuilds the session and exposes the exact tool.",
  ].join("\n");
}
