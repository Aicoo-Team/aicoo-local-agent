import { z } from "zod";

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const MCP_TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export const remoteMcpGrantSchema = z.object({
  name: z.string().regex(MCP_NAME),
  url: z.string().trim().min(1).max(2_048),
  enabledTools: z.array(z.string().regex(MCP_TOOL_NAME)).min(1).max(64),
  bearerTokenEnvVar: z.string().regex(ENVIRONMENT_NAME).optional(),
  startupTimeoutSec: z.number().int().min(1).max(30).default(10),
  toolTimeoutSec: z.number().int().min(1).max(120).default(60),
}).strict().superRefine((grant, context) => {
  let endpoint: URL;
  try {
    endpoint = new URL(grant.url);
  } catch {
    context.addIssue({ code: "custom", path: ["url"], message: "MCP URL is invalid" });
    return;
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", path: ["url"], message: "MCP URL must use HTTPS or exact loopback HTTP" });
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "MCP URL cannot contain credentials, query parameters, or fragments",
    });
  }
});

export const remoteMcpGrantsSchema = z.array(remoteMcpGrantSchema).max(16).superRefine((grants, context) => {
  const seen = new Set<string>();
  for (const [index, grant] of grants.entries()) {
    if (seen.has(grant.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "MCP server names must be unique" });
    }
    seen.add(grant.name);
  }
});

export type RemoteMcpGrant = z.infer<typeof remoteMcpGrantSchema>;
export type RemoteMcpGrantInput = z.input<typeof remoteMcpGrantSchema>;

/** Validate and canonicalize the exact remote integrations an owner granted to one peer device. */
export function parseRemoteMcpGrants(value: unknown): RemoteMcpGrant[] {
  return remoteMcpGrantsSchema.parse(value)
    .map((grant) => ({
      ...grant,
      enabledTools: [...new Set(grant.enabledTools)].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Render only the grant contract, never ambient owner config. Unknown tools stay hidden and each
 * visible tool is pre-approved only because the Aicoo relationship grant named it explicitly.
 */
export function renderCodexRemoteMcpGrants(value: unknown): string {
  const grants = parseRemoteMcpGrants(value);
  return grants.flatMap((grant) => [
    `[mcp_servers.${tomlString(grant.name)}]`,
    `url = ${tomlString(grant.url)}`,
    ...(grant.bearerTokenEnvVar
      ? [`bearer_token_env_var = ${tomlString(grant.bearerTokenEnvVar)}`]
      : []),
    `enabled_tools = ${tomlArray(grant.enabledTools)}`,
    'default_tools_approval_mode = "prompt"',
    `startup_timeout_sec = ${grant.startupTimeoutSec}`,
    `tool_timeout_sec = ${grant.toolTimeoutSec}`,
    "enabled = true",
    "required = false",
    "",
    ...grant.enabledTools.flatMap((tool) => [
      `[mcp_servers.${tomlString(grant.name)}.tools.${tomlString(tool)}]`,
      'approval_mode = "approve"',
      "",
    ]),
  ]).join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
