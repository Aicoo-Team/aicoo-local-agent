# Relationship-based tool and folder access

The bridge remains text-only unless the owner explicitly supplies a relationship
policy. A policy matches the sender identity derived by the control plane from
authentication — never a user-provided field in the message body.

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

Relative folders are resolved against `--workspace`. Start a Claude Code bridge
with the policy:

```bash
npm run bridge -- \
  --adapter claude-code \
  --workspace /path/to/project \
  --relationship-policy relationships.json \
  --spool me.spool
```

You can also set `CCD_RELATIONSHIP_POLICY=relationships.json`.

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
- Codex remains text-only until its adapter has an equivalent per-tool gate.

The hosted control plane must include `senderDeviceId` in dispatch envelopes,
derived from the authenticated device credential. If it does not, all
relationship-policy tool requests fail closed.

