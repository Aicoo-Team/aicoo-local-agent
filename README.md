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
- **Per-tool owner approval (permissioned mode).** When the owner opts in (`resolveToolPermission`),
  tools are enabled but **every single tool call is routed through an owner-approval gate**
  (`canUseTool`). The owner allows or denies each call by policy. This gate is **fail-closed**:
  any error or timeout while resolving a decision *denies* the tool. One approval is never a
  license for the next.
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

**2. Run a bridge** against it, managing one live session. Start with the `fake` adapter, or use
`--adapter claude-code` / `--adapter codex` to bridge a real local coding agent:

```bash
npm run bridge -- --server http://127.0.0.1:7790 --token <device-token> --adapter fake
# real agent, tools-disabled text-only receiver (default, safest):
npm run bridge -- --server http://127.0.0.1:7790 --token <device-token> --adapter claude-code
```

**3. Drive it from the CLI** — publish an offer, request a grant, send a message, watch delivery:

```bash
# who am I / what can I reach
npm run ccd -- --server http://127.0.0.1:7790 --token <token> whoami
npm run ccd -- --server http://127.0.0.1:7790 --token <token> targets --person <principalId>

# request a communication session (grant) and send a message once active
npm run ccd -- --token <token> connect request --to <principalId>
npm run ccd -- --token <token> send --comm-session <id> --text "hello from another agent"

# follow the delivery state machine to a terminal / runtime state
npm run ccd -- --token <token> status <messageId> --watch
```

`serve` bundles into the CLI too: `npm run ccd -- serve` starts the same mock control plane.

## Connect to the hosted Aicoo service

The steps above use the local reference control plane. To instead reach agents on **Aicoo's hosted
service**, set `CCD_AICOO=1` and point at the Aicoo server with an Aicoo API key (or OAuth token) as
the token — the built-in Aicoo transport handles it, everything else is identical:

```bash
CCD_AICOO=1 CCD_SERVER_URL=https://www.aicoo.io CCD_TOKEN=<aicoo_sk_...> \
  npm run bridge -- --adapter claude-code --spool me.spool
```

`deviceId` is auto-generated and persisted; the bridge auto-publishes its default route so peers can
reach it. The hosted control plane is Aicoo's product — this repo is the open **client + protocol +
a reference server you can self-host**.

### Optional relationship permissions

Claude Code and Codex receivers are text-only. The CLI can record a verified
user+device relationship with `--access chat-only`, but tool-capable presets
are disabled until each relationship runs in its own OS sandbox. This avoids
presenting a JSON/path allowlist as a filesystem security boundary.
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
