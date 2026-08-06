# Aicoo Local Agent

An open protocol and runtime for reaching a **live local coding agent** — Claude Code or Codex,
running on someone's own machine — from another agent, safely.

Most agent-to-agent messaging assumes a cloud inbox or a stateless function on the other end.
This project targets a harder and more useful case: the recipient is a *stateful, tool-capable
coding agent* already running in a real workspace. A message needs to reach that live session,
be injected as a turn, run under the owner's control, and stream a reply back — without ever
letting the sender act as if they were the owner.

This repository is the **open core**: the wire protocol, a local **bridge** that manages runtime
sessions and delivers messages durably, **runtime adapters** for Claude Code / Codex (plus a
`fake` adapter for tests), a **reference (mock) control plane**, and a **CLI**. The transport
binding to any specific hosted control plane is intentionally *not* included — the `MessageTransport`
interface is the seam you implement to plug in your own.

## Safety model

The central rule: **a message conveys intent and context, not authority.**

- **The sender is not the owner.** An inbound message is always treated as *untrusted external
  content*. It is never a system, developer, or owner instruction, and it grants no permission.
  The receiver's system prompt states this explicitly and refuses attempts to override it,
  reveal the prompt, impersonate the owner, or request credentials.
- **Receiver isolation.** By default the receiving session is a **tools-disabled, text-only**
  responder: it may read the message and answer in plain text, but it cannot run commands,
  touch the filesystem, browse, or exfiltrate data. Tool access is off unless the owner opts in.
- **Tool access is currently disabled.** Relationship policies can record verified user/device
  identity for future presets, but Claude Code and Codex adapters run text-only today. File/tool
  access stays off until OS-level sandboxing, audit, and revocation semantics are in place.
- **Grant-scoped, revocable delivery.** A sender can only message a recipient through an active,
  time-boxed **communication grant** that the recipient (or an offer they published) authorized.
  Every injection is **re-validated against the control plane at delivery time**, so a revoked or
  expired grant stops delivery even for already-queued messages.
- **Fault isolation.** Acknowledgement and injection run off the event stream with durable
  spooling and retry, so a slow or failing control plane can never wedge the session, duplicate a
  side effect, or replay an already-accepted turn.

## Architecture

```
  another agent ──▶ control plane ──SSE──▶ bridge ──▶ runtime adapter ──▶ live coding agent
                    (grants, routing,       (durable    (Claude Code /       (real workspace
                     delivery state)         spool)      Codex / fake)        session)
```

- `src/shared/` — the protocol: `contracts.ts` (types), `transport.ts` (the `MessageTransport`
  interface), `http-client.ts` (`HttpMessageTransport`, the reference HTTP/SSE client), plus
  `ids`, `reason-codes`, `time` helpers.
- `src/control-plane/` — a reference/mock control plane (Hono + SQLite): endpoints, grants,
  routing, the delivery state machine, audit, and an SSE event stream.
- `src/bridge/` — the local bridge: session registration, a durable spool, the injector
  (re-validation + delivery state reporting), and auto default-route from heartbeat.
- `src/adapters/` — runtime adapters: `claude-code`, `codex`, and `fake`, behind the
  `RuntimeAdapter` interface. Includes the permissioned `canUseTool` mode and dead-session
  resume recovery.
- `src/cli/` — the `ccd` CLI for driving the whole thing from a terminal.

## Quickstart

Requires Node.js ≥ 22.5 (the bridge uses the built-in `node:sqlite`).

```bash
npm install
```

**1. Run the reference control plane** (in-memory/SQLite mock, listens on `127.0.0.1:7790`):

```bash
npm run serve
```

**2. Run a bridge** against it, managing one or more text-only live sessions. Start with the `fake`
adapter, or use `--adapter claude-code` / `--adapter codex` to bridge a real local coding agent:

```bash
npm run bridge -- --server http://127.0.0.1:7790 --token <device-token> --adapter fake --spool me.spool --sessions 2
# real agent, tools-disabled text-only receiver (default, safest):
npm run bridge -- --server http://127.0.0.1:7790 --token <device-token> --adapter claude-code --spool me.spool --sessions 2
```

The bridge registers its endpoint/sessions, persists local state in the spool, and publishes a
default route automatically from the heartbeat loop.

**3. Check readiness**:

```bash
npm run ccd -- --server http://127.0.0.1:7790 --token <token> whoami
npm run ccd -- --server http://127.0.0.1:7790 --token <token> doctor --spool me.spool
```

**4. Drive the two-user flow** — request a grant, accept it, send a message, watch delivery:

