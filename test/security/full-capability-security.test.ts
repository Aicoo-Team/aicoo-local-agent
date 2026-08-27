import { describe, expect, it } from "vitest";
import {
  credentialEnvironmentRules,
  hardenBashInput,
  redactToolOutput,
} from "../../src/security/full-capability-security.js";

describe("full capability runtime security", () => {
  it("forces shell calls into the sandbox and caps their runtime", () => {
    expect(hardenBashInput({
      command: "npm test",
      timeout: 900_000,
      dangerouslyDisableSandbox: true,
    })).toEqual({
      behavior: "allow",
      updatedInput: {
        command: "npm test",
        timeout: 120_000,
        dangerouslyDisableSandbox: false,
      },
    });
    expect(hardenBashInput({ command: "bad\0command" })).toMatchObject({ behavior: "deny" });
  });

  it("denies credential environment variables to sandboxed commands", () => {
    expect(credentialEnvironmentRules({
      PATH: "/bin",
      AICOO_API_KEY: "secret",
      DATABASE_URL: "postgres://private",
      NODE_ENV: "test",
    })).toEqual([
      { name: "AICOO_API_KEY", mode: "deny" },
      { name: "DATABASE_URL", mode: "deny" },
    ]);
  });

  it("redacts secret-shaped fields, tokens, and known environment values recursively", () => {
    expect(redactToolOutput({
      result: "token ghp_abcdefghijklmnopqrstuvwxyz123456 and private-value",
      nested: { access_token: "should-not-survive", count: 2 },
    }, { PRIVATE_TOKEN: "private-value" })).toEqual({
      result: "token [REDACTED] and [REDACTED]",
      nested: { access_token: "[REDACTED]", count: 2 },
    });
  });
});
