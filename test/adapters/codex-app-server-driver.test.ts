import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerDriver } from "../../src/adapters/codex/app-server-driver.js";
import type { CodexThreadEvent } from "../../src/adapters/codex/driver.js";
import type { CodexApprovalDecision, CodexApprovalRequest } from "../../src/adapters/codex/app-server-protocol.js";

const FAKE_SERVER = fileURLToPath(new URL("../helpers/fake-codex-app-server.mjs", import.meta.url));
chmodSync(FAKE_SERVER, 0o755);

interface RunResult {
  events: CodexThreadEvent[];
  asked: CodexApprovalRequest[];
  replyText: string | undefined;
}

async function run(options: {
  decision?: CodexApprovalDecision | (() => Promise<CodexApprovalDecision>);
  withoutApprovalRoute?: boolean;
  env?: Record<string, string>;
  writableRoots?: string[];
  permissionProfile?: { codexHome: string; profileName: string };
  turnTimeoutMs?: number;
} = {}): Promise<RunResult> {
  const asked: CodexApprovalRequest[] = [];
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  const onApproval = options.withoutApprovalRoute
    ? undefined
    : async (request: CodexApprovalRequest) => {
      asked.push(request);
      const decision = options.decision ?? "accept";
      return typeof decision === "function" ? await decision() : decision;
    };

  const driver = new CodexAppServerDriver();
  const turn = driver.startTurn({
    prompt: "look at my uncommitted code",
    cwd: process.cwd(),
    codexPath: FAKE_SERVER,
    ...(onApproval ? { onApproval } : {}),
    ...(options.writableRoots ? { writableRoots: options.writableRoots } : {}),
    ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });

  const events: CodexThreadEvent[] = [];
  try {
    for await (const event of turn) {
      events.push(event);
      if (event.type === "turn.completed" || event.type === "turn.failed") break;
      if (event.type === "error" && event.fatal) break;
    }
  } finally {
    turn.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const reply = events.find(
    (event) => event.type === "item.completed" && event.item.type === "agent_message",
  );
  return {
    events,
    asked,
    replyText: reply && reply.type === "item.completed" ? (reply.item.text as string | undefined) : undefined,
  };
}

describe("CodexAppServerDriver", () => {
  it("routes an approval to the owner and sends their answer back to codex", async () => {
    const result = await run({ decision: "accept" });

    expect(result.asked).toHaveLength(1);
    // The owner sees the real command, not a bare tool name — one line has to be decidable.
    expect(result.asked[0]).toMatchObject({
      kind: "commandExecution",
      summary: "Run: /bin/zsh -lc 'git diff'",
      cwd: "/srv/project",
    });
    expect(result.replyText).toBe("decision=accept");
  });

  it("sends a refusal when the owner declines", async () => {
    const result = await run({ decision: "decline" });
    expect(result.replyText).toBe("decision=decline");
  });

  it("passes acceptForSession through so codex stops asking for the rest of the session", async () => {
    const result = await run({ decision: "acceptForSession" });
    expect(result.replyText).toBe("decision=acceptForSession");
  });

  it("refuses when there is no route to the owner at all", async () => {
    // Additive by construction: with nothing wired, behaviour matches the old exec driver's
    // refusal rather than becoming a new way to say yes.
    const result = await run({ withoutApprovalRoute: true });
    expect(result.asked).toHaveLength(0);
    expect(result.replyText).toBe("decision=decline");
  });

  it("treats a failure to reach the owner as a refusal, not as permission", async () => {
    const result = await run({
      decision: async () => {
        throw new Error("control plane unreachable");
      },
    });
    expect(result.replyText).toBe("decision=decline");
  });

  it("holds the turn open while the owner takes their time", async () => {
    // The real budget is five minutes; a live run held 310s and was still honoured. This only
    // has to prove the driver does not answer on its own while the decision is outstanding.
    const started = Date.now();
    const result = await run({
      decision: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return "accept";
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.replyText).toBe("decision=accept");
  });

  it("refuses an approval kind it cannot describe to the owner", async () => {
    const result = await run({
      env: { FAKE_APPROVAL_METHOD: "item/somethingNew/requestApproval", FAKE_APPROVAL_PARAMS: "{}" },
    });
    expect(result.asked).toHaveLength(0);
    expect(result.replyText).toBe("decision=decline");
  });

  it("never widens the sandbox even when the owner accepts", async () => {
    const result = await run({
      decision: "accept",
      env: { FAKE_APPROVAL_METHOD: "item/permissions/requestApproval", FAKE_APPROVAL_PARAMS: '{"permissions":{"full":true}}' },
    });
    expect(result.asked[0]?.kind).toBe("permissions");
    // The fake reports what it received: a permissions grant, which our response left empty.
    expect(result.replyText).toBe("decision=permissions-answered");
  });

  it("normalizes the reply item so the adapter can actually find it", async () => {
    // Regression guard for the trap that would look like "the peer never answered": app-server
    // emits agentMessage, the adapter matches agent_message.
    const result = await run({ env: { FAKE_SKIP_APPROVAL: "1" } });
    const types = result.events.filter((e) => e.type === "item.completed").map((e) => (e as { item: { type?: string } }).item.type);
    expect(types).toContain("agent_message");
    expect(types).not.toContain("agentMessage");
  });

  it("drops deltas and usage chatter instead of forwarding it as turn events", async () => {
    const result = await run({ env: { FAKE_SKIP_APPROVAL: "1" } });
    expect(result.events.map((e) => e.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("reports a fatal error when the server dies mid-turn", async () => {
    const result = await run({ env: { FAKE_EXIT_EARLY: "1" } });
    const fatal = result.events.find((event) => event.type === "error");
    expect(fatal).toMatchObject({ type: "error", fatal: true });
    expect((fatal as { message: string }).message).toContain("exited with code 1");
  });

  it("selects the generated kernel permission profile when starting a thread", async () => {
    const result = await run({
      permissionProfile: { codexHome: "/tmp/aicoo-profile", profileName: "aicoo-c2c" },
      env: { FAKE_SKIP_APPROVAL: "1", FAKE_REPORT_THREAD_START: "1" },
    });
    expect(JSON.parse(result.replyText ?? "{}")).toMatchObject({
      permissions: "aicoo-c2c",
      runtimeWorkspaceRoots: [process.cwd()],
    });
    expect(JSON.parse(result.replyText ?? "{}")).not.toHaveProperty("sandboxPolicy");
  });

  it("negotiates the experimental API before sending runtime workspace roots", async () => {
    // Regression: Codex rejected every injected turn until the bridge exhausted its retries.
    const result = await run({
      permissionProfile: { codexHome: "/tmp/aicoo-profile", profileName: "aicoo-c2c" },
      env: { FAKE_SKIP_APPROVAL: "1", FAKE_REQUIRE_EXPERIMENTAL_API: "1" },
    });

    expect(result.events).toContainEqual(expect.objectContaining({ type: "turn.completed" }));
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "error", fatal: true }));
  });

  it("terminates a full-capability turn that exceeds its execution budget", async () => {
    const result = await run({
      turnTimeoutMs: 25,
      env: { FAKE_HANG_AFTER_TURN_START: "1" },
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "error",
      fatal: true,
      message: expect.stringContaining("execution timeout"),
    }));
  });
});
