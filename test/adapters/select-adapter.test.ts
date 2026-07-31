import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectRuntimeAdapter } from "../../src/adapters/select-adapter.js";

describe("selectRuntimeAdapter relationship policy handling", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("continues text-only when the Claude relationship policy cannot be loaded", async () => {
    const directory = makeDirectory();
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, "{not json");
    const log = vi.fn();

    const selected = await selectRuntimeAdapter({
      kind: "claude-code",
      sessions: 1,
      spoolFile: join(directory, "bridge.spool"),
      workspace: directory,
      relationshipPolicyFile: policyFile,
      log,
    });

    expect(selected.runtime).toBe("claude-code");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("relationship policy could not be loaded"));
    selected.adapter.close?.();
  });

  it("continues text-only when the Codex relationship policy cannot be loaded", async () => {
    const directory = makeDirectory();
    const policyFile = join(directory, "relationships.json");
    const codexPath = join(directory, "codex");
    writeFileSync(policyFile, JSON.stringify({ version: 1, relationships: [], extra: true }));
    writeFileSync(codexPath, "#!/bin/sh\n");
    chmodSync(codexPath, 0o700);
    const log = vi.fn();

    const selected = await selectRuntimeAdapter({
      kind: "codex",
      sessions: 1,
      spoolFile: join(directory, "bridge.spool"),
      workspace: directory,
      codexPath,
      relationshipPolicyFile: policyFile,
      log,
    });

    expect(selected.runtime).toBe("codex");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("relationship policy could not be loaded"));
    selected.adapter.close?.();
  });

  it("continues text-only when the relationship policy is inside a granted folder", async () => {
    const directory = makeDirectory();
    const policyFile = join(directory, "relationships.json");
    writeFileSync(policyFile, JSON.stringify({
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [directory],
      }],
    }));
    const log = vi.fn();

    const selected = await selectRuntimeAdapter({
      kind: "claude-code",
      sessions: 1,
      spoolFile: join(directory, "bridge.spool"),
      workspace: directory,
      relationshipPolicyFile: policyFile,
      log,
    });

    expect(selected.runtime).toBe("claude-code");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("relationship policy could not be loaded"));
    selected.adapter.close?.();
  });

  function makeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-select-"));
    directories.push(directory);
    return directory;
  }
});
