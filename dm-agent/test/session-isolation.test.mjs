import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentState } from "../src/state.js";

/**
 * Two visitors on the same link must not share a model session.
 *
 * There was one sessionId for the whole agent, resumed for every message from anyone. On a
 * share link that meant visitor B's turn ran with visitor A's messages in context. Asked
 * directly, the model declined to repeat them — but that is the model choosing to be discreet,
 * not a mechanism, and it holds only until someone phrases the question differently. The file
 * gate is enforced in code the model cannot reach; this was not enforced anywhere.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };
const dir = mkdtempSync(join(tmpdir(), "session-iso-"));
const fresh = (name) => new AgentState(join(dir, `${name}.json`));

// 1. Separate conversations, separate sessions. This is the whole point.
{
  const s = fresh("split");
  s.setSessionFor("visitor-a", "model-session-A");
  s.setSessionFor("visitor-b", "model-session-B");
  check("each conversation keeps its own model session", s.sessionFor("visitor-a") === "model-session-A");
  check("...and the other one is untouched", s.sessionFor("visitor-b") === "model-session-B");
  check("a conversation nobody has spoken in has none", s.sessionFor("visitor-c") === null);
}

// 2. Continuity WITH YOURSELF is the thing isolation must not break — a visitor asking a
//    follow-up should not be met with amnesia.
{
  const s = fresh("continuity");
  s.setSessionFor("visitor-a", "model-session-A");
  check("the same visitor resumes their own thread", s.sessionFor("visitor-a") === "model-session-A");
  const reloaded = new AgentState(join(dir, "continuity.json"));
  check("...across a restart of the agent", reloaded.sessionFor("visitor-a") === "model-session-A");
}

// 3. Clearing one visitor leaves the others alone.
{
  const s = fresh("clear-one");
  s.setSessionFor("a", "SA");
  s.setSessionFor("b", "SB");
  s.clearSessionFor("a");
  check("clearing one conversation forgets it", s.sessionFor("a") === null);
  check("...and only it", s.sessionFor("b") === "SB");
}

// 4. Clearing everything is what an owner does before handing the link to someone new — but
//    cursors must survive, or the agent replays the entire backlog as if it were new mail.
{
  const s = fresh("clear-all");
  s.setSessionFor("a", "SA");
  s.setSessionFor("b", "SB");
  s.setCursor("guest", 18933);
  s.clearAllSessions();
  check("clearing all forgets every conversation", s.sessionFor("a") === null && s.sessionFor("b") === null);
  check("...but keeps the cursor, or every old message is redelivered", s.cursor("guest") === 18933);
}

// 5. A state file written by an older version has a bare sessionId and no map. It must load,
//    and must not crash the agent on first read.
{
  const file = join(dir, "legacy.json");
  writeFileSync(file, JSON.stringify({ sessionId: "old-single-session", cursors: { guest: 42 }, failures: {}, grants: {} }));
  const s = new AgentState(file);
  check("an older state file still loads", s.cursor("guest") === 42);
  check("...and its conversations start clean rather than inheriting the shared one", s.sessionFor("visitor-a") === null);
  s.setSessionFor("visitor-a", "new-A");
  check("...and writing one does not disturb the legacy field", JSON.parse(readFileSync(file, "utf8")).sessionId === "old-single-session");
}

// 6. No conversation id at all (a dry run, a one-shot) still works, on the single slot.
{
  const s = fresh("no-conv");
  s.setSessionFor(null, "dry-run-session");
  check("a turn with no conversation uses the single slot", s.sessionFor(null) === "dry-run-session");
  check("...and does not leak into a real conversation", s.sessionFor("visitor-a") === null);
}

// 7. Numeric ids and their string form are the same conversation. The guest queue hands back
//    numbers and the DM path hands back strings; keying on the raw value would give one
//    visitor two sessions and lose their history every other message.
{
  const s = fresh("coercion");
  s.setSessionFor(6070, "S6070");
  check("a numeric id round-trips", s.sessionFor(6070) === "S6070");
  check("...and matches its string form", s.sessionFor("6070") === "S6070");
}

rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nSESSION-ISOLATION-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nSESSION-ISOLATION-OK (${checks.length} checks)`);
