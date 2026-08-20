import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { startTestServer, TOKENS } from "../helpers/harness.js";

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

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.ok, `${method} ${path} returned ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}

async function registerSession(baseUrl: string, token: string, label: string) {
  const endpoint = await request<{ endpointId: string }>(baseUrl, token, "/api/v1/endpoints", "POST", {
    runtime: "codex",
    bridgeVersion: "test",
    adapterVersion: "fake-0.1.0",
    capabilities: ["listSessions", "liveInject"],
  });
  const session = await request<{ sessionHandle: string }>(
    baseUrl,
    token,
    `/api/v1/endpoints/${endpoint.endpointId}/sessions`,
    "POST",
    {
      label,
      state: "idle",
      deliveryMode: "managed_stream",
      capabilities: { liveInject: true, midTurnSteer: false, replyEvents: false },
      allowInbound: true,
      allowMidTurnSteer: false,
    },
  );
  return { endpoint, session };
}

describe("local reference connection commands", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("accepts a pending connection through an explicitly selected local control plane", async () => {
    const testServer = await startTestServer();
    cleanups.push(testServer.close);
    const testDirectory = await mkdtemp(join(tmpdir(), "aicoo-local-accept-"));
    cleanups.push(() => rm(testDirectory, { recursive: true, force: true }));
    const spoolFile = join(testDirectory, "recipient.spool");
    const policyFile = join(testDirectory, "relationships.json");
    const spool = new BridgeSpool(spoolFile);
    spool.setIdentity("relationshipPolicyFile", policyFile);
    spool.close();
    const requester = await registerSession(testServer.baseUrl, TOKENS.a, "Requester");
    const recipient = await registerSession(testServer.baseUrl, TOKENS.b, "Recipient");
    await request(testServer.baseUrl, TOKENS.b, "/api/v1/default-route", "PUT", {
      endpointId: recipient.endpoint.endpointId,
      sessionHandle: recipient.session.sessionHandle,
    });
    const pending = await request<{ id: string }>(testServer.baseUrl, TOKENS.a, "/api/v1/comm-sessions", "POST", {
      target: { kind: "person_default_runtime", principalId: "prn_b" },
      replyEndpointId: requester.endpoint.endpointId,
      replySessionHandle: requester.session.sessionHandle,
      requestedTtlMinutes: 30,
    });

    const result = await runCli([
      "--token", TOKENS.b,
      "connect", "accept", pending.id,
      "--server", testServer.baseUrl,
      "--spool", spoolFile,
      "--access", "chat-only",
    ]);

    expect(result, result.stderr || result.stdout).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ accessPolicy: { policyFile } });
    const sessions = await request<Array<{ id: string; status: string }>>(
      testServer.baseUrl,
      TOKENS.b,
      "/api/v1/comm-sessions",
    );
    expect(sessions).toContainEqual(expect.objectContaining({ id: pending.id, status: "active" }));
  });
});
