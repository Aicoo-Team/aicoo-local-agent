import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { BridgeSpool } from "../../src/bridge/spool.js";
import { parseCollaborationContext } from "../../src/shared/collaboration-context.js";

const objective = "Review my pending diff";

describe("collaboration context capsules", () => {
  it("normalizes and hashes explicitly supplied context", () => {
    const context = parseCollaborationContext({
      summary: "Checkout changes for review",
      items: [{ kind: "diff", label: "git diff", content: "+const enabled = true;", sourcePath: "src/app.ts" }],
      limitations: ["Tests were not run"],
    }, objective);

    expect(context).toEqual({
      objective,
      summary: "Checkout changes for review",
      items: [{
        kind: "diff",
        label: "git diff",
        content: "+const enabled = true;",
        sourcePath: "src/app.ts",
        sha256: createHash("sha256").update("+const enabled = true;").digest("hex"),
      }],
      limitations: ["Tests were not run"],
    });
  });

  it("rejects secret-looking content and forbidden source paths", () => {
    expect(() => parseCollaborationContext({
      summary: "unsafe",
      items: [{ kind: "file_excerpt", label: "env", content: "safe content", sourcePath: ".env.local" }],
      limitations: [],
    }, objective)).toThrow("context_source_forbidden");
    expect(() => parseCollaborationContext({
      summary: "unsafe",
      items: [{ kind: "error", label: "log", content: "api_key=abcdefghijklmnopqrstuvwxyz" }],
      limitations: [],
    }, objective)).toThrow("context_secret_detected");
  });

  it("persists context across pending-delegation retries", () => {
    const spool = new BridgeSpool(":memory:");
    const context = parseCollaborationContext({
      summary: "One diff",
      items: [{ kind: "diff", label: "diff", content: "+change" }],
      limitations: [],
    }, objective);
    spool.storePendingDelegation({
      clientMessageId: "client-1",
      target: { kind: "person_default_runtime", principalId: "peer" },
      task: objective,
      context,
      sessionHandle: "session-a",
      status: "grant_requested",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(spool.listPendingDelegations()).toEqual([
      expect.objectContaining({ clientMessageId: "client-1", context }),
    ]);
    spool.close();
  });
});
