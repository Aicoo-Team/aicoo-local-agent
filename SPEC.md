# Aicoo Local Agent — Protocol Specification

This document specifies the agent-to-agent messaging protocol implemented in this repository.
It is derived from `src/shared/contracts.ts`, the `MessageTransport` interface
(`src/shared/transport.ts`), and the reference control-plane routes and state machine
(`src/control-plane/`).

The protocol lets one authenticated principal's agent send a message to a **live local coding
agent** owned by another principal, through a control plane that mediates authorization, routing,
and delivery, and delivers it via a local bridge into a real runtime session.

---

## 1. Entities

| Entity | Description |
| --- | --- |
| **Principal** | An authenticated identity (a person). The unit of authorization. |
| **Endpoint** | A registered local bridge instance for a principal + device, running a runtime (`claude-code` \| `codex`). Carries presence (`online` \| `draining` \| `offline`). |
| **Runtime session** | A managed session on an endpoint, addressable by `sessionHandle`, with a `state` (`idle` \| `busy` \| `closed`) and declared `capabilities` (`liveInject`, `midTurnSteer`, `replyEvents`). |
| **Target offer** | A revocable, TTL-bounded capability a principal publishes so a named audience can reach a specific endpoint+session. |
| **Communication session** | A request-then-grant relationship authorizing a requester to message a recipient. Bears `capabilities: ["message:send", "message:reply"]`. |
| **Message** | A single envelope delivered within an active communication session (or to a `human_inbox`). |
| **Delivery** | The tracked lifecycle of one message through the state machine below. |

### Target kinds

- `human_inbox` — cloud inbox only; **never** delivered to any local runtime.
- `person_default_runtime` — the recipient's current default route (endpoint + session).
- `runtime_session` — a specific session, resolved through a `target_offer`.

---

## 2. MessageTransport surface

`MessageTransport` (`src/shared/transport.ts`) is the seam every control-plane binding implements.
`HttpMessageTransport` (`src/shared/http-client.ts`) is the reference HTTP/SSE implementation; its
constructor takes `{ baseUrl, token, timeoutMs?, minReconnectMs?, maxReconnectMs?, fetchImpl? }`.

| Method | Reference route | Purpose |
| --- | --- | --- |
| `registerEndpoint(input)` | `POST /api/v1/endpoints` | Register/refresh a bridge endpoint; returns `Endpoint`. |
| `heartbeatEndpoint(id)` | `POST /api/v1/endpoints/:id/heartbeat` | Liveness; drives presence and auto default-route. |
| `registerRuntimeSession(id, input)` | `POST /api/v1/endpoints/:id/sessions` | Bind a managed session. |
| `updateRuntimeSession(id, handle, patch)` | `PATCH …/sessions/:handle` | Update `state` / `allowInbound` / `allowMidTurnSteer`. |
| `listReachableTargets(personId)` | `GET /api/v1/targets` | Discover targets the caller may reach. |
| `requestCommunicationSession(input)` | `POST /api/v1/comm-sessions` | Request a grant (freezes the requester reply route). |
| `acceptCommunicationSession(id)` | `POST /api/v1/comm-sessions/:id/accept` | Recipient accepts; freezes recipient route, returns a `CommunicationGrant`. |
| `declineCommunicationSession(id)` | `POST …/decline` | Recipient declines. |
| `revokeCommunicationSession(id)` | `POST …/revoke` | Either party revokes an active/pending grant. |
| `sendMessage(input)` | `POST /api/v1/messages` | Send within a grant, or to a `human_inbox`. Returns a `MessageReceipt` (with `duplicate` for idempotency). |
| `subscribeEvents(cursor?, signal?)` | `GET /api/v1/events` (SSE) | Cursor-based event stream to the bridge. |
| `fetchInbox(afterCursor?)` | `GET /api/v1/events/poll` | Polling fallback for the same events. |
| `validateInjection(input)` | `POST /api/v1/injections/validate` | Re-authorize a message at delivery time (see §4). |
| `acknowledgeDelivery(input)` | `POST /api/v1/messages/:id/ack` | Report a delivery phase transition. |
| `getMessageStatus(id)` | `GET /api/v1/messages/:id/status` | Read the full `MessageDelivery`. |

Auxiliary reference routes used by the CLI: `whoami`, default-route `GET/PUT/DELETE
/api/v1/default-route`, `target-offers` create/revoke, `inbox`, and `audit`.

All requests authenticate with `Authorization: Bearer <token>`. Errors return
`{ error: { code } }` and surface as `ApiError { status, code, body }`.

### Message envelope

`sendMessage` accepts either a **grant-scoped** input (`{ communicationSessionId, clientMessageId,
kind, payload, replyTo?, correlationId? }`) or a **human-inbox** input (`{ target: { kind:
"human_inbox", principalId }, … }`). `kind` is one of `text | task_invite | resource_request`
(grant-scoped excludes `control`). `clientMessageId` is the idempotency key. The control plane
expands this into a `MessageEnvelope` with a server `id`, monotonic `sequence`, `createdAt`, and
`expiresAt`.

---

## 3. Delivery state machine

`DeliveryStatus` (`contracts.ts`) tracks a message from acceptance to a terminal state. The happy
path advances through:

```
queued ──▶ dispatched ──▶ device_acked ──▶ runtime_pending ──▶ runtime_acked
```

- **queued** — accepted and persisted by the control plane.
- **dispatched** — emitted to the target endpoint over the event stream.
- **device_acked** — the bridge durably spooled the message and acked receipt (phase `device_ack`).
- **runtime_pending** — accepted by the bridge but the session was busy (phase `runtime_pending`,
  retryable); re-attempted after re-validation.
