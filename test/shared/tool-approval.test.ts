import { describe, expect, it, vi } from "vitest";
import {
  awaitToolApproval,
  type ToolApprovalGateway,
} from "../../src/shared/tool-approval.js";
import { summarizeToolInput } from "../../src/adapters/claude-code/claude-code-adapter.js";

const REQUEST = {
  communicationSessionId: "comm_1",
  sessionHandle: "claude-managed-1",
  toolName: "Read",
  toolInputSummary: "Read /srv/project/app.ts",
};

/** Injected so the poll loop runs instantly and deterministically. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function gateway(
  request: Partial<{
    approvalId: string;
    status: string;
    decision: "allow" | "deny" | null;
    scope: "once" | "session" | null;
  }> | Error,
  polls: Array<{
    status: string;
    decision: "allow" | "deny" | null;
    scope?: "once" | "session" | null;
  } | Error> = [],
): ToolApprovalGateway & { pollCount: () => number } {
  let i = 0;
  return {
    pollCount: () => i,
    async requestToolApproval() {
      if (request instanceof Error) throw request;
      return { approvalId: "appr_1", status: "pending", decision: null, ...request };
    },
    async getToolApproval() {
      const next = polls[Math.min(i, polls.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next ?? { status: "pending", decision: null };
    },
  };
}

describe("just-in-time tool approval", () => {
  it("allows a policy hit without ever asking the owner", async () => {
    const g = gateway({ status: "auto_allow", decision: "allow" });
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome).toEqual({ behavior: "allow", scope: "once" });
    // The control plane already decided — polling would be a pointless round trip.
    expect(g.pollCount()).toBe(0);
  });

  it("waits on a pending approval and allows once the owner approves", async () => {
    const g = gateway({ status: "pending", decision: null }, [
      { status: "pending", decision: null },
      { status: "pending", decision: null },
      { status: "allow", decision: "allow" },
    ]);
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome).toEqual({ behavior: "allow", scope: "once" });
    expect(g.pollCount()).toBe(3);
  });

  it("denies when the owner declines", async () => {
    const g = gateway({ status: "pending", decision: null }, [{ status: "deny", decision: "deny" }]);
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome.behavior).toBe("deny");
    expect(outcome.behavior === "deny" && outcome.message).toMatch(/declined/i);
  });

  it("fails closed when the approval cannot be requested at all", async () => {
    // A network error must never read as permission. This is the property that matters most.
    const g = gateway(new Error("network down"));
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome.behavior).toBe("deny");
  });

  it("keeps waiting through a failed poll rather than treating it as a decision", async () => {
    const g = gateway({ status: "pending", decision: null }, [
      new Error("transient"),
      { status: "allow", decision: "allow" },
    ]);
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome).toEqual({ behavior: "allow", scope: "once" });
  });

  it("denies when the owner never answers", async () => {
    const g = gateway({ status: "pending", decision: null }, [{ status: "pending", decision: null }]);
    const outcome = await awaitToolApproval(g, REQUEST, {
      ...fakeClock(),
      pollMs: 1_000,
      timeoutMs: 5_000,
    });
    expect(outcome.behavior).toBe("deny");
    expect(outcome.behavior === "deny" && outcome.message).toMatch(/not approved in time/i);
  });

  it("treats any terminal non-allow status as a deny", async () => {
    // An approval that ended without an allow was never granted, whatever it ended as.
    const g = gateway({ status: "pending", decision: null }, [{ status: "expired", decision: null }]);
    const outcome = await awaitToolApproval(g, REQUEST, fakeClock());
    expect(outcome.behavior).toBe("deny");
    expect(outcome.behavior === "deny" && outcome.message).toMatch(/expired/);
  });

  it("stops waiting at the deadline instead of running forever", async () => {
    const clock = fakeClock();
    const sleep = vi.fn(clock.sleep);
    const g = gateway({ status: "pending", decision: null }, [{ status: "pending", decision: null }]);
    await awaitToolApproval(g, REQUEST, { now: clock.now, sleep, pollMs: 1_000, timeoutMs: 4_000 });
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("preserves a collaboration-scoped allow returned by Pulse", async () => {
    const g = gateway({ status: "pending", decision: null }, [
      { status: "allow", decision: "allow", scope: "session" },
    ]);
    await expect(awaitToolApproval(g, REQUEST, fakeClock())).resolves.toEqual({
      behavior: "allow",
      scope: "session",
    });
  });
});

describe("approval prompt text", () => {
  it("names the target, since that is all the owner sees", () => {
    expect(summarizeToolInput("Read", { file_path: "/srv/project/app.ts" })).toBe("Read /srv/project/app.ts");
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("Bash npm test");
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("Grep TODO");
  });

  it("degrades to compact JSON rather than showing a bare tool name", () => {
    expect(summarizeToolInput("Weird", { a: 1 })).toBe('Weird {"a":1}');
    expect(summarizeToolInput("Weird", undefined)).toBe("Weird undefined");
  });

  it("bounds the length so a huge input cannot flood the popup", () => {
    expect(summarizeToolInput("Read", { file_path: "/" + "x".repeat(9_000) }).length).toBeLessThanOrEqual(500);
  });
});
