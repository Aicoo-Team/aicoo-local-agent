/**
 * The clock that decides a turn has stalled.
 *
 * A turn needs an upper bound or a wedged runtime holds a message forever. But "no progress
 * for N seconds" is the wrong measure the moment a human is in the loop: an owner deciding
 * whether to approve a file read is the system working, not the system stuck. Counting their
 * thinking time as a stall killed turns mid-question, and the visitor was told the agent
 * "kept failing" — blaming the machine for a person's coffee break.
 *
 * So the clock is paused for as long as any question is open, and only counts while the turn
 * is genuinely on its own.
 */
export class IdleClock {
  #timeoutMs;
  #onTimeout;
  #timer = null;
  /** Questions currently in front of the owner. While any is open, nothing is armed. */
  #open = 0;

  constructor(timeoutMs, onTimeout) {
    this.#timeoutMs = timeoutMs;
    this.#onTimeout = onTimeout;
  }

  /** True when a timer is actually pending — the property the tests assert on. */
  get armed() {
    return this.#timer !== null;
  }

  get openQuestions() {
    return this.#open;
  }

  #arm() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#open === 0) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#onTimeout();
      }, this.#timeoutMs);
      // Do not hold the process open just to police a turn that has already finished.
      this.#timer.unref?.();
    }
  }

  start() {
    this.#open = 0;
    this.#arm();
  }

  /** Progress happened. */
  refresh() {
    this.#arm();
  }

  /** A question went to the owner. */
  pause() {
    this.#open += 1;
    this.#arm();
  }

  /**
   * A question came back. Clamped at zero: an unbalanced resume must not bank credit that
   * leaves a later question unable to pause the clock, which would put us back where we
   * started with no visible cause.
   */
  resume() {
    this.#open = Math.max(0, this.#open - 1);
    this.#arm();
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#open = 0;
  }
}
