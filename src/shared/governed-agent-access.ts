export const GOVERNED_AGENT_SURFACE = "surface:governed-agent-v1";

export const GOVERNED_AGENT_CAPABILITIES = [
  "capability:workspace-files",
  "capability:git",
  "capability:test-build",
  "capability:command-exec",
  "capability:mcp-filtered",
  "guard:workspace-boundary",
  "guard:owner-approval",
  "guard:interactive-approval",
  "guard:command-hardening",
  "guard:execution-timeout",
  "guard:credential-isolation",
  "guard:output-redaction",
  "guard:policy-revocation",
] as const;
