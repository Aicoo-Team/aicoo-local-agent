import { randomUUID } from "node:crypto";

/**
 * What a turn was trying to do, carried alongside every decision it produces.
 *
 * The audit recorded the tool and the path and nothing about why. "allowed Read on README.md"
 * is a fact with no lesson in it; "someone asked what the project does, and reading README.md
 * was allowed, and the turn then succeeded" is one. Anything that later learns from these
 * records — which approvals were routine, which paths a goal legitimately needs, whose agent
 * handles which kind of request well — needs the goal and the outcome, not just the call.
 *
 * The goal is the visitor's own words, so it is untrusted text. It is written to a local
 * JSONL file and never executed, but it is truncated and stripped of control characters all
 * the same: a log line that can move the cursor is a log line that can lie about the line
 * above it.
 */
const MAX_GOAL_CHARS = 400;

export function newTurnContext({ text, conversationId, from, runtime, sanitize }) {
  const clean = sanitize ?? ((v) => String(v));
  return {
    turnId: randomUUID().slice(0, 8),
    // Grouping key. One turn produces many decisions and they only make sense together —
    // three approvals for one question is a different story from three separate questions.
    conversationId: conversationId ?? null,
    goal: clean(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, MAX_GOAL_CHARS),
    from: from ?? null,
    runtime: runtime ?? null,
    startedAt: new Date().toISOString(),
  };
}

/**
 * The one line per turn that says how it ended.
 *
 * Without it the record has the questions and not the answer: a goal that produced four
 * approvals and then failed anyway is the most useful row in the table, and it is invisible
 * if only the approvals are written.
 */
export function turnSummary(context, { outcome, error, decisions }) {
  return {
    kind: "turn",
    turnId: context.turnId,
    conversationId: context.conversationId,
    runtime: context.runtime,
    goal: context.goal,
    outcome, // "answered" | "failed" | "abandoned"
    ...(error ? { error: String(error).slice(0, 200) } : {}),
    decisions: decisions ?? 0,
    startedAt: context.startedAt,
  };
}
