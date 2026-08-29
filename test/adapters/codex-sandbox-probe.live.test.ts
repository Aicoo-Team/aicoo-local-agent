import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCodexFullAgentSandbox } from "../../src/adapters/codex/sandbox-probe.js";

const codexPath = findCodex();
const supportedPlatform = process.platform === "darwin"
  || process.platform === "linux"
  || process.platform === "win32";

describe.skipIf(!supportedPlatform || !codexPath)("Codex governed sandbox (live)", () => {
  it("writes inside the project while blocking outside reads and writes", async () => {
    await expect(verifyCodexFullAgentSandbox({ codexPath: codexPath!, platform: process.platform }))
      .resolves.toBeUndefined();
  });
});

function findCodex(): string | undefined {
  const names = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat"]
    : ["codex"];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
