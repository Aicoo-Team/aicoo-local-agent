export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  readonly #items: Array<{ value: T; consumed: () => void }> = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Message queue is closed"));
    return new Promise<void>((consumed) => {
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        consumed();
      } else {
        this.#items.push({ value, consumed });
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const item of this.#items.splice(0)) item.consumed();
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item) {
          item.consumed();
          return { done: false, value: item.value };
        }
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
