import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodexSkill, installCodexSkill } from "../../src/cli/skill-install.js";

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
});
