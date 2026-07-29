import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectRuntimeAdapter } from "../../src/adapters/select-adapter.js";

describe("selectRuntimeAdapter relationship policy loading", () => {
  const directories: string[] = [];
  const adapters: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of adapters.splice(0)) await close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  // The default policy path is now ~/.aicoo/local-agent/relationships.json — a file the
  // user never wrote. A bad one there must not stop the bridge from starting: tool
  // access is off either way, so the safe outcome is text-only, not a crash.
  const badPolicies: Array<[string, (file: string, workspace: string) => void]> = [
    ["a policy stored inside the folder it grants", (file, workspace) => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        relationships: [{ principalId: "prn_a", deviceId: "device-a1", tools: ["Read"], folders: [workspace] }],
      }));
    }],
    ["malformed JSON", (file) => writeFileSync(file, "{ not json")],
    ["an unknown key rejected by the strict schema", (file) => {
      writeFileSync(file, JSON.stringify({ version: 1, relationships: [], extra: true }));
    }],
  ];

  for (const [label, write] of badPolicies) {
    it(`starts text-only rather than throwing on ${label}`, async () => {
      const workspace = makeDirectory();
      const policyDirectory = join(workspace, ".aicoo", "local-agent");
      mkdirSync(policyDirectory, { recursive: true });
      const policyFile = join(policyDirectory, "relationships.json");
      write(policyFile, workspace);
      const logs: string[] = [];

      const selection = await selectRuntimeAdapter({
        kind: "claude-code",
        sessions: 1,
        spoolFile: join(workspace, "test.spool"),
        workspace,
        claudeStateFile: join(workspace, "test.claude.db"),
        relationshipPolicyFile: policyFile,
        log: (line) => logs.push(line),
      });
      adapters.push(() => selection.adapter.close?.());

      expect(selection.runtime).toBe("claude-code");
      expect(logs.some((line) => line.includes("relationship policy could not be loaded"))).toBe(true);
    });
  }

  function makeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-select-"));
    directories.push(directory);
    return directory;
  }
});
