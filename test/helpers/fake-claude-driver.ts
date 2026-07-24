import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentDriver,
  ClaudeDriverQuery,
  ClaudeDriverStartInput,
} from "../../src/adapters/claude-code/driver.js";
import { AsyncMessageQueue } from "../../src/adapters/claude-code/message-queue.js";

export interface ReceivedClaudeInput {
  message: SDKUserMessage;
  shouldQuery: boolean;
}

export class FakeClaudeAgentDriver implements ClaudeAgentDriver {
  readonly starts: ClaudeDriverStartInput[] = [];
  readonly received: ReceivedClaudeInput[] = [];
  resultText: string | ((message: SDKUserMessage) => string);
  resultDelayMs = 0;

  constructor(resultText: string | ((message: SDKUserMessage) => string) = "reply from managed Claude") {
    this.resultText = resultText;
  }

  start(input: ClaudeDriverStartInput): ClaudeDriverQuery {
    this.starts.push(input);
    return new FakeClaudeDriverQuery(input, this);
  }
}

class FakeClaudeDriverQuery implements ClaudeDriverQuery {
  readonly #output = new AsyncMessageQueue<SDKMessage>();
  #closed = false;

  constructor(
    private readonly input: ClaudeDriverStartInput,
    private readonly driver: FakeClaudeAgentDriver,
  ) {
    void this.consume();
  }

  async initializationResult(): Promise<unknown> {
    return { commands: [], outputStyle: "default" };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#output.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.#output[Symbol.asyncIterator]();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.input.messages) {
        if (this.#closed) return;
        const shouldQuery = message.shouldQuery !== false;
        this.driver.received.push({ message, shouldQuery });
        await this.#output.push(message as unknown as SDKMessage);
        if (shouldQuery) {
          if (this.driver.resultDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.driver.resultDelayMs));
          }
          if (this.#closed) return;
          const text = typeof this.driver.resultText === "function"
            ? this.driver.resultText(message)
            : this.driver.resultText;
          await this.#output.push({
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            result: text,
            session_id: this.input.options.sessionId ?? this.input.options.resume ?? "fake-session",
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: randomUUID(),
          } as unknown as SDKMessage);
        }
      }
    } finally {
      this.#output.close();
    }
  }
}
