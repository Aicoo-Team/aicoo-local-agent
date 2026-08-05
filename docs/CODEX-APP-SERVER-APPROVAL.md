# Codex app-server: can it carry just-in-time approval?

**Yes. Verified live against `codex-cli 0.146.0` on macOS, not read off the schema.**

Claude Code got just-in-time owner approval because `canUseTool` is an async callback: the turn
pauses on a network round trip to the owner and resumes with their answer. The question for Codex
was whether its `app-server` protocol can do the same thing, or whether we would keep pretending a
broker that only writes plans is a substitute for the peer's actual agent.

Reproduce with `spikes/codex-app-server-approval.mjs` (`node … accept` / `node … decline`,
`SPIKE_HOLD_MS` controls how long the decision is held).

## What was proven

| Property | Result |
|---|---|
| Server asks us before running an unsandboxed command | `item/commandExecution/requestApproval` |
| Payload names the actual command | `/bin/zsh -lc 'echo AICOO_SPIKE_WROTE > spike-out.txt'` |
| Turn survives an async hold | held **310 004 ms**, then honored — command ran 118 ms later |
| `accept` runs it | file present on disk |
| `decline` stops it | **nothing written**, turn still completed cleanly |

310 s was chosen deliberately: the owner-approval budget is 5 minutes on both the bridge and the
control plane, so anything shorter would not have answered the question. There is no short internal
approval timeout to design around.

## The protocol

Server-to-client **requests** (each expects a JSON-RPC response):

- `item/commandExecution/requestApproval` → `{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }`
- `item/fileChange/requestApproval` → same decision shape
- `item/permissions/requestApproval` → `{ permissions, scope: "turn" | … }`

Client side: `initialize` → `initialized` → `thread/start` (`cwd`, `approvalPolicy`,
`sandboxPolicy`) → `turn/start` (`threadId`, `input`).

**`acceptForSession` is native.** Codex already models exactly the session-scoped answer we built
into the control plane, so the owner's "apply to every Bash in this collaboration" maps onto the
protocol rather than being emulated on top of it.

## Four things that will bite the driver

**`turn/start` only acknowledges.** It resolves in ~3 ms, long before any work happens. Everything
real arrives as notifications, terminating in `turn/completed` or `turn/failed`. The first version
of this spike waited on the `turn/start` promise and concluded "no approval was ever requested" —
which was false, and would have killed phase 3 on a bug in the test harness.

**`item/completed` for a `commandExecution` fires even when it was declined.** Execution cannot be
inferred from it; the decline run emitted the same event and wrote nothing. Check the outcome, not
the event.

**Approval only fires for what the sandbox cannot satisfy.** A read inside `cwd` under a `readOnly`
policy ran with no approval at all. So kernel scoping (PR #12) and JIT approval are complementary,
not redundant: the sandbox decides what is even worth asking about, and everything it can already
serve stays silent and fast. Widening the sandbox to reduce friction directly reduces what the owner
is ever asked.

**Answering every approval blindly is not a stub — it is a hole.** The first run of this spike
accepted everything, and Codex's own memory plugin used that to write a file into
`~/Desktop/codex memory/…`, outside the workspace entirely. That artifact was removed. The driver
must route each approval by kind and treat "I don't recognize this" as a deny, which is the same
fail-closed rule the Claude Code path already follows.

## What this does not settle

The round trip works. Not yet built: mapping `RequestPermissionProfile` onto our relationship
policy, deciding whether the bridge answers `acceptForSession` locally or defers to the control
plane's session scope (probably the latter, so one revoke kills both), and what a decline should
report back to the requesting peer.
