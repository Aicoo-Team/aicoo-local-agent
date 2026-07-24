import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeDriverStartInput {
  messages: AsyncIterable<SDKUserMessage>;
  options: Options;
}

export interface ClaudeDriverQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<unknown>;
  close(): void;
}

export interface ClaudeAgentDriver {
  start(input: ClaudeDriverStartInput): ClaudeDriverQuery;
}

export class OfficialClaudeAgentDriver implements ClaudeAgentDriver {
  start(input: ClaudeDriverStartInput): Query {
    return query({ prompt: input.messages, options: input.options });
  }
}
