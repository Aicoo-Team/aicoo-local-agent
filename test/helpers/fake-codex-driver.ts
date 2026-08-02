import { randomUUID } from "node:crypto";
import type {
  CodexDriver,
  CodexThreadEvent,
  CodexTurn,
  CodexTurnStartInput,
} from "../../src/adapters/codex/driver.js";
import { AsyncMessageQueue } from "../../src/adapters/claude-code/message-queue.js";

export class FakeCodexDriver implements CodexDriver {
  readonly turns: CodexTurnStartInput[] = [];
  resultText: string | ((prompt: string) => string);
  resultDelayMs = 0;
  failTurn = false;
  failBeforeTurnStart = false;
  /** Recoverable `type:"error"` lines emitted mid-turn, the way Codex reports a dropped socket. */
  transientErrors: string[] = [];

  constructor(resultText: string | ((prompt: string) => string) = "reply from managed codex") {
    this.resultText = resultText;
  }

  startTurn(input: CodexTurnStartInput): CodexTurn {
    this.turns.push(input);
    return new FakeCodexTurn(input, this);
  }
}

class FakeCodexTurn implements CodexTurn {
  readonly #events = new AsyncMessageQueue<CodexThreadEvent>();
  #closed = false;

  constructor(
    private readonly input: CodexTurnStartInput,
    private readonly driver: FakeCodexDriver,
  ) {
    void this.run();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexThreadEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  private async run(): Promise<void> {
    try {
      if (this.driver.failBeforeTurnStart) {
        // fatal: this stands in for the real driver synthesizing a non-zero process exit.
        await this.push({ type: "error", message: "codex exited with code 1: no rollout found", fatal: true });
        return;
      }
      const threadId = this.input.resumeThreadId ?? `fake-codex-thread-${randomUUID()}`;
      await this.push({ type: "thread.started", thread_id: threadId });
      await this.push({ type: "turn.started" });
      if (this.driver.resultDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.driver.resultDelayMs));
      }
      if (this.#closed) return;
      for (const message of this.driver.transientErrors) {
        await this.push({ type: "error", message });
        if (this.#closed) return;
      }
      if (this.driver.failTurn) {
        await this.push({ type: "turn.failed", error: { message: "fake codex turn failure" } });
        return;
      }
      const text = typeof this.driver.resultText === "function"
        ? this.driver.resultText(this.input.prompt)
        : this.driver.resultText;
      await this.push({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text },
      });
      await this.push({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    } catch {
      // The consumer closed the turn mid-script; nothing left to emit.
    } finally {
      this.#events.close();
    }
  }

  private push(event: CodexThreadEvent): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#events.push(event);
  }
}
