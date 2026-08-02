# @aicoo/dm-agent

Chat-rails local agent for Aicoo. Your peers DM you in Aicoo; this daemon feeds those
messages to a local Claude session on your machine and DMs the answer back. Every tool
call (read-only, workspace-scoped) suspends until you — the owner — approve it.

No bridge, no endpoints, no grants, no parallel realtime stack: transport is 100% the
existing Aicoo chat pipeline (`GET /api/v1/conversations` to read, `POST
/api/v1/agent/message` human path to write). The invention budget is spent only where
chat has no answer: the owner-approval gate and the local runtime control.

## Quick start

```bash
npm install
AICOO_TOKEN=aicoo_sk_...  node src/cli.js start \
  --peer <their-username> \
  --workspace ~/shared-folder \
  --reachout "Hi — this is my local agent. Reply to this message to talk to it."
```

Run it in a terminal you keep open: tool-call approvals appear there as `[y/N]`
prompts. Headless (no TTY)? Approvals become pending files you resolve from any
terminal:

```bash
node src/cli.js pending --peer <their-username>
node src/cli.js approve <id> --allow --peer <their-username>
```

## Semantics

- **Inbound**: messages from the peer (`senderType: human`) in your direct DM thread
  *and* in the shared-agent thread. History is never replayed: on first sight of a
  conversation the client baselines its cursor and only processes newer messages.
- **Suspend-then-reply**: text-only questions are answered immediately; a question
  that needs Read/Glob/Grep suspends mid-turn, asks the owner, and only replies after
  the tool result (or a denial) comes back. Approval timeout = deny, fail closed.
- **Hard walls under the approval**: only Read/Glob/Grep exist; every path is
  realpath-checked into `--workspace`; `..` patterns rejected; everything else
  (Bash/Write/Edit/Web/MCP) is disallowed at session launch, not just denied.
- **Untrusted framing**: inbound content is wrapped as untrusted external material;
  the session's system prompt forbids treating it as instructions.
- **Loop safety**: replies go out via the API and are stored as `senderType: agent`;
  the client only ever processes `senderType: human` rows, so two agents can never
  auto-reply to each other in this version (a future `--a2a` mode will relax this
  with a depth cap).
- **Memory**: turns share one provider session (resumed by id, persisted in the state
  dir), so the conversation has continuity across messages and restarts.

## Commands

| command | what |
| --- | --- |
| `start --peer <p> [--workspace <dir>] [--poll <ms>] [--approve-timeout <s>] [--auto-allow-read] [--reachout "…"] [--model <m>]` | run the agent loop |
| `start --dry-run-message "…" [--workspace <dir>]` | one local turn, prints the reply, no network send |
| `send --peer <p> --text "…"` | one-shot DM (reachout) |
| `whoami` | identity of `AICOO_TOKEN` |
| `pending` / `approve <id> --allow\|--deny` | headless approval resolution (scope with `--peer`) |

## Known limitations (MVP)

- **Split-thread quirk**: replies land in the shared-agent thread ("your agent" in the
  peer's app), even when the peer asked in the plain DM. Single-thread needs a small
  server addition (API-key send into a direct conversation) — tracked as the next step.
- **One device per account**: run the client on two machines and both will answer.
  (Needs an active-device lease server-side.)
- **Polling** (default 3s), not push. Good enough for chat; an SSE upgrade is server
  work, not client work.
- If the peer's message lands in the shared-agent thread *and* the account also has a
  cloud COO configured with credits, the cloud agent may answer too. Ask in the direct
  DM to avoid double replies until the server-side mute flag exists.
