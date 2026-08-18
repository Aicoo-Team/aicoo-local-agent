# Goal

**Someone else's local agent can do, for you, anything it can already do for them — and its owner
stays in control of every bit of it.**

Aicoo is the relay and the permission layer. Nothing else. The peer's agent runs on the peer's
machine, with their tools, their MCP servers, their memory, their credentials. None of that moves.
Only the request goes out and the result comes back.

That means the target state is not "we integrate Gmail, then Docker, then a browser". It is:
**we stop standing in the way, and we make the owner's yes/no real.**

## Where we are against that

Measured, not assumed (`test/manual/`, `docs/`):

| | today | if we simply stop blocking |
|---|---|---|
| tools available to a peer's session | **3** (`Read`/`Write`/`Edit`) | **51** |
| the owner's own MCP servers | 0 | **18 tools**, no integration code |
| the owner's skills / commands | 47 | **104** |

So the capability half of the goal is close, and it is mostly deletion rather than construction.
Two lines — `mcpServers: {}` and `settingSources: []` — are most of what stands between a peer and
the owner's full agent.

The permission half is **not** close, and it is the blocker.

## The one thing that must be true first

Everything above rests on `canUseTool` being on the path for every call, because that is what turns
"the peer's agent can do anything" into "the owner decides what it does".

**Right now it is not.** `test/manual/gate-reliability.mjs` reproduces it: with the exact options
the bridge ships, the peer's session read a file outside every granted folder, and the relationship
policy was never consulted. 21/21 attempts across 7 configurations, including with the environment
scrubbed. Details and evidence in the private tracker.

Until that is fixed and this harness reports `HOLDS`, widening the tool surface makes the problem
larger, not the product better. **A gate that does not fire is not a permission layer.**

## Sequence

1. **Make the gate hold.** Not negotiable and not parallelizable — every later step assumes it.
   Verified by `gate-reliability.mjs` going green, on a machine whose owner has permissive personal
   settings, since that is the case that currently fails.
2. **Inherit capability, never trust.** Drop the hardcoded tool list; pass the owner's own MCP
   servers through explicitly; load their skills. But never inherit their `permissions.allow` or
   `defaultMode` — those encode "what I let myself do on my own machine", written before c2c
   existed. The owner cannot have consented to a stranger's agent with a config that predates it.
3. **Generalize the policy vocabulary.** From "one of three file tools + a folder" to "tool-name
   pattern + optional scope", so the owner can pre-authorize `mcp__gmail__*` the way they can
   pre-authorize `Read`. Session-scoped answers already absorb most of the friction.
4. **Let Codex actually act.** The app-server driver can carry approvals, but the prompt still
   tells Codex to use no tools. Change the preamble, retire the broker.
5. **Make the prompt decidable.** Once everything is inherited, the one line the owner reads is the
   whole of their protection. `mcp__internal__query {...}` is not a decision, it is a coin flip.

## What is deliberately not the goal

Rebuilding a permission system. Claude Code and Codex already have good ones, and the peer's agent
should keep using theirs. Our job is narrower and it is the part nobody else can do: making sure a
*third party's* request is separated from the owner's own standing trust, and that the owner is
asked in terms they can actually judge.
