# @aicoo/dm-agent

Chat-rails local agent for Aicoo. Your peers DM you in Aicoo; this daemon feeds those
messages to a local Claude session on your machine and DMs the answer back. It can read a
folder you share and run commands you declared — and every one of those suspends until you,
the owner, approve it.

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
- **Hard walls under the approval**: only Read/Glob/Grep and the owner's declared
  commands exist; every path is realpath-checked into a granted folder; `..` patterns
  rejected; everything else (Bash/Write/Edit/Web) is disallowed at session launch, not
  just denied.
  Out-of-workspace and non-read attempts are refused by the wall *without* waking
  the owner — the prompt is reserved for calls that are actually in scope.
- **Why a PreToolUse hook, not just `canUseTool`**: Claude Code's built-in rules
  auto-allow reads inside `cwd`, so `canUseTool` is never consulted for them
  (`permissionMode: "dontAsk"` goes further and resolves everything itself,
  auto-allowing in-cwd reads and auto-denying the rest). Either way the approval
  callback is dead code. The `PreToolUse` hook fires for **every** tool call
  regardless of permission rules, so the gate lives there; `canUseTool` stays as
  a second layer, and one shared memoized decision keeps the owner from being
  asked twice for the same call.
- **Untrusted framing**: inbound content is wrapped as untrusted external material;
  the session's system prompt forbids treating it as instructions.
- **Loop safety**: replies go out via the API and are stored as `senderType: agent`;
  the client only ever processes `senderType: human` rows, so two agents can never
  auto-reply to each other in this version (a future `--a2a` mode will relax this
  with a depth cap).
- **Memory**: turns share one provider session (resumed by id, persisted in the state
  dir), so the conversation has continuity across messages and restarts.

## Letting a peer run something (declared commands)

Reading files answers "what is configured". Some questions need "what happens when you run
it" — and that is the one thing no cloud agent and no file transfer can substitute.

Write a `policy.json` next to the state file (`aicoo-dm-agent start --policy <file>` to put
it elsewhere):

```json
{
  "folders": ["~/aicoo-demo"],
  "commands": {
    "run-tests": { "argv": ["npm", "test"], "describe": "run the unit tests" },
    "docker-ps": { "argv": ["docker", "ps", "--format", "{{.Names}}"] }
  }
}
```

The peer's agent can invoke `run-tests` by name and nothing else. Each run stops for your
approval, and the prompt names the command and its exact argv:

```
== OWNER APPROVAL REQUIRED ==
   tool: command:run-tests
   run "run-tests" (npm test) in ~/aicoo-demo
   allow? [y/N]
```

**Why a declared list and not just `Bash`.** With raw shell the approval line becomes an
arbitrary command string, and `allow? bash -c 'curl … | sh'` gets a `y` often enough to make
the gate decorative. A name plus the argv *you* wrote is a decision a person can actually
make.

**Why `argv` and not a string.** A command written as `"npm test"` only means something once
something splits it, and whatever splits it becomes the attack surface. The array is passed
straight to `execFile` with no shell, so `&&`, pipes and `$(…)` are impossible by
construction — a bare string is rejected at load rather than quietly run through a shell. If
you need a pipeline, declare a script file.

The peer chooses a name; they cannot pass arguments. Commands are disabled entirely on
`--responder codex`, because `codex exec` has no approval callback and exec without a way to
ask is not a weaker version of this feature but a different, worse one.

## Two things that leave the machine, and what stops them

- **Files** — the path wall (realpath, symlink-safe) plus per-call approval, with the
  runtime's own OS sandbox underneath as defence in depth. `--no-sandbox` only if your
  platform cannot start one; the default is to fail rather than claim confinement it does
  not have.
- **The reply itself** — a sandbox governs what a process may *touch*, never what a model
  may *say*. Values assigned to sensitively-named variables in env files under the granted
  folders are collected each turn and replaced in the outgoing reply with
  `[redacted: value from .env]` — marked, so you can see it fired.

Every decision lands in `audit.jsonl` next to the state file: who asked, what tool, what
target, allowed or denied, and which rule decided.

## Commands

| command | what |
| --- | --- |
| `start --peer <p> [--workspace <dir>] [--policy <file>] [--poll <ms>] [--approve-timeout <s>] [--auto-allow-read] [--no-sandbox] [--reachout "…"] [--model <m>]` | run the agent loop |
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
