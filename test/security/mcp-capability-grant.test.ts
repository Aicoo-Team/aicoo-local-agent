import { describe, expect, it } from "vitest";
import {
  parseRemoteMcpGrants,
  renderCodexRemoteMcpGrants,
} from "../../src/security/mcp-capability-grant.js";

describe("remote MCP capability grants", () => {
  it("projects only exact remote servers and tool allowlists into Codex config", () => {
    const grants = parseRemoteMcpGrants([{
      name: "docs",
      url: "https://mcp.example.com/v1",
      enabledTools: ["search", "read", "search"],
      bearerTokenEnvVar: "DOCS_MCP_TOKEN",
      startupTimeoutSec: 15,
      toolTimeoutSec: 45,
    }]);

    expect(renderCodexRemoteMcpGrants(grants)).toContain([
      '[mcp_servers."docs"]',
      'url = "https://mcp.example.com/v1"',
      'bearer_token_env_var = "DOCS_MCP_TOKEN"',
      'enabled_tools = ["read", "search"]',
      'default_tools_approval_mode = "prompt"',
      "startup_timeout_sec = 15",
      "tool_timeout_sec = 45",
      "enabled = true",
      "required = false",
      "",
      '[mcp_servers."docs".tools."read"]',
      'approval_mode = "approve"',
      "",
      '[mcp_servers."docs".tools."search"]',
      'approval_mode = "approve"',
    ].join("\n"));
  });

  it("rejects host execution, embedded credentials, insecure remote URLs, and broad tool access", () => {
    for (const unsafe of [
      { name: "stdio", command: "node", enabledTools: ["read"] },
      { name: "secret", url: "https://user:pass@mcp.example.com", enabledTools: ["read"] },
      { name: "query-secret", url: "https://mcp.example.com?token=secret", enabledTools: ["read"] },
      { name: "cleartext", url: "http://mcp.example.com", enabledTools: ["read"] },
      { name: "all-tools", url: "https://mcp.example.com", enabledTools: [] },
      { name: "headers", url: "https://mcp.example.com", enabledTools: ["read"], httpHeaders: { Authorization: "secret" } },
    ]) {
      expect(() => parseRemoteMcpGrants([unsafe])).toThrow();
    }
  });

  it("permits cleartext only for an exact loopback host", () => {
    expect(parseRemoteMcpGrants([{
      name: "local",
      url: "http://127.0.0.1:43177/mcp",
      enabledTools: ["inspect"],
    }])).toHaveLength(1);
    expect(() => parseRemoteMcpGrants([{
      name: "lookalike",
      url: "http://localhost.example.com/mcp",
      enabledTools: ["inspect"],
    }])).toThrow();
  });
});