- **runtime_acked** — injected into the live runtime session as a turn (phase `runtime_ack`).

Terminal (non-retryable) states: **failed**, **expired**, **revoked**, **rejected**. Additional
states model the human-inbox and reply paths: **inbox_persisted**, **handled**, **replied**.

Each transition is recorded as a `DeliveryAttempt { attemptId, phase, resultCode?, retryable,
runtimeAckId?, createdAt }` where `phase ∈ { device_ack, runtime_pending, runtime_ack,
runtime_failed }`. The bridge reports transitions with `acknowledgeDelivery`; `getMessageStatus`
returns the full `MessageDelivery` including the attempt history.

**Fault isolation (bridge, `src/bridge/injector.ts`).** Device-ack and injection run off the SSE
consumer with a durable spool and retry, so a slow or failing control plane can never wedge the
stream, stall the cursor, duplicate a runtime side effect, or replay an already-accepted turn. A
locally-recorded `runtime_ack` is retained even if reporting it fails, and is never recreated by
reinjection.

---

## 4. Grant and route-freeze model

A message may only flow inside an **active communication session** (grant). The lifecycle:

1. **Request** (`requestCommunicationSession`). The requester names a recipient target
   (`person_default_runtime` or `runtime_session` via an offer) and supplies its own
   `replyEndpointId` + `replySessionHandle`. These reply-route coordinates are **frozen** onto the
   session at request time. Status: `pending`, with a `requestExpiresAt`.
2. **Accept** (`acceptCommunicationSession`). The recipient's route is resolved — from its
   **default route** (for `person_default_runtime`) or from the **target offer** (for
   `runtime_session`) — and **frozen** as `frozen_endpoint_id` + `frozen_session_handle`. Status
   becomes `active`, with `activatedAt` and a `grantExpiresAt` (capped, e.g. ≤ 30 minutes). Returns
   a `CommunicationGrant`.
3. **Send / receive.** While `active`, the requester may `sendMessage`; delivery targets the frozen
   recipient route only.
4. **Terminate.** `decline`, `revoke`, or expiry moves the session to `declined` / `revoked` /
   `expired`. `CommunicationStatus ∈ { pending, active, declined, revoked, expired }`.

**Route freeze** means both the reply route (at request) and the delivery route (at accept) are
pinned to the session. Messages cannot be redirected to a different endpoint or session after the
grant is formed, even if the recipient's default route later changes.

**Delivery-time re-validation** (`validateInjection`, enforced by the bridge before every
injection). A message is only injected if **all** hold:

- the message belongs to the named communication session (`wrong_target` otherwise),
- the target endpoint is owned by the acking device (`endpoint_not_owned`),
- the communication session is still `active` (`requireActive`),
- the delivery is not already terminal (`delivery_terminal`),
- the message has not expired (`message_expired`),
- the session handle matches the frozen target (`wrong_target`).

Because this runs at delivery time, a **revoked or expired grant halts delivery of already-queued
messages** — authorization is checked continuously, not just at send.

---

## 5. Safety and permission model

The protocol treats an inbound message as **intent and context, never authority**. The receiver
(`src/adapters/claude-code/claude-code-adapter.ts`) enforces this in layers:

- **Untrusted-content framing.** Messages are delivered to the runtime tagged
  `trust: "untrusted_external_content"`. The receiver's system prompt states the sender is not the
  owner and holds no authority, and refuses attempts to override the rules, reveal/override the
  prompt, impersonate the owner, request credentials, or expand permissions.
- **Default receiver isolation.** Absent an explicit opt-in, the session runs **tools-disabled and
  text-only**: `tools`, `allowedTools` empty, everything disallowed, `permissionMode: "dontAsk"`.
  It can read the message and reply in plain text; it cannot run commands, touch files, browse, or
  exfiltrate.
- **Permissioned mode (per-tool owner approval).** The explicit full-agent surface is constructed
  only after the runtime safety and rebuild-health gates pass. Supported tool calls are routed
  through the owner's approval gateway and fail closed on missing, rejected, or timed-out
  decisions. Codex uses its interruptible app-server approval path; Claude Code uses `canUseTool`.
- **Relationship policy.** The reference bridge can load an explicit allowlist keyed by the
  authenticated sender's principal and device IDs. Tools must be listed, and structured file-tool
  paths must remain inside listed folders after canonicalization. Missing identity or policy denies
  access. A policy can grant several folders at once and exact remote HTTP MCP server/tool pairs.
  Policy changes invalidate only sessions for the affected verified peer device; identical replayed
  events are no-ops. Whole Codex plugin bundles remain isolated because their skills, hooks, and
  other components do not fit the MCP-only grant contract.
- **Immutable runtime boundary.** Filesystem roots are fixed when a runtime session starts. An
  approved out-of-boundary request therefore quiesces the original turn, creates a wider
  kernel-scoped session, and resumes the same durable correlation. Approval is an intermediate
  state, never task completion.
- **Egress discipline.** The reply is an outbound channel back to the sender; the receiver is
  instructed to share only what is appropriate within the current grant and never to reveal
  secrets, credentials, out-of-scope file contents, or third parties' data.
- **Auditability.** The control plane records grant lifecycle and delivery actions
  (`GET /api/v1/audit`, scoped by principal and optional communication session).

Injection hooks (`InjectionHooks`: `beforeMessageInject`, `beforeToolUse`, `beforeMessageEgress`
in `src/bridge/injector.ts`) are integration seams for additional policy — **not** substitutes for
the receiver-side controls above.
