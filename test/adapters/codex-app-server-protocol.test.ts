import { describe, expect, it } from "vitest";
import {
  APPROVAL_METHODS,
  approvalResponse,
  classifyApproval,
  isTerminalNotification,
  mapNotification,
  normalizeItem,
  normalizeItemType,
  UNKNOWN_APPROVAL_RESPONSE,
} from "../../src/adapters/codex/app-server-protocol.js";

describe("codex app-server protocol translation", () => {
  describe("item type normalization", () => {
    it("renames camelCase items to the snake_case the adapter matches on", () => {
      // The adapter looks for `agent_message`; app-server emits `agentMessage`. Without this the
      // peer's reply never matches and it looks exactly like a peer who chose not to answer.
      expect(normalizeItemType("agentMessage")).toBe("agent_message");
      expect(normalizeItemType("commandExecution")).toBe("command_execution");
      expect(normalizeItemType("reasoning")).toBe("reasoning");
    });

    it("leaves everything else on the item intact", () => {
      expect(normalizeItem({ type: "agentMessage", id: "msg_1", text: "hello" })).toEqual({
        type: "agent_message",
        id: "msg_1",
        text: "hello",
      });
    });

    it("survives an item with no usable type", () => {
      expect(normalizeItem(null)).toEqual({});
      expect(normalizeItem({ id: "x" })).toEqual({ id: "x" });
    });
  });

  describe("notification mapping", () => {
    it("maps a completed agent message into a reply the adapter can read", () => {
      expect(mapNotification("item/completed", { item: { type: "agentMessage", text: "done" } })).toEqual({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      });
    });

    it("maps turn lifecycle notifications", () => {
      expect(mapNotification("turn/started", {})).toEqual({ type: "turn.started" });
      expect(mapNotification("turn/completed", {})).toEqual({ type: "turn.completed" });
      expect(mapNotification("thread/started", { threadId: "th_1" }))
        .toEqual({ type: "thread.started", thread_id: "th_1" });
    });

    it("carries a turn failure reason through in either shape codex uses", () => {
      expect(mapNotification("turn/failed", { error: { message: "rate limited" } }))
        .toEqual({ type: "turn.failed", error: { message: "rate limited" } });
      expect(mapNotification("turn/failed", { error: "boom" }))
        .toEqual({ type: "turn.failed", error: { message: "boom" } });
      expect(mapNotification("turn/failed", {}))
        .toEqual({ type: "turn.failed", error: { message: "codex turn failed" } });
    });

    it("ignores the chatter that carries no meaning for a turn", () => {
      // Deltas, token usage and rate limits arrive constantly; forwarding them would make the
      // adapter's event stream unrecognizable for no gain.
      expect(mapNotification("item/agentMessage/delta", { delta: "he" })).toBeUndefined();
      expect(mapNotification("thread/tokenUsage/updated", {})).toBeUndefined();
      expect(mapNotification("account/rateLimits/updated", {})).toBeUndefined();
    });

    it("knows which notifications end a turn", () => {
      expect(isTerminalNotification("turn/completed")).toBe(true);
      expect(isTerminalNotification("turn/failed")).toBe(true);
      // Verified live: this one fires even when the command was declined and never ran, so it
      // must not be read as the end of anything.
      expect(isTerminalNotification("item/completed")).toBe(false);
    });
  });

  describe("approval classification", () => {
    it("names the actual command so the owner has something decidable", () => {
      const request = classifyApproval(APPROVAL_METHODS.commandExecution, {
        command: "/bin/zsh -lc 'git diff'",
        cwd: "/srv/project",
      });
      expect(request).toMatchObject({
        kind: "commandExecution",
        summary: "Run: /bin/zsh -lc 'git diff'",
        cwd: "/srv/project",
      });
    });

    it("names the files a change would touch", () => {
      expect(classifyApproval(APPROVAL_METHODS.fileChange, {
        changes: [{ path: "/srv/project/app.ts" }, { path: "/srv/project/README.md" }],
      })?.summary).toBe("Modify: /srv/project/app.ts, /srv/project/README.md");

      expect(classifyApproval(APPROVAL_METHODS.fileChange, {
        changes: { "/srv/a.ts": {} },
      })?.summary).toBe("Modify: /srv/a.ts");
    });

    it("still produces a usable summary when the payload omits detail", () => {
      expect(classifyApproval(APPROVAL_METHODS.commandExecution, {})?.summary).toBe("Run a shell command");
      expect(classifyApproval(APPROVAL_METHODS.fileChange, {})?.summary).toBe("Modify files");
    });

    it("refuses to classify a kind it does not understand", () => {
      // An approval we cannot describe to the owner is one we must not answer on their behalf.
      expect(classifyApproval("item/somethingNew/requestApproval", { anything: true })).toBeNull();
      expect(classifyApproval("mcpServer/elicitation/request", {})).toBeNull();
    });
  });

  describe("approval responses", () => {
    it("passes the owner's decision through for commands and file changes", () => {
      const command = classifyApproval(APPROVAL_METHODS.commandExecution, { command: "ls" })!;
      expect(approvalResponse(command, "accept")).toEqual({ decision: "accept" });
      expect(approvalResponse(command, "acceptForSession")).toEqual({ decision: "acceptForSession" });
      expect(approvalResponse(command, "decline")).toEqual({ decision: "decline" });
    });

    it("never widens the sandbox, whatever the owner said", () => {
      // A remote caller's reach is the relationship policy. This path is codex asking for MORE
      // than that, and the answer is always no — answered, so codex is not left hanging.
      const permissions = classifyApproval(APPROVAL_METHODS.permissions, { permissions: { full: true } })!;
      for (const decision of ["accept", "acceptForSession", "decline"] as const) {
        expect(approvalResponse(permissions, decision)).toEqual({ permissions: {}, scope: "turn" });
      }
    });

    it("answers an unknown approval with a refusal codex will accept", () => {
      expect(UNKNOWN_APPROVAL_RESPONSE).toEqual({ decision: "decline" });
    });
  });
});
