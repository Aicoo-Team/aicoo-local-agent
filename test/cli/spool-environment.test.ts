import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function runHelp(spool: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "agents", "--help"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, CCD_SPOOL: spool },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ccd spool environment", () => {
  it("uses CCD_SPOOL as the default for commands launched inside a managed agent", async () => {
    const spool = "/tmp/aicoo-test/omkar/bridge.spool";
    const result = await runHelp(spool);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(spool);
  });
});
