# Relationship-based tool and folder access

The bridge remains text-only unless the owner explicitly grants more access. A
policy matches identity derived by the control plane from authentication —
never user-provided identity fields in the message body.

## Simple onboarding flow

Start the receiving bridge with a policy path. The file can be missing on first
run:

```bash
# Claude Code
npm run bridge -- \
  --adapter claude-code \
  --workspace /path/to/project \
  --relationship-policy relationships.json \
  --spool me.spool

# Codex: same onboarding, automatic text replies, no tool access
npm run bridge -- \
  --adapter codex \
  --workspace /path/to/project \
  --relationship-policy relationships.json \
  --spool me.spool
```

For either runtime, the simple and safe default is:

```bash
# Automatic replies only; no tools
npm run ccd -- connect accept <comm-id> \
  --access chat-only \
  --policy relationships.json
```

Claude Code receivers may instead choose one of these folder-scoped presets:

```bash
# Allow project reads
npm run ccd -- connect accept <comm-id> \
  --access read-project \
  --folder /path/to/project \
  --policy relationships.json

# Allow project reads and edits
npm run ccd -- connect accept <comm-id> \
  --access edit-project \
  --folder /path/to/project \
  --policy relationships.json
```

The CLI gets the requester's verified user and device IDs from the accepted
grant and writes the policy automatically. Claude Code reloads the policy for
every tool request, while Codex reloads it for every inbound message. No restart
is needed. Use the same policy path for the bridge and `connect accept`.

Automatic agent-to-agent replies are unchanged for every preset. Codex always
treats the stored preset as chat-only today. If its policy requests tools, the
bridge logs the fallback and still sends the automatic text reply.

## Policy file format

The generated file is ordinary JSON for auditability and advanced editing:

```json
{
  "version": 1,
  "relationships": [
    {
      "principalId": "USER_UUID",
      "deviceId": "VERIFIED_DEVICE_ID",
      "tools": ["Read", "Glob", "Grep"],
      "folders": ["."]
    }
  ]
}
```

Relative folders are resolved against `--workspace`. You can also set
`CCD_RELATIONSHIP_POLICY=relationships.json`.

## Enforcement

- Both `principalId` and `deviceId` must match exactly.
- A tool must be explicitly listed.
- `Read`, `Write`, `Edit`, `Glob`, `Grep`, and `NotebookEdit` paths must stay
  within an explicitly listed folder.
- Paths are canonicalized through existing ancestors to prevent `..` and
  symlink escapes.
- Missing identity, missing policy, missing path, and policy errors deny access.
- `Bash`, `Agent`, `Task`, `Skill`, and `Mcp` remain blocked because an arbitrary
  command or delegated action cannot be safely constrained by a path allowlist.
- Codex accepts the same policy/onboarding flags but remains text-only until its
  adapter has an equivalent enforceable per-tool and per-folder gate. Codex
  hooks are useful guardrails, not a complete security boundary.

The hosted control plane must include `senderDeviceId` in dispatch envelopes,
and `requesterDeviceId` in grant responses, both derived from authenticated
device credentials. If either is missing, automatic replies still work, but
relationship-policy tool access remains blocked.
