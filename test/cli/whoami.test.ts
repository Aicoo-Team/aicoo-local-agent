import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, CCD_AICOO: "0", CCD_SERVER_URL: "" },
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

describe("ccd whoami", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("uses the hosted identity route for an explicitly selected server and spool", async () => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ principalId: "prn_a", deviceId: "device-a" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("whoami test server did not bind TCP");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const testDirectory = await mkdtemp(join(tmpdir(), "aicoo-whoami-"));
    cleanups.push(() => rm(testDirectory, { recursive: true, force: true }));

    const result = await runCli([
      "--token", "aicoo_dev_test",
      "whoami",
      "--server", baseUrl,
      "--spool", join(testDirectory, "bridge.spool"),
    ]);

    expect(result.code, JSON.stringify({ result, requests, baseUrl }, null, 2)).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ principalId: "prn_a" });
    expect(requests).toEqual([{
      url: "/api/v1/local-agent/whoami",
      authorization: "Bearer aicoo_dev_test",
    }]);
  });
});
