export class IdlePollBackoff {
  readonly #minimumMs: number;
  readonly #maximumMs: number;
  #currentMs: number;

  constructor(options: { minimumMs: number; maximumMs: number }) {
    this.#minimumMs = options.minimumMs;
    this.#maximumMs = Math.max(options.minimumMs, options.maximumMs);
    this.#currentMs = options.minimumMs;
  }

  next(worked: boolean): number {
    if (worked) {
      this.#currentMs = this.#minimumMs;
      return this.#currentMs;
    }
    this.#currentMs = Math.min(this.#currentMs * 2, this.#maximumMs);
    return this.#currentMs;
  }
}
