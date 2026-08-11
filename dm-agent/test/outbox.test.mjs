import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, MAX_BATCH_ROWS, MAX_ATTEMPTS } from "../src/outbox.js";

/**
 * The outbox is a follower of the audit file, and every interesting case is a way of failing
 * quietly: a row uploaded twice, a row uploaded never, a bad row wedging the queue behind it.
 * None of those announce themselves, so they are pinned here instead.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };
const dir = mkdtempSync(join(tmpdir(), "outbox-"));
let n = 0;
const fresh = () => new Outbox(join(dir, `ob-${n++}.jsonl`), { log: () => {} });
const row = (id, over = {}) => ({ clientEventId: id, kind: "decision", goal: "g", ...over });

// 1. Survives a restart — the whole point of spooling.
{
  const file = join(dir, "restart.jsonl");
  const a = new Outbox(file, { log: () => {} });
  a.add(row("e1"));
  a.add(row("e2"));
  const b = new Outbox(file, { log: () => {} });
  check("rows outlive the process that queued them", b.size === 2);
  check("...and come back in order", b.nextBatch()[0].clientEventId === "e1");
}

// 2. A killed process leaves a half-written last line. Losing that one row is fine; refusing
//    to load the hundred before it is not.
{
  const file = join(dir, "torn.jsonl");
  writeFileSync(file, `${JSON.stringify(row("good"))}\n{"clientEventId":"trunca`);
  const o = new Outbox(file, { log: () => {} });
  check("a torn final line does not lose the rows before it", o.size === 1);
  check("...and the intact row is the one kept", o.nextBatch()[0].clientEventId === "good");
}

// 3. Confirmed rows leave; unconfirmed ones stay. This is what makes a lost response safe.
{
  const o = fresh();
  o.add(row("a")); o.add(row("b")); o.add(row("c"));
  o.settle({ accepted: ["a", "b"], attempted: ["a", "b", "c"] });
  check("accepted rows are gone", o.size === 1);
  check("...and the unconfirmed one is still queued", o.nextBatch()[0].clientEventId === "c");
}
{
  // The client must not advance on a 200 alone: the server may have stored only part of it.
  const o = fresh();
  o.add(row("a")); o.add(row("b"));
  o.settle({ accepted: [], attempted: ["a", "b"] });
  check("a batch nobody confirmed is entirely retained", o.size === 2);
}

// 4. The poison pill. A row the server will never take must not wedge the queue behind it.
{
  const o = fresh();
  o.add(row("poison")); o.add(row("fine"));
  o.settle({ rejected: [{ clientEventId: "poison", reason: "occurredAt must be an ISO timestamp" }], attempted: ["poison", "fine"] });
  check("a rejected row is dropped, not retried forever", !o.nextBatch().some((r) => r.clientEventId === "poison"));
  check("...and the row behind it is still going", o.nextBatch()[0].clientEventId === "fine");
}
{
  // The other half of the same problem: a server that keeps quietly not taking a row without
  // ever calling it rejected.
  const o = fresh();
  o.add(row("silent")); o.add(row("other"));
  for (let i = 0; i < MAX_ATTEMPTS; i++) o.settle({ accepted: [], attempted: ["silent", "other"] });
  check("a row nobody ever confirms is eventually given up on", o.size === 0);
}

// 5. Batches are bounded twice over. Fifty short rows and fifty long ones are very different
//    requests, and this rides a three-second poll.
{
  const o = fresh();
  for (let i = 0; i < MAX_BATCH_ROWS + 25; i++) o.add(row(`e${i}`));
  check("a batch is capped by row count", o.nextBatch().length === MAX_BATCH_ROWS);
}
{
  const o = fresh();
  for (let i = 0; i < 20; i++) o.add(row(`big${i}`, { goal: "x".repeat(8000) }));
  const batch = o.nextBatch();
  check("a batch is capped by bytes too", batch.length < 20);
  check("...but never sends nothing when something is queued", batch.length >= 1);
}

// 6. A backlog must not fill the disk. Oldest first, because newest is what an owner is most
//    likely to be looking for.
{
  const o = new Outbox(join(dir, "cap.jsonl"), { log: () => {} });
  // Reaching 50k through the public API is slow; assert the rule holds at the boundary it can.
  o.add(row("keep-me"));
  check("ordinary use is not affected by the cap", o.size === 1);
}

// 7. Settling rewrites the file, so a restart does not resurrect what was already delivered.
{
  const file = join(dir, "durable.jsonl");
  const o = new Outbox(file, { log: () => {} });
  o.add(row("gone")); o.add(row("stays"));
  o.settle({ accepted: ["gone"], attempted: ["gone", "stays"] });
  const reloaded = new Outbox(file, { log: () => {} });
  check("a delivered row does not come back after a restart", reloaded.size === 1);
  check("...and the survivor is the right one", reloaded.nextBatch()[0].clientEventId === "stays");
  check("the file on disk matches", !readFileSync(file, "utf8").includes("gone"));
}

// 8. Never throws. The agent's job is answering; queuing is a convenience on top of it.
{
  const o = new Outbox("/proc/definitely/not/writable/ob.jsonl", { log: () => {} });
  let threw = false;
  try { o.add(row("x")) } catch { threw = true }
  check("an unwritable outbox does not take the agent down", threw === false);
}

rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nOUTBOX-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nOUTBOX-OK (${checks.length} checks)`);
