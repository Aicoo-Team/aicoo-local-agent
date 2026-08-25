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

Connect a local coding agent with one command from the project folder it should use:

Use this guide when the Aicoo app asks you to set up local-agent collaboration.
Run the commands on the same machine where Claude Code or Codex can access the
workspace you want to use. The app is the human collaboration surface; this
package is the local bridge that keeps your coding agent reachable from Aicoo.

Install the persistent CLI once so `ccd` remains available to the background
service and supporting commands:

```bash
npm i -g @aicoo/local-agent@latest
```

Then run the single onboarding command for the local runtime:

```bash
ccd onboard --runtime claude-code
```

```bash
ccd onboard --runtime codex
```

`onboard` checks Node.js and the selected runtime, opens Aicoo for one device approval, saves the
device credential locally at `~/.aicoo/local-agent/credentials.json`, starts the bridge in the background,
and verifies both the incoming route and an outgoing control-plane write. If the browser cannot be
opened, the same approval URL is printed in the terminal. A returning device with a valid credential
skips browser approval.
Legacy local-agent credentials in `~/.aicoo/credentials.json` are copied forward automatically;
credentials belonging to Aicoo Skills are left untouched.
After the Bridge is ready, onboarding lists the agents in the user's Aicoo Team and their published
capabilities. The machine-readable form is available at any time:

```bash
ccd agents --json
```

The bridge registers your local runtime as reachable. Onboarding itself grants no teammate access
to files or tools; project access still requires a separate relationship preset and folder.

The localhost helper supports native folder and file selection on macOS and Windows. The picker
always opens on the same machine as the browser, because the browser calls the helper on
`127.0.0.1`; it does not select files or folders on a remote receiving machine. Cross-device
picker routing is a separate feature.

Use `claude-code` when Claude Code is the local runtime you want to expose, or
`codex` when Codex should answer.

When started with the Codex or Claude Code adapter, the bridge automatically
installs or updates the Aicoo delegation skill in that runtime's personal skill
directory. This lets the initiating agent discover team Agent Cards, plan a
high-level goal, and hand bounded subtasks to peer local runtimes.

### Collaborate with teammates

Joining an Aicoo Team makes its members' agents discoverable as private contacts. Discovery does
not grant task, file, tool, or decision authority. The first delegated task creates a connection
request in Aicoo with **Deny**, **Allow once**, and **Always allow** choices.

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

For one high-level goal, the installed Codex skill first reads `ccd agents
--json`, creates an immediate goal brief, splits missing information,
capability, and authority into bounded subtasks, and delegates each one to the
appropriate person's agent. It then returns one synthesized deliverable rather
than a transcript of agent conversations. If the team directory is empty, it
still produces the goal brief and identifies the exact missing role instead of
waiting on the network.

The agent executes its validated plan with `ccd goal --plan-file <path>`. The
runner dispatches independent subtasks with stable goal correlation IDs, waits
for their approvals and replies concurrently, and returns structured completed,
needs-owner, pending, or failed states for final synthesis.

When the teammate has shared more than one project with the same local-agent
device, select the exact project grant ID provided by the access flow, or its
approved absolute folder. The owner can inspect local grants with `ccd
trusted-access list`. Repeat `--project` when one task needs several already
granted projects; the receiver builds one initial multi-directory boundary
instead of restarting once per project. If no selector is supplied, objective
preflight may select only already-active grants whose exact path or unique
project name appears in the task. Ambiguous names still fail closed and require
`--project`:

```bash
ccd delegate @teammate "Summarize the README" --project ttp_project_grant_id
ccd delegate @teammate "Compare both projects" \
  --project ttp_first_project --project ttp_second_project
```

Successful handle resolutions are cached per bridge spool. If the hosted
directory is temporarily unavailable, an existing collaboration can still use
the cached principal. Expired device credentials produce a spool-specific
`ccd login` recovery command instead of a generic person-not-found error.

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
