# Beyond read-only: what to build, in what order

Today a peer can `Read` / `Glob` / `Grep` inside one folder, and the owner approves every
call. The valuable things we cannot do yet — run your tests, use your GPU, touch your
Docker, edit a file — all need more than that.

## The rule that decides the order

**Every new capability multiplies the gaps that already exist.**

Read-only is forgiving: the worst case is that a peer learns something. Write and exec are
not. So the work splits into two kinds, and the second kind must not start before the first
finishes:

- **Capability-independent gaps** — wrong today, catastrophic later
- **Capabilities** — worthless until those gaps are closed

Shipping a capability first is the tempting order and the wrong one: it makes the demo
better and the product unshippable.

---

## Phase 0 — the three gaps (before any new permission)

### 0.1 Outbound sanitising · **blocks everything else**

The reply is an exfiltration channel. Right now "it never emits a secret value" is enforced
by a sentence in the system prompt — the model complies, including under a message claiming
the owner authorised it, but that is compliance, not a mechanism.

Every capability makes this worse: with `Write` a peer can plant a file and ask about it;
with `Bash` they can compute an encoding of a secret and have the agent report "the result".

Build: a filter on the egress path (`cli.js`, where `reply` is sent) that scans for
high-entropy strings, known credential shapes, and — most usefully — **any value that
appeared in a file the agent read this turn**. That last one is the strong version: it does
not need to recognise a secret, only that a substring came from the workspace and was not in
the question.

Redact and mark it, do not silently drop it: `[redacted: value from .env]` tells the owner
the system worked.

*Effort: 1–2 days including tests. Nothing else should ship before it.*

### 0.2 An OS sandbox for dm-agent · **it has none**

c2c's adapter passes a `sandbox` block (`allowWrite`, `denyRead`, `denyWrite`,
`allowUnsandboxedCommands: false`). **dm-agent passes none** — containment is the tool
allowlist plus `insideWorkspace()`, one function of mine, with 11 tests behind it.

For read-only that is defensible. For write or exec it is one bug away from the whole
machine, and it means a prompt-injection that reaches a tool call has no second line of
defence.

Build: adopt the same sandbox block in `agent.js#options`, with the workspace as the only
writable root and the usual sensitive paths on `denyRead`. Free — the config already exists
next door and is proven.

*Effort: half a day. Do it whether or not exec ever ships.*

### 0.3 Standing grants, with TTL and revoke

Per-call approval is the feature for a stranger asking about `.env`. It is friction for a
teammate asking five questions a day — and friction produces the worst outcome available:
the owner starts pressing `y` without reading, which is worse than no prompt at all because
it looks like consent.

Build: a per-peer policy file (c2c's `relationship-policy.ts` is the model — presets,
folders, TTL) that pre-approves a scope, so the prompt fires only for what falls outside it.
Two modes, both legible in the product:

- **stranger / sensitive / one-off** → ask every time
- **teammate / scoped / recurring** → grant once, expires, revocable

*Effort: 2–3 days. Also the thing that makes the PM use case usable at all.*

### 0.4 Audit

Ninety seconds of work per event, and the only way anyone answers "what has this person's
agent read from my machine this month?" Append-only JSONL: who, what tool, what path,
allowed or denied, and by which rule.

Not optional once standing grants exist — the moment approval stops being per-call, the log
becomes the only record.

*Effort: half a day.*

---

## Phase 1 — cheap capability, low risk

### 1.1 Multiple scopes

One `--workspace` forces everything into one folder. Real use wants "these three folders,
this one read-only, that one also writable."

Comes almost free once 0.3 exists, since the policy file already has to express folders.

### 1.2 Read beyond text

PDFs, spreadsheets, images — the contract on someone's desktop, the deck, the screenshot.
`Read` already handles several of these; the wall and gate need no change.

This is the cheapest way to leave the developer niche, and it needs **no new permission
class at all** — same tools, same gate, different files.

---

## Phase 2 — write

`Write` / `Edit`, workspace-only, and **the approval must show a diff**. "Allow Edit on
config.ts?" is not a decision anyone can make; a five-line diff is.

Two conditions before this ships:

- 0.2 sandbox in place, so the workspace boundary has an OS-level backstop
- A journal of what changed, so a bad edit is one command to undo

*Note: `edit-project` on a folder is already code execution in disguise — `.git/hooks`,
`package.json` scripts, `Makefile`. Either exclude those paths or accept that write ≈ exec
and gate it as exec.*

---

## Phase 3 — exec, the one that matters

This is the axis nothing else can substitute: a GPU, a Docker daemon, a licensed tool, a
service reachable only from inside that network. It is also the one where a careless design
hands a remote message a shell.

**Do not ship raw `Bash` behind a y/N prompt.** The approval line would be an arbitrary
command string, and humans approve those badly — `allow? bash -c 'curl … | sh'` gets a `y`
often enough to make the gate decorative.

Ship **declared commands** instead. The owner writes, in their policy:

```json
{ "run-tests": "npm test", "docker-ps": "docker ps --format '{{.Names}}'" }
```

The peer's agent can invoke `run-tests`, nothing else. The approval reads *"@alice's agent
wants to run **run-tests**"* — a decision a human can actually make. Arguments, if allowed,
are typed and validated, never interpolated into a shell string.

That turns "arbitrary code execution" into "a menu the owner wrote", which is the only
version of this that survives a security review.

Raw Bash, if ever, comes later: sandboxed, network disabled, and off by default.

*Effort: 3–5 days for declared commands, most of it in the policy format and the approval
UX. The runtime piece is small.*

---

## Phase 4 — beyond the filesystem

MCP servers, browser automation, connected integrations. Each is "a tool the owner has and
the asker does not", which is the whole thesis — but each also arrives with its own
authorisation model, and they compose badly. Do not start until Phase 3's declared-capability
pattern has survived contact with real use; then every MCP tool is just another declared
capability.

---

## Recommended sequence

| # | Item | Effort | Why here |
| --- | --- | --- | --- |
| 1 | Outbound sanitising | 1–2d | Blocks everything; already the weakest claim we make |
| 2 | OS sandbox | 0.5d | dm-agent has none; free, proven next door |
| 3 | Audit log | 0.5d | Cheap, and required before grants stop being per-call |
| 4 | Standing grants + TTL + revoke | 2–3d | Makes the recurring use case possible at all |
| 5 | Multiple scopes | 1d | Falls out of 4 |
| 6 | Non-text reads | 1d | Biggest reach for the least risk |
| 7 | Write with diff approval | 2–3d | Needs 2 and an undo journal |
| 8 | Declared commands (exec) | 3–5d | The differentiated one; needs everything above |

**Roughly two weeks to the first genuinely local-exclusive capability** — and the demo gets
materially better at step 6, well before exec lands.

## The one thing not to do

Do not add `Bash` to `READ_TOOLS` and rely on the approval prompt. It is a two-line change,
it would demo beautifully, and it would be the single most dangerous thing in the product:
remote-triggered shell on a colleague's laptop, gated by a dialog people learn to dismiss.
