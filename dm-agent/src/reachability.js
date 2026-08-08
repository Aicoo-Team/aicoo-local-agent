/**
 * Deciding when the agent has stopped being reachable, and when to do something about it.
 *
 * On 2026-08-08 a three-day-old agent failed every poll for 37 minutes while the server, the
 * network and the proxy were all fine — a fresh Node process with the identical environment
 * got a 200 in 670ms at the same moment. So the fault was state inside the long-lived process.
 * Which state was never established: `node:undici` is not importable and the global dispatcher
 * slot is gone in Node 25, so the connection pool could be neither inspected nor reset.
 *
 * This deliberately does not act on that guess. The one thing that was verified is that a new
 * process works, so recovery is a new process. That also covers whatever else might wedge in
 * here later, which a dispatcher reset would not.
 *
 * Three thresholds, because the three cases need different answers:
 *   - a blip (~0.3% of polls) is normal and must stay silent, or the signal is worthless;
 *   - a couple of minutes down is worth telling the owner about, and often fixes itself;
 *   - five minutes down is not fixing itself, and a visitor is getting silence.
 */

const MINUTE = 60_000;

export class ReachabilityWatch {
  #downSince = null;
  #warned = false;
  // Separate from #warned on purpose. "it is down" and "I have stopped trying to fix it" are
  // different things to tell someone, and sharing one flag meant a restart's own suppression
  // of the first swallowed the first "I have given up" — the more important of the two.
  #stuckSaid = false;
  #restarts = [];
  #lastRestart = 0;

  /**
   * @param {object} o
   * @param {number} [o.warnAfterMs]      how long down before saying so out loud
   * @param {number} [o.restartAfterMs]   how long down before replacing the process
   * @param {number} [o.minRestartGapMs]  never restart more often than this
   * @param {number} [o.maxRestartsPerHour] beyond this, stop restarting — the fault is not local
   * @param {number[]} [o.priorRestarts] timestamps of restarts by earlier incarnations. Without
   *   these the limits below are decorative: a restart destroys the memory that was supposed to
   *   prevent the next one, and a test respawned three times in forty seconds against a
   *   ten-minute gap because each new process counted from zero.
   * @param {(at: number) => void} [o.onRestart] persist a restart, so the replacement inherits it
   * @param {() => number} [o.now]
   */
  constructor({
    warnAfterMs = 2 * MINUTE,
    restartAfterMs = 5 * MINUTE,
    minRestartGapMs = 10 * MINUTE,
    maxRestartsPerHour = 3,
    priorRestarts = [],
    onRestart = () => {},
    now = () => Date.now(),
  } = {}) {
    this.warnAfterMs = warnAfterMs;
    this.restartAfterMs = restartAfterMs;
    this.minRestartGapMs = minRestartGapMs;
    this.maxRestartsPerHour = maxRestartsPerHour;
    this.onRestart = onRestart;
    this.now = now;
    this.#restarts = [...priorRestarts];
    this.#lastRestart = priorRestarts.length ? Math.max(...priorRestarts) : 0;
  }

  /** True while we are inside a run of failures. */
  get down() { return this.#downSince !== null; }

  /** How long the current run has lasted, or 0 when healthy. */
  get downForMs() { return this.#downSince === null ? 0 : this.now() - this.#downSince; }

  /**
   * A poll (or any other call to Aicoo) worked.
   * @returns {{recovered: boolean, downForMs: number}} recovered is true only if we had said
   *   something, so a silent blip does not produce a "recovered" nobody was waiting for.
   */
  ok() {
    const downForMs = this.downForMs;
    const recovered = this.#warned;
    this.#downSince = null;
    this.#warned = false;
    this.#stuckSaid = false;
    return { recovered, downForMs };
  }

  /**
   * A call to Aicoo failed.
   * @returns {{action: "none"|"warn"|"restart"|"stuck", downForMs: number}}
   *   "stuck" means it has been down long enough to restart, but restarting is not allowed
   *   (too soon, or too many already) — the caller should say so rather than silently do
   *   nothing, because "we gave up trying to fix it" is exactly what the owner needs to know.
   */
  fail() {
    const now = this.now();
    if (this.#downSince === null) this.#downSince = now;
    const downForMs = now - this.#downSince;

    if (downForMs >= this.restartAfterMs) {
      // Only prune here: a restart an hour ago stops counting against us, but the list must
      // not be trimmed on every failure or a slow drip would never accumulate.
      this.#restarts = this.#restarts.filter((at) => now - at < 60 * MINUTE);
      const tooSoon = now - this.#lastRestart < this.minRestartGapMs;
      const tooMany = this.#restarts.length >= this.maxRestartsPerHour;
      if (tooSoon || tooMany) {
        // Say it once per run, not every three seconds.
        const action = this.#stuckSaid ? "none" : "stuck";
        this.#stuckSaid = true;
        this.#warned = true;
        return { action, downForMs, reason: tooMany ? "too many restarts" : "restarted too recently" };
      }
      return { action: "restart", downForMs };
    }

    if (downForMs >= this.warnAfterMs && !this.#warned) {
      this.#warned = true;
      return { action: "warn", downForMs };
    }

    return { action: "none", downForMs };
  }

  /** Record that a restart is being attempted, so the rate limits above can see it. */
  noteRestart() {
    const now = this.now();
    this.#lastRestart = now;
    this.#restarts.push(now);
    // Persisted before the process goes away, not after — there is no after.
    try { this.onRestart(now) } catch { /* a full disk must not stop the recovery */ }
    this.#downSince = now;   // give the replacement a full window before anyone counts against it
    this.#warned = true;     // already spoke; do not warn again on the way out
    this.#stuckSaid = false; // but "the restart did not help" is news, and must still get through
  }
}

/**
 * Replace this process with a fresh one running the same command.
 *
 * The lock goes first and the exit goes last. Releasing first is what lets the replacement
 * take the state directory without having to reason about whether we are still alive; exiting
 * last is what makes a failed spawn survivable — if the new process cannot start, this one is
 * still here, still retrying, which is worse than working but much better than gone.
 *
 * @param {object} o
 * @param {() => void} o.releaseLock
 * @param {(reason: string) => void} o.log
 * @param {Function} o.spawn   node:child_process spawn, injected for tests
 * @param {Function} o.exit    process.exit, injected for tests
 * @returns {boolean} whether the replacement was started
 */
export function respawn({ releaseLock, log, spawn, exit, argv = process.argv, execPath = process.execPath, env = process.env }) {
  log("replacing this process with a fresh one — a new process is the only recovery that was ever verified to work");
  let child;
  try {
    releaseLock();
    child = spawn(execPath, argv.slice(1), { detached: true, stdio: "ignore", env });
    child.unref?.();
  } catch (error) {
    log(`could not start the replacement (${String(error.message ?? error)}) — staying up and continuing to retry`);
    return false;
  }
  if (!child?.pid) {
    log("the replacement did not start — staying up and continuing to retry");
    return false;
  }
  log(`replacement started as pid ${child.pid}; this process is exiting`);
  exit(0);
  return true;
}
