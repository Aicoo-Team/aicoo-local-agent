import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One agent per state directory.
 *
 * Two agents polling the same links both answer every question, so the visitor gets the same
 * message answered twice by two different runs — and worse, they share a state file, so they
 * overwrite each other's cursors and failure counts. Six of them once produced six replies to
 * one question, half of them from stale code, which read as the product being broken.
 *
 * Nothing about that is exotic: it is one forgotten terminal, or a restart where the old
 * process was still winding down. So the second one refuses to start and says where the first
 * one is.
 */
const LOCK_FILE = "agent.lock";

function alive(pid) {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still running.
    return error?.code === "EPERM";
  }
}

export class LockError extends Error {}

/**
 * Claim the state directory, or explain who already has it.
 * Returns a release function; calling it twice is safe.
 */
export function acquireLock(stateDir, { log } = {}) {
  const file = join(stateDir, LOCK_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  let existing = null;
  try {
    existing = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* no lock, or an unreadable one we are entitled to replace */
  }

  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && alive(existing.pid)) {
    throw new LockError(
      `another agent is already using this state directory (pid ${existing.pid}, started ${existing.startedAt ?? "unknown"}).\n` +
        `   Two agents on the same links answer every question twice and overwrite each other's state.\n` +
        `   Stop that one first:  kill ${existing.pid}    (or use a different --state-dir)`,
    );
  }

  if (existing?.pid) {
    log?.(`[lock] taking over from pid ${existing.pid}, which is no longer running`);
  }

  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only remove our own lock — a takeover elsewhere must not be undone by our exit.
    try {
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (current.pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}
