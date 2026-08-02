import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CODEX_SKILL_DIR = join(process.env.HOME ?? "", ".codex", "skills", "aicoo-c2c");

export interface InstallCodexSkillResult {
  targetDir: string;
  skillFile: string;
  overwritten: boolean;
}

export function installCodexSkill(options: { targetDir?: string } = {}): InstallCodexSkillResult {
  const targetDir = resolve(options.targetDir ?? DEFAULT_CODEX_SKILL_DIR);
  const skillFile = join(targetDir, "SKILL.md");
  const source = bundledSkillPath();
  const content = readFileSync(source, "utf8");
  const overwritten = existsSync(skillFile);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(skillFile, content);
  return { targetDir, skillFile, overwritten };
}

export function ensureCodexSkill(options: {
  targetDir?: string;
  log?: (line: string) => void;
} = {}): InstallCodexSkillResult | undefined {
  try {
    const result = installCodexSkill({ targetDir: options.targetDir });
    options.log?.(`[codex-skill] ${result.overwritten ? "updated" : "installed"} ${result.skillFile}`);
    return result;
  } catch (error) {
    options.log?.(`[codex-skill] not installed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function bundledSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../skills/codex/aicoo-c2c/SKILL.md"),
    resolve(here, "../skills/codex/aicoo-c2c/SKILL.md"),
    resolve(process.cwd(), "skills/codex/aicoo-c2c/SKILL.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Bundled Aicoo C2C Codex skill was not found.");
  return found;
}
