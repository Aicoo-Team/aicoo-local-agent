import { ReachabilityWatch, respawn } from "../src/reachability.js";

/**
 * Being unreachable is normal; staying unreachable is not.
 *
 * A three-day-old agent went silent for 37 minutes on 2026-08-08 while the server, the network
 * and the proxy were all fine — a fresh process with identical env succeeded at the same
 * moment. Nothing noticed and nothing recovered. Meanwhile ~0.3% of polls fail on any ordinary
 * day, so anything that reacts to a failure *count* cries wolf: two earlier monitors did
 * exactly that. Duration is the signal.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

const MIN = 60_000;
/** A clock we drive by hand, so a five-minute threshold costs no wall time to test. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms } };
}

// 1. The ordinary case: isolated failures, minutes apart, each recovering. Must be silent —
//    this is 84 events a day and the whole signal dies if they speak.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  let spoke = 0;
  for (let i = 0; i < 30; i++) {
    if (w.fail().action !== "none") spoke += 1;
    c.advance(3_000);
    if (w.ok().recovered) spoke += 1;
    c.advance(20 * MIN);
  }
  check("a day of isolated blips says nothing at all", spoke === 0);
}

// 2. A burst that is still short. Three failures nine seconds apart is the exact shape that
//    made an earlier monitor shout "AGENT IS DEAF" three times.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  const said = [];
  for (let i = 0; i < 3; i++) { said.push(w.fail().action); c.advance(3_000) }
  check("a nine-second burst is still silent", said.every((a) => a === "none"));
  check("...and it is recorded as down while it lasts", w.down === true);
  const { recovered } = w.ok();
  check("...and recovering from it is not worth a message", recovered === false);
}

// 3. Two minutes down: say so, once.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  w.fail();
  c.advance(2 * MIN);
  const first = w.fail();
  check("two minutes down warns", first.action === "warn");
  check("...and reports how long", first.downForMs >= 2 * MIN);
  c.advance(3_000);
  check("...but does not warn again three seconds later", w.fail().action === "none");
  const rec = w.ok();
  check("recovering after a warning IS worth a message", rec.recovered === true);
  check("...with the outage length", rec.downForMs >= 2 * MIN);
  check("...and the watch is healthy again", w.down === false);
}

// 4. Five minutes down: replace the process. This is the 37-minute event, cut to five.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  w.fail();
  c.advance(2 * MIN); w.fail();          // warned
  c.advance(3 * MIN);
  check("five minutes down asks for a restart", w.fail().action === "restart");
}

// 5. Restarting must not become a loop. A machine with its wifi off would otherwise respawn
//    forever, and each new process starts the clock again with no memory of the last.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  w.fail(); c.advance(5 * MIN);
  check("first restart is allowed", w.fail().action === "restart");
  w.noteRestart();
  c.advance(5 * MIN);
  const second = w.fail();
  check("a second restart five minutes later is refused", second.action === "stuck");
  check("...and says why", /too recently/.test(second.reason ?? ""));
  c.advance(3_000);
  check("...and says it only once, not every poll", w.fail().action === "none");
}
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now, minRestartGapMs: 0 });
  for (let i = 0; i < 3; i++) {
    w.fail(); c.advance(5 * MIN);
    if (w.fail().action === "restart") w.noteRestart();
    c.advance(1 * MIN);
    w.ok();
  }
  w.fail(); c.advance(5 * MIN);
  const fourth = w.fail();
  check("a fourth restart within the hour is refused", fourth.action === "stuck");
  check("...because the fault is evidently not process-local", /too many/.test(fourth.reason ?? ""));
}
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now, minRestartGapMs: 0 });
  for (let i = 0; i < 3; i++) {
    w.fail(); c.advance(5 * MIN);
    if (w.fail().action === "restart") w.noteRestart();
    c.advance(1 * MIN);
    w.ok();
  }
  c.advance(61 * MIN); // the hour rolls off
  w.fail(); c.advance(5 * MIN);
  check("once the hour has passed, restarting is allowed again", w.fail().action === "restart");
}

// 5b. The limits above only mean anything if they survive the restart they are limiting.
//     A real respawn test went three times in forty seconds against a ten-minute gap, because
//     every replacement was a new process with an empty history.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now, priorRestarts: [c.now() - 2 * MIN] });
  w.fail(); c.advance(5 * MIN);
  const after = w.fail();
  check("a replacement inherits the restart its parent just did", after.action === "stuck");
  check("...and knows why it may not go again", /too recently/.test(after.reason ?? ""));
}
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now, priorRestarts: [c.now() - 90 * MIN] });
  w.fail(); c.advance(5 * MIN);
  check("a restart from ninety minutes ago does not hold it back", w.fail().action === "restart");
}
{
  const c = clock();
  const persisted = [];
  const w = new ReachabilityWatch({ now: c.now, onRestart: (at) => persisted.push(at) });
  w.fail(); c.advance(5 * MIN); w.fail();
  w.noteRestart();
  check("a restart is handed to the caller to persist", persisted.length === 1);
  check("...stamped when it happened", persisted[0] === c.now());
}
{
  // A full disk must not be the reason the agent cannot recover.
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now, onRestart: () => { throw new Error("ENOSPC") } });
  w.fail(); c.advance(5 * MIN); w.fail();
  let threw = false;
  try { w.noteRestart() } catch { threw = true }
  check("a failure to persist does not abort the restart", threw === false);
}

// 6. noteRestart gives the replacement a clean window rather than inheriting a spent one.
{
  const c = clock();
  const w = new ReachabilityWatch({ now: c.now });
  w.fail(); c.advance(5 * MIN); w.fail();
  w.noteRestart();
  c.advance(3_000);
  check("the moment after a restart is not itself an outage", w.fail().action === "none");
}

// 7. respawn: a spawn that fails must leave this process alive. Exiting on a failed spawn
//    trades a degraded agent for no agent at all.
{
  const said = [];
  let exited = false;
  const ok = respawn({
    releaseLock: () => {},
    log: (m) => said.push(m),
    spawn: () => { throw new Error("EAGAIN") },
    exit: () => { exited = true },
    argv: ["node", "cli.js", "start"],
  });
  check("a spawn that throws does not restart", ok === false);
  check("...and above all does not exit", exited === false);
  check("...and says the agent is still up", /staying up/.test(said.join("\n")));
}
{
  let exited = false;
  const ok = respawn({
    releaseLock: () => {},
    log: () => {},
    spawn: () => ({ pid: undefined, unref() {} }),
    exit: () => { exited = true },
  });
  check("a spawn that yields no pid does not restart", ok === false);
  check("...and does not exit either", exited === false);
}

// 8. respawn: the lock must be gone before the replacement starts, or it refuses to boot
//    against a state directory this process still appears to hold.
{
  const order = [];
  let exited = false;
  respawn({
    releaseLock: () => order.push("release"),
    log: () => {},
    spawn: (...a) => { order.push("spawn"); return { pid: 4242, unref: () => order.push("unref") } },
    exit: () => { order.push("exit"); exited = true },
    argv: ["node", "/x/cli.js", "start", "--peer", "bob"],
  });
  check("the lock is released before the replacement spawns", order.indexOf("release") < order.indexOf("spawn"));
  check("...and the process exits only after it is running", order.indexOf("exit") > order.indexOf("spawn"));
  check("...and the child is unref'd so it outlives us", order.includes("unref"));
  check("...and it does exit", exited === true);
}
{
  // The replacement has to be the same command, or a restart quietly changes the agent's
  // configuration — different folder, different peer, different policy.
  let got;
  respawn({
    releaseLock: () => {},
    log: () => {},
    spawn: (exe, args) => { got = { exe, args }; return { pid: 1, unref() {} } },
    exit: () => {},
    argv: ["/usr/bin/node", "/x/cli.js", "start", "--peer", "bob", "--state-dir", "/s"],
    execPath: "/usr/bin/node",
  });
  check("the replacement runs the same interpreter", got.exe === "/usr/bin/node");
  check("...with the same arguments", got.args.join(" ") === "/x/cli.js start --peer bob --state-dir /s");
}

// 9. The replacement must not be spawned blind. A crash before it opens its own log file is
//    otherwise invisible — which is exactly what happened: a real restart left seven lines in
//    the log, no explanation, and no agent running.
{
  let got;
  respawn({
    releaseLock: () => {},
    log: () => {},
    spawn: (_e, _a, opts) => { got = opts; return { pid: 7, unref() {} } },
    exit: () => {},
    stdio: ["ignore", "ignore", 42],
  });
  check("the replacement's stderr lands in the log", JSON.stringify(got.stdio) === "[\"ignore\",\"ignore\",42]");
  check("...and is detached so it outlives its parent", got.detached === true);
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nREACHABILITY-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nREACHABILITY-OK (${checks.length} checks)`);
