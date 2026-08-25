# Peer local-agent access

The live bridge connects one person's local Codex or Claude Code session to
another person's local Codex or Claude Code session through Aicoo. Aicoo is the
relay, identity, grants, routing, delivery-state, and revocation layer; it is
not the requesting agent.

The receiving bridge is chat-only by default. A relationship matches identity
derived by the control plane from authentication, never user-provided identity
fields in the message body.

Claude Code can optionally expose a narrow file-tool set for a verified
user+device relationship. Codex supports the same file presets through a
bridge-side broker: Codex plans structured file operations, and the bridge
validates and executes only allowed `Read`, `Write`, and `Edit` operations.

## Main app setup flow

In the hosted app, the owner-facing flow is:

1. Run `npx @aicoo/local-agent login`, open `/local-agent/device-code`, and
   approve the device code.
2. Start a local runtime bridge with `ccd start --adapter claude-code` or
   `ccd start --adapter codex`.
3. Open a teammate DM in Aicoo and click **Collaborate** to pair the two local
   agents.

Aicoo relays messages between both local runtimes:

```text
your local Codex/Claude <-> Aicoo <-> their local Codex/Claude
```

## CLI policy flow

Start the receiving bridge. By default, its relationship policy is outside the
workspace at `~/.aicoo/local-agent/relationships.json`:

```bash
# Claude Code
npm run bridge -- \
  --adapter claude-code \
  --workspace /path/to/project \
  --spool me.spool

# Codex
npm run bridge -- \
  --adapter codex \
  --workspace /path/to/project \
  --spool me.spool
```

Accept a relationship normally, record the explicit chat-only policy, or grant
file-tool access for one folder:

```bash
npm run ccd -- connect accept <comm-id> \
  --access chat-only

npm run ccd -- connect accept <comm-id> \
  --access read-project \
  --folder /path/to/project

npm run ccd -- connect accept <comm-id> \
  --access edit-project \
  --folder /path/to/project
```

The CLI gets the peer's verified user and device IDs from the accepted grant
and writes the local policy automatically. Automatic local-agent-to-local-agent
text replies are unchanged.

## Tool Access

- `chat-only` lets the peer's local agent send messages, with no file/tool access.
- `read-project` lets the peer's local agent request reads through Aicoo, limited
  to the approved folder.
- `edit-project` lets the peer's local agent request reads, writes, and edits
  through Aicoo, limited to the approved folder.
- `--folder` is required for `read-project` and `edit-project`.

Claude Code exposes the supported tools to the managed session, but every tool
call goes through the local relationship policy before execution. The policy is
reloaded on each tool request, matches the active message's verified
`senderPrincipalId` and `senderDeviceId`, canonicalizes literal file paths, and
passes forward only the canonical authorized path.

Codex does not receive direct filesystem tools. For relationships with file
access, it first returns structured broker requests. The bridge validates each
request with the same policy and performs only authorized operations, then gives
Codex the broker results for the final text reply.

## Policy file format

The generated file is ordinary JSON for auditability and advanced editing:

```json
{
  "version": 1,
  "relationships": [
    {
      "principalId": "USER_UUID",
      "deviceId": "VERIFIED_DEVICE_ID",
      "tools": ["Read"],
      "folders": ["/path/to/project"]
    }
  ]
}
```

The policy must be outside every folder it grants. Override the default only
with `CCD_RELATIONSHIP_POLICY` or `--relationship-policy`.

## Enforcement

- Both `principalId` and `deviceId` must match exactly.
- Restricted mode denies unknown, MCP, shell, delegation, and web tools by default.
- The path gate recognizes file, search, notebook, and constrained Git operations.
- Literal paths are resolved through the filesystem before containment checks;
  the canonical authorized path is also the path passed forward for execution.
- A policy inside a granted folder is rejected, and the policy itself cannot be
  accessed by a remote tool.
- Filesystem-root grants are rejected.
- Missing identity, missing policy, missing path, and policy errors deny access.
- Each Claude conversation and Codex thread binds to one communication session,
  rejects messages from a different relationship, and is released when that
  communication session is revoked or expired.
- In restricted mode, both runtimes expose only the narrow project capability
  surface and constrained Git operations allowed by the active relationship.
- Full-agent mode is explicit and stays closed until rebuild-health evidence,
  kernel scoping, owner approval, and an interruptible runtime path are present.
- Full-agent shell commands are size/timeout bounded, credential-filtered,
  sandboxed to the selected folders, and owner-approved. Direct runtime network
  access remains denied.
- Claude's wider tool and MCP surface uses the same owner gate. Codex keeps the
  owner's MCP/plugin configuration isolated pending explicit per-integration grants.

The hosted control plane must include `senderDeviceId` in dispatch envelopes,
and `requesterDeviceId` in grant responses, both derived from authenticated
device credentials. If either is missing, automatic replies still work, but
relationship-policy tool access remains blocked.
