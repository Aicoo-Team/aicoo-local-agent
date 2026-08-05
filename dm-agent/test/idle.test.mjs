import { IdleClock } from "../src/idle.js";

/**
 * Waiting on the owner is not the turn stalling.
 *
 * The turn has an idle timeout so a wedged runtime cannot hold a message forever. But the
 * clock only reset when a decision came back, so an owner who stepped away for longer than
 * the timeout had their turn killed mid-question — and the visitor was told the agent "kept
 * failing", which blames the machine for a person's coffee break. Three of those and the
 * message was abandoned with nobody at fault.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

// 1. A question in front of the owner disarms the clock, and answering re-arms it.
{
  const clock = new IdleClock(50, () => {});
  clock.start();
  check("a turn on its own is being timed", clock.armed === true);
  clock.pause();
  check("a question to the owner stops the clock", clock.armed === false);
  clock.resume();
  check("their answer starts it again", clock.armed === true);
  clock.stop();
}

// 2. The owner taking longer than the whole timeout does not kill the turn.
{
  let fired = false;
  const clock = new IdleClock(40, () => { fired = true; });
  clock.start();
  clock.pause();
  await new Promise((r) => setTimeout(r, 130)); // >3x the timeout, spent deciding
  check("no timeout fires while the owner is deciding", fired === false);
  clock.resume();
  clock.stop();
  check("...and the turn was never aborted", fired === false);
}

// 3. A turn genuinely on its own still times out — the bound has to still exist.
{
  let fired = false;
  const clock = new IdleClock(40, () => { fired = true; });
  clock.start();
  await new Promise((r) => setTimeout(r, 130));
  check("a turn making no progress is still killed", fired === true);
  clock.stop();
}

// 4. Several questions open at once: the clock stays off until the last one is answered.
{
  const clock = new IdleClock(50, () => {});
  clock.start();
  clock.pause();
  clock.pause();
  check("two open questions, clock off", clock.armed === false);
  clock.resume();
  check("one still open, clock stays off", clock.armed === false && clock.openQuestions === 1);
  clock.resume();
  check("last one answered, clock back on", clock.armed === true);
  clock.stop();
}

// 5. An unbalanced resume must not bank credit that leaves a later question unable to pause.
{
  const clock = new IdleClock(50, () => {});
  clock.start();
  clock.resume();
  clock.resume();
  check("stray resumes cannot go negative", clock.openQuestions === 0);
  clock.pause();
  check("...so the next real question still stops the clock", clock.armed === false);
  clock.resume();
  check("...and answering re-arms it", clock.armed === true);
  clock.stop();
}

// 6. stop() leaves nothing pending — a finished turn must not abort a later one.
{
  let fired = false;
  const clock = new IdleClock(30, () => { fired = true; });
  clock.start();
  clock.stop();
  await new Promise((r) => setTimeout(r, 90));
  check("a stopped clock never fires", fired === false && clock.armed === false);
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nIDLE-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nIDLE-OK (${checks.length} checks)`);