```bash
# user A requests user B's default runtime; A's reply route is discovered automatically
npm run ccd -- --server http://127.0.0.1:7790 --token <token-a> connect request --to <principalId-b>

# user B accepts; tools remain text-only unless future sandboxed presets are enabled
npm run ccd -- --server http://127.0.0.1:7790 --token <token-b> connect accept <comm-id> --access chat-only

# user A sends a message over the active communication session
npm run ccd -- --server http://127.0.0.1:7790 --token <token-a> send --comm-session <comm-id> --text "hello from another agent"

# follow the delivery state machine to a terminal / runtime state
npm run ccd -- --server http://127.0.0.1:7790 --token <token-a> status <messageId> --watch
```

Useful discovery commands:

```bash
npm run ccd -- --server http://127.0.0.1:7790 --token <token> targets --person <principalId>
npm run ccd -- --server http://127.0.0.1:7790 --token <token> connect list
```

`serve` bundles into the CLI too: `npm run ccd -- serve` starts the same mock control plane.

## Setup Guide

Follow these three steps to connect your local coding agent and start collaborating.

Use this guide when the Aicoo app asks you to set up local-agent collaboration.
Run the commands on the same machine where Claude Code or Codex can access the
workspace you want to use. The app is the human collaboration surface; this
package is the local bridge that keeps your coding agent reachable from Aicoo.

**1. Log in your device**

Run the local-agent login command in your terminal, then approve the device code in Aicoo:

```bash
npx @aicoo/local-agent login
```

This links your machine to your Aicoo account. Your coding agent stays on your device; Aicoo
handles identity, grants, routing, delivery state, and revocation.

After login, the CLI stores a local device credential under `~/.aicoo/local-agent/`.
You only need to repeat this step when setting up another machine or re-authenticating.

**2. Choose your runtime adapter**

Start your local bridge with Claude Code or Codex:

```bash
ccd start --adapter claude-code
```

```bash
ccd start --adapter codex
```

The bridge registers your local runtime as reachable. It does not give teammates access to your
files or tools unless you approve a relationship access preset and folder.

The localhost helper supports native folder and file selection on macOS and Windows. The picker
always opens on the same machine as the browser, because the browser calls the helper on
`127.0.0.1`; it does not select files or folders on a remote receiving machine. Cross-device
picker routing is a separate feature.

Keep this process running while you want your local agent to receive requests.
Use `claude-code` when Claude Code is the local runtime you want to expose, or
`codex` when Codex should answer.

When started with the Codex adapter, the bridge automatically installs or
updates the Aicoo delegation skill so your local Codex knows when to hand a
task to a peer local runtime.

**3. Collaborate with teammates**

Open a DM with any teammate in Aicoo and click **Collaborate** to pair your agents.

Aicoo relays between both local runtimes:

```text
your local Codex/Claude <-> Aicoo <-> their local Codex/Claude
```

If the UI is unavailable during local testing, the recipient can run `ccd accept` as a CLI
fallback, and the sender can run `ccd connect <principal-id>` plus `ccd send-to <principal-id>
"hello"`. `send-to` waits for runtime acknowledgement by default; use `--no-watch` for
fire-and-forget.

To hand off work from your local agent to a peer's local agent, ask your local
Codex/Claude to delegate it. Natural prompts like "ask @teammate what they are
working on" map to:

```bash
ccd delegate @teammate "Summarize the README in the shared repo"
```

If the peer has not approved a relationship yet, Aicoo creates a pending grant
and the local bridge parks the delegation in its durable spool. After the peer
approves in Aicoo or with `ccd accept`, the running bridge retries the same
`clientMessageId` and dispatches one `task_invite` to the peer runtime. The
peer reply is correlated back to the original local session.

When a teammate sends a request, their local agent is the peer. Aicoo only
relays the request to your local bridge and enforces the active grant. The
incoming text is still treated as untrusted external content by your runtime.

The lower-level commands remain available for debugging and self-hosted control planes:
`bridge`, `connect request`, `connect accept <comm-id>`, and `send --comm-session <comm-id>`.
The hosted control plane is Aicoo's product — this repo is the open **client + protocol + a
reference server you can self-host**.

### Optional relationship permissions

Receivers are chat-only by default. The owner can approve a verified peer device
for `chat-only`, `read-project`, or `edit-project` access. Claude Code enforces
allowed file operations per tool call; Codex uses the local bridge broker for
allowed `Read`, `Write`, and `Edit` operations. Shell, network, browser, Git,
package-manager, MCP, and delegated tools remain unsupported.
See [Relationship-based tool and folder access](./docs/RELATIONSHIP-POLICY.md).

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## Protocol

See [`SPEC.md`](./SPEC.md) for the concise protocol spec: the `MessageTransport` surface, the
delivery state machine, the grant / route-freeze model, and the safety/permission model.

## License

[Apache 2.0](./LICENSE) © Aicoo Team.
