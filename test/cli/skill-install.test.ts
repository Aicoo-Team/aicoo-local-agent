import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureClaudeSkill,
  ensureCodexSkill,
  installClaudeSkill,
  installCodexSkill,
} from "../../src/cli/skill-install.js";

describe("Codex skill installer", () => {
  it("installs the bundled local-to-local delegation skill", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-codex-skill-"));

    const result = installCodexSkill({ targetDir: join(directory, "aicoo-c2c") });

    expect(result.overwritten).toBe(false);
    const installed = readFileSync(result.skillFile, "utf8");
    expect(installed).toMatch(/^---\nname: aicoo-c2c\n/s);
    expect(installed).toContain("ccd delegate @username");
    expect(installed).toContain("local Aicoo bridge <-> Aicoo relay");
    expect(installed).toContain("stays open while approval or execution is pending");
    expect(installed).toContain("Use `--no-wait` only when the user explicitly wants asynchronous dispatch");
    expect(installed).toContain("--context-file");
    expect(installed).toContain("Never attach raw memory");
    expect(installed).toContain("ccd agents --json");
    expect(installed).toContain("Who knows what? Who can do what?");
    expect(installed).toContain("If the directory is empty");
    expect(installed).toContain("A failed directory command is not an empty directory");
    expect(installed).toContain("do not gate the delegation on directory discovery");
    expect(installed).toContain("Use the globally installed `ccd` executable");
    expect(installed).toContain("Never invent, search for, infer, or reuse a spool file");
    expect(installed).toContain("bridge_configuration_missing");
    expect(installed).toContain("canonical production profile");
    expect(installed).toContain("https://www.aicoo.io");
    expect(installed).toContain("custom or multi-profile setup");
    expect(installed).toContain("Never diagnose a missing Collaborate connection from an empty directory alone");
    expect(installed).toContain("Only an explicit approval ID means an approval is pending");
    expect(installed).toContain("A running command is not evidence that the owner has not acted");
    expect(installed).toContain("never tell the user\nthat approval is still pending");
    expect(installed).toContain("The same delegation is still running; I’ll continue waiting.");
    expect(installed).toContain("transcript of agent conversations");
    expect(installed).toContain("Local first result:");
    expect(installed).toContain("goal:enterprise-proposal:engineering");
    expect(installed).toContain("ccd goal --plan-file <path>");
  });

  it("can be safely ensured during bridge start", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-codex-skill-auto-"));
    const logs: string[] = [];

    const first = ensureCodexSkill({ targetDir: join(directory, "aicoo-c2c"), log: (line) => logs.push(line) });
    const second = ensureCodexSkill({ targetDir: join(directory, "aicoo-c2c"), log: (line) => logs.push(line) });

    expect(first?.overwritten).toBe(false);
    expect(second?.overwritten).toBe(true);
    expect(logs[0]).toContain("installed");
    expect(logs[1]).toContain("updated");
  });

  it("installs the same orchestration skill for Claude Code", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccd-claude-skill-"));
    const targetDir = join(directory, "aicoo-c2c");

    const installed = installClaudeSkill({ targetDir });
    const ensured = ensureClaudeSkill({ targetDir });

    expect(readFileSync(installed.skillFile, "utf8")).toContain("ccd agents --json");
    expect(ensured?.overwritten).toBe(true);
  });
});
