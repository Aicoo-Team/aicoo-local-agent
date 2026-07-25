# Handover — testing, fixing, and shipping the local-agent loop

This is a task-oriented handover for whoever picks up **testing, fixing, and shipping** the
agent-to-agent (a2a) local-agent loop. It assumes you've skimmed the [README](../README.md) and
[SPEC](../SPEC.md). Read this to know **what already works, what's left, exactly how to run the
two-machine test, and the gotchas that already bit us.**

> **Status in one line:** the two-machine loop **already ran end-to-end** against a hosted
> deployment — `request → accept → send → dispatched → device_acked → runtime_acked → reply routed
> back to the asker`. The transport pipeline is proven. What remains is broader environment
> validation, a known server-side performance fix, and the owner-approved tools milestone.

---

## Quick start — get your agent reachable (copy-paste)

Run this on the machine whose Claude Code should be reachable. It keeps a bridge running against
**production** (`https://www.aicoo.io`). Re-run step 4 after any reboot. **Never delete `me.spool`
or any bridge file** — it holds your session identity and delivery cursor; deleting it invalidates
every grant others gave you and replays stale messages.

1. **Get the code**
   ```bash
   git clone https://github.com/Aicoo-Team/aicoo-local-agent.git 2>/dev/null; cd aicoo-local-agent && git pull
   ```
2. **Install** — only `npm ci`, never `npm install`
   ```bash
   npm ci
   ```
3. **Claude Code ≥ 2.1.211 and logged in** — otherwise incoming messages only get "Not logged in" back
   ```bash
   claude --version          # too old? npm i -g @anthropic-ai/claude-code
   # log in: run `claude`, then `/login`   (or export ANTHROPIC_API_KEY)
   ```
4. **Start the bridge in the background** (safe to re-run — it kills a previous one first)
   ```bash
   pkill -9 -f bridge/main.ts 2>/dev/null
   CCD_AICOO=1 CCD_SERVER_URL=https://www.aicoo.io CCD_TOKEN=<your_aicoo_sk_key> \
     nohup npm run bridge -- --adapter claude-code --spool me.spool > bridge.log 2>&1 &
   ```
   `CCD_SERVER_URL` **must** include `www` (the apex strips the `Authorization` header → silent 401).
5. **Confirm healthy**
   ```bash
   cat bridge.log
   ```
   Expect a JSON blob with `endpointId` (`ep_…`) and `sessions`; within ~20–60s a
   `[bridge] default route -> rs_…` line; no crash; then a silent 20s heartbeat (a quiet log =
   healthy). Note the `endpointId`.

Keep it running. For the two-machine test (§5), each machine runs this with its own key.

---

## 0. What this is

**The problem:** you're blocked on something only a teammate — or their codebase — can answer
("what did you change in the auth flow?", "is this safe to deploy?"). Normally you ping them and
wait for them to drop what they're doing.

**What c2c does:** your agent asks *their* agent directly. The question lands in the **live Claude
Code (or Codex) already running on their machine** — their real repo and context open — it answers,
and the reply comes straight back to your agent. No human context-switch in the middle.

```
your agent ──"what's the deploy policy in <their repo>?"──▶ their live local agent
    ▲                                                              │
    └──────────────────── reply routed back ◀──────────────────────┘
```

What makes it safe and controlled:

- **It's their live agent, not a cloud bot.** You reach the actual session on their machine, with
  their context — not a stateless copy in the cloud.
- **They opt in every time.** A connection is a *grant* the receiver explicitly accepts; it's
  time-boxed (≤30 min) and they can revoke it anytime.
- **Your message is a question, not a command.** It arrives as *untrusted input* — it cannot make
  their agent run tools, touch files, use credentials, or act as them. Right now the receiver can
  **only reply in text** (tools are off). Letting it actually *do* work — with the owner approving
  each tool call — is a later milestone (§7).
- **Files travel as links, not bytes.** A repo or doc is shared as a GitHub/Drive URL, never as raw
  file contents.

Works **cross-runtime**: a Claude Code user can ask a Codex user's agent, and vice versa.

---

## 1. Repo layout

