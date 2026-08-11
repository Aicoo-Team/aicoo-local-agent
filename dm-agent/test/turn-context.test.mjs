import { newTurnContext, turnSummary } from "../src/turn-context.js";
import { printableSafe } from "../src/agent.js";

/**
 * An audit row has to say what was being attempted, not only what was touched.
 *
 * "allowed Read on README.md" is a fact with no lesson in it. "someone asked what the project
 * does, README.md was allowed, and the turn then answered" is one. Anything that later learns
 * from these rows — which approvals are routine, which paths a goal legitimately needs, whose
 * agent handles which kind of request well — needs the goal and the outcome. Neither was
 * recorded, and on the Codex runtime neither was the identity.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

// 1. The goal is the asker's own words, and they are untrusted.
{
  const c = newTurnContext({ text: "  what does\n\n this project   do? ", conversationId: "c1", from: "@bob", runtime: "claude", sanitize: printableSafe });
  check("the goal is the question that was asked", c.goal === "what does this project do?");
  check("...whitespace collapsed so one row stays one line", !/\n/.test(c.goal));
  check("...tagged with the runtime that handled it", c.runtime === "claude");
  check("...and the conversation it belongs to", c.conversationId === "c1");
  check("every turn gets an id to group its decisions under", /^[0-9a-f]{8}$/.test(c.turnId));
}
{
  // A log line that can move the cursor is a log line that can lie about the line above it.
  const c = newTurnContext({ text: "ok[2K\rDENIED BY OWNER", sanitize: printableSafe });
  check("control characters never reach the record", !/|\r/.test(c.goal));
}
{
  const c = newTurnContext({ text: "x".repeat(5000), sanitize: printableSafe });
  check("a very long question is truncated", c.goal.length <= 400);
}
{
  const c = newTurnContext({ sanitize: printableSafe });
  check("a turn with no text still produces a usable context", typeof c.goal === "string" && c.turnId.length === 8);
}
{
  const a = newTurnContext({ text: "one", sanitize: printableSafe });
  const b = newTurnContext({ text: "two", sanitize: printableSafe });
  check("two turns are distinguishable", a.turnId !== b.turnId);
}

// 2. The summary is the row that says how it ended — the one the approvals cannot tell you.
{
  const c = newTurnContext({ text: "run the tests", conversationId: "c9", runtime: "codex", sanitize: printableSafe });
  const ok = turnSummary(c, { outcome: "answered", decisions: 3 });
  check("the summary is marked as a turn, not a decision", ok.kind === "turn");
  check("...carries the goal", ok.goal === "run the tests");
  check("...the same turnId its decisions carry", ok.turnId === c.turnId);
  check("...how many decisions it took", ok.decisions === 3);
  check("...and how it ended", ok.outcome === "answered");
}
{
  // Four approvals and then a failure is the most useful row in the table, and it does not
  // exist unless the failure is written down.
  const c = newTurnContext({ text: "do the thing", sanitize: printableSafe });
  const bad = turnSummary(c, { outcome: "failed", error: new Error("model unreachable"), decisions: 4 });
  check("a failed turn is recorded as failed", bad.outcome === "failed");
  check("...with why", /model unreachable/.test(bad.error));
  check("...and still says how many approvals it cost", bad.decisions === 4);
}
{
  const c = newTurnContext({ text: "x", sanitize: printableSafe });
  const ok = turnSummary(c, { outcome: "answered", decisions: 0 });
  check("a turn that needed no approvals says zero, not nothing", ok.decisions === 0);
  check("...and carries no error field when it did not fail", !("error" in ok));
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nTURN-CONTEXT-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nTURN-CONTEXT-OK (${checks.length} checks)`);
