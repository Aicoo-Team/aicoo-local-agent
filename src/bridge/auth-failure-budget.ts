export interface AuthenticationFailureBudgetOptions {
  timeoutMs: number;
  now?: () => number;
}

export interface AuthenticationFailureDecision {
  fatal: boolean;
  elapsedMs: number;
  alreadyReported?: boolean;
}

/** Converts an indefinitely retried authentication failure into a bounded lifecycle event. */
export class AuthenticationFailureBudget {
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #firstFailureAt?: number;
  #reported = false;

  constructor(options: AuthenticationFailureBudgetOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? Date.now;
  }

  recordFailure(): AuthenticationFailureDecision {
    const now = this.#now();
    this.#firstFailureAt ??= now;
    const elapsedMs = Math.max(0, now - this.#firstFailureAt);
    if (this.#reported) return { fatal: false, elapsedMs, alreadyReported: true };
    if (elapsedMs < this.#timeoutMs) return { fatal: false, elapsedMs };
    this.#reported = true;
    return { fatal: true, elapsedMs };
  }

  recordRecovery(): void {
    this.#firstFailureAt = undefined;
    this.#reported = false;
  }
}