| Area | Path |
| --- | --- |
| Bridge (session mgmt + durable delivery) | `src/bridge/*` (`main.ts`, `bridge.ts`, `spool.ts`, `injector.ts`) |
| Runtime adapters | `src/adapters/{claude-code,codex,fake}/*` |
| Wire protocol / contracts | `src/shared/{contracts,transport,http-client,aicoo-transport}.ts` |
| CLI (`ccd`) | `src/cli/*` |
| Reference (mock) control plane | `src/control-plane/*` |
| Tests | `test/*` (34 tests) |

The **transport seam** is `MessageTransport` (`src/shared/transport.ts`). `makeTransport`
(`src/shared/aicoo-transport.ts`) returns the hosted client when `CCD_AICOO=1`, otherwise the mock —
this is where you bind to a hosted control plane.

---

## 2. Status, your tasks, and tests

### Where we are

**Done / verified:**
- Two-machine loop proven end-to-end against a hosted deployment (see status line above). Backed-up
  "stuck" messages self-healed and delivered once the answering bridge became healthy.
- 34 automated tests green; single-machine real-provider smoke passed (provider-native ACK ≤3s,
  exact correlated reply, hostile-prompt caused no side effect).
- A run of client-robustness fixes landed (all merged): auto default-route on registration,
  default-route published from the heartbeat loop (avoids a startup event-loop starvation), inbound
  path fault-isolated (a slow/failed ack can't wedge the SSE stream), and dead-`resume` recovery
  (a phantom session no longer crashes the bridge — it's dropped and a fresh session is created).

**Known-open (not bugs in this loop):**
- **Answering side must be logged in.** In the proven run, the reply text was *"Please run /login"* —
  the pipeline was 100% healthy; the receiving Claude Code CLI just wasn't authenticated.
- **Server-side hot-path fix** (performance): under load, per-event control-plane work can saturate
  the DB connection pool and make acks/route updates hang (>5s). Fix = lighten the realtime hot path
  (a monotonic auto-increment cursor instead of a per-event `MAX+1` transaction, plus slimmer
  handlers) — control-plane work, tracked on the hosted-backend side.
- **Owner-approved tools** (`canUseTool`) is not wired — see §7.

### What you need to do

| Priority | Task | Done when |
| --- | --- | --- |
| **P0** | Validate the two-machine text-only loop on **production** (`www.aicoo.io`) | `request → accept → send → reply` routed back to the asker, correlated to `messageId`; tools off ⇒ no side effect on the receiver |
| **P0** | Validate the flow in the **desktop app** | Collaborate button + Accept/Allow prompts render and work; if a built-in "Local Agent" toggle exists it registers an endpoint (if not, use the Quick-start bridge) |
| **P1** | Fix whatever breaks | loop green again — client fixes in this repo; backend fixes on the hosted backend (see §8) |
| **P1** | Land the **server hot-path fix** | monotonic auto-increment cursor + slimmer handlers replace the per-event `MAX+1` transaction (see Known-open) |
| **P2** | **Owner-approved tools — design + security review only, don't ship** | a reviewed wiring plan (see §7); do **not** flip tools on in these two days |

### Tests

Two kinds: **functional** (automated — run anywhere) and **scenario** (manual — real machines/accounts).

| Kind | What it checks | How | Status |
| --- | --- | --- | --- |
| Functional · automated | contracts, Claude/Codex adapters, control-plane services, bridge e2e (34 tests) | `npm ci && npm run typecheck && npm test` | ✅ green |
| Functional · single-machine real provider | provider ACK ≤3s + exact correlated reply + hostile prompt causes no side effect | `npm run demo:p1` | ✅ passed |
| Scenario · two-machine text-only | the full loop across two machines/accounts (the acceptance test) | §5 runbook | ✅ proven on preview — **re-run on prod + desktop** |
| Scenario · desktop | Collaborate button + Accept/Allow prompts inside the app | manual, in the desktop app | ⏳ to do |
| Scenario · hostile prompt | tools-off receiver ignores injected "run/delete/write" commands | included in §5 | ✅ single-machine — re-verify two-machine |
| Scenario · cross-runtime (optional) | a Claude sender reaching a Codex receiver | §5 with `--adapter codex` on B | ⏸ optional |

---

## 3. Prerequisites

- **Node.js ≥ 22.5** (developed on 24/26).
- **Claude Code CLI ≥ 2.1.211** on each machine (`claude --version`). Older CLIs lack `--safe-mode`
  and crash. The bridge drives the CLI.
- The **answering** machine's Claude Code must be **logged in**.
- Install strictly from the lockfile — see §4.

---

## 4. Install & run the tests

```bash
git clone https://github.com/Aicoo-Team/aicoo-local-agent
cd aicoo-local-agent
npm ci            # ALWAYS npm ci — never npm install, never copy node_modules (see §6.1)
npm run typecheck
npm test          # 12 files / 34 tests — should be all green
npm run demo      # P0 transport demo (fake adapter)
```

Optional real-provider single-machine smoke (consumes account quota):
```bash
claude /login                                    # or export ANTHROPIC_API_KEY
CLAUDE_CODE_PATH="$(command -v claude)" npm run demo:p1
```
`demo:p1` passes only if all hold: provider-native ACK within 3s, exact correlated reply, reply
delivered to the asker's frozen originating session, correlation preserved, and no file side effect
from the hostile-prompt check.

---

## 5. Two-machine test (self-contained)

You do **not** need two people — use **two accounts** (your main + a test account) on **two
machines**. First test is **text-only** (tools off). `CONTROL_PLANE` below is your hosted
control-plane URL (for a hosted Aicoo deployment, `CCD_AICOO=1` and point `--server` at the product
URL, e.g. `https://www.aicoo.io`, with an API key as the token).

> **Use a host that does not 307-redirect.** If the apex issues a 307 to `www`, cross-origin
> redirects strip the `Authorization: Bearer` header and you get a silent 401. Use the canonical
> (usually `www.`) host directly.

**Sanity check the control plane is alive (401 = alive, 404 = wrong host/path):**
```bash
curl -s -X POST "$CONTROL_PLANE/api/v1/local-agent/endpoints"   # expect 401 unauthorized
```

**Step 1 — two accounts + tokens.** Create an API key per account = `A_TOKEN`, `B_TOKEN`. Rotate
them after testing (they land in shell history / process env).

**Step 2 — pair A → B.** B must grant A agent access (this is the relationship the grant request
requires). Use your hosted app's agent-access / pairing flow.

**Step 3 — run a bridge on each machine** (from a clean clone, `npm ci`):
```bash
# machine B (ANSWERS — its Claude Code must be logged in)
CCD_AICOO=1 CCD_SERVER_URL="$CONTROL_PLANE" CCD_TOKEN="$B_TOKEN" \
  npm run bridge -- --adapter claude-code --spool b.spool

# machine A (ASKS)
CCD_AICOO=1 CCD_SERVER_URL="$CONTROL_PLANE" CCD_TOKEN="$A_TOKEN" \
  npm run bridge -- --adapter claude-code --spool a.spool
```
Each bridge registers its endpoint, sets a default route (from the heartbeat loop), and heartbeats.
Leave both running.

**Step 4 — A asks B.** `--to` takes B's **principalId (user UUID)**, not a username. Keep the
receiver stable and go request → accept → send in one shot (a grant freezes the receiver's live
session at accept time; churn makes it stale).
```bash
… CCD_TOKEN="$A_TOKEN" npm run ccd -- connect request --to <B_principalId> --spool a.spool   # → COMM id
… CCD_TOKEN="$B_TOKEN" npm run ccd -- connect accept <COMM>                                    # or Accept in the app
… CCD_TOKEN="$A_TOKEN" npm run ccd -- send --comm-session <COMM> --text "reply with exactly: PONG"   # → messageId
… CCD_TOKEN="$A_TOKEN" npm run ccd -- status <messageId> --watch                               # answer lands on A's bridge stdout
```

**What proves success:** B's app shows the Accept prompt and B accepts; A receives B's **text**
answer correlated to `messageId`; **no** tool call / file side effect happened on B (tools off).

**Delivery advances monotonically:**
```
queued → dispatched → device_acked → runtime_pending → runtime_acked
terminal: rejected | failed | expired | revoked        (human inbox only: inbox_persisted)
```

---

## 6. Gotchas (these already bit us)

### 6.1 `npm ci` only
Never `npm install` to repair/verify, never copy `node_modules` between machines (loses the Rollup
native binary / keeps macOS quarantine metadata). A clean `npm ci` restores from the registry.

### 6.2 🔴 Do **not** delete the spool
The spool file (`*.spool`) holds the **durable cursor** and the **native→server session-handle
mapping**. Deleting it (a) resets the cursor → the control plane **replays stale messages
indefinitely**, and (b) changes the session handle → any grant frozen on the old handle goes
**stale**. With the fault-isolation and dead-resume fixes in place, **on restart delete nothing** —
the cursor self-advances and a dead `resume` self-recovers. (The device-identity file is meant to
persist and is the only thing you keep across resets anyway.)

### 6.3 Answering side must be logged in
No login → the reply is a "Please run /login" notice, not a real answer. The pipeline is fine.

### 6.4 CLI version & targeting
Claude Code CLI **≥ 2.1.211**. `--to` is a **principalId (UUID)**, not a username.

### 6.5 Host redirects strip auth
See §5 — use the non-redirecting (`www.`) host, or `Authorization: Bearer` is dropped on the 307.

### 6.6 In hosted mode, `ccd connect list` / `inbox` may 404
The hosted transport doesn't override those list paths, so the CLI falls back to mock flat paths and
404s. Query directly instead:
```bash
curl -H "Authorization: Bearer $TOKEN" "$CONTROL_PLANE/api/v1/local-agent/grants"
curl -H "Authorization: Bearer $TOKEN" "$CONTROL_PLANE/api/v1/local-agent/messages/<id>"
```

---

## 7. Owner-approved tools (read before touching)

Do **not** flip tools on blindly. The machinery exists but is intentionally left inert:
`src/adapters/claude-code/claude-code-adapter.ts` `canUseTool` (~L349) has a `resolveToolPermission`
injection point — with **no resolver it denies all** (today's text-only default); with a resolver it
honors the owner's decision and **fails closed** on any error/timeout. The transport already has
`requestToolApproval` / `getToolApproval`. The missing wire is a bridge-side resolver that consults
the owner's per-relationship tool policy, auto-allows a matched policy, otherwise pushes an
approval to the owner and returns their decision — plus enabling the tool set.

Before wiring it, settle three things so it isn't done unsafely:
1. **The reply is itself an exfiltration channel** — auto-allow only workspace-internal *safe reads*,
   and route replies through an output sanitizer.
2. **Default writes / execution / network / out-of-workspace reads to "ask the owner."**
3. **Scope the grant to the workspace**, expiring with the grant.

This flips the tools-disabled default, so it warrants a dedicated security review, not a quick patch.

---

## 8. How to contribute a fix

```
Client/bridge/adapter/CLI/transport change
  → branch this repo → change → `npm ci && npm run typecheck && npm test` (34 green) + a local smoke
  → open a PR

Control-plane / backend change
  → made on the hosted-backend side (not this repo); validate on a preview deployment before prod
```
Keep the two-machine loop green as your regression gate. If you touch the delivery/injection path,
re-run §5 end-to-end.

---

## 9. Roadmap (next up)

Both next features are realtime fan-out work:

- **Bidirectional realtime.** Today it's request→reply (the answer takes the grant-frozen reverse
  route once). Next: a persistent two-way channel on the same grant where both sides can push
  (follow-ups, clarifications, streamed progress) — needs two-way session semantics (each side an
  in/out cursor), a re-drawn loop-prevention rule, and ordering/dedupe guarantees. Don't break the
  delivery semantics in [SPEC](../SPEC.md).
- **Multi-agent collaboration.** Today a grant is 1:1. Next: one asker fans out to N receivers (or a
  group session with several agents), aggregating replies — a fan-out publish to many endpoints,
  multi-way ack aggregation, and an N-party grant/approval matrix.
- **Owner-approved tools** (§7) — the milestone that turns the receiver from "answers in text" into
  "does work, one approved tool call at a time."

---

## 10. Reading order

1. This document.
2. [README.md](../README.md) — what it is, safety model, install/run.
3. [SPEC.md](../SPEC.md) — the wire protocol, delivery states, and acceptance criteria.
4. The code: `src/bridge/*` (delivery/injection), `src/adapters/*` (runtimes),
   `src/shared/transport.ts` (the seam).

> **Pulse engineers:** deployment specifics (preview vs prod hosts, DB migrations, promotion, the
> backend hot-path fix, and team contacts) are shared separately — they're not part of this open
> repository.
