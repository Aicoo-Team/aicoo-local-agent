# Relationship-based access

The live bridge is text-only for both Claude Code and Codex. A relationship
matches identity derived by the control plane from authentication — never
user-provided identity fields in the message body.

## Simple onboarding flow

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

Accept a relationship normally, or record the explicit chat-only policy:

```bash
npm run ccd -- connect accept <comm-id> \
  --access chat-only
```

The CLI gets the requester's verified user and device IDs from the accepted
grant and writes the local policy automatically. Automatic agent-to-agent text
replies are unchanged.

## Tool-access security hold

`read-project` and `edit-project` are not exposed by the CLI and neither live
adapter activates policy tools. They must remain disabled until the runtime
provides:

- one runtime conversation per communication session;
- an OS-enforced filesystem sandbox for the granted folder;
- grant expiry/revocation binding and an owner-visible audit trail.

The dormant policy engine is still fail-closed and adversarially tested so it
can be reused beneath that future sandbox.

## Policy file format

The generated file is ordinary JSON for auditability and advanced editing:

```json
{
  "version": 1,
  "relationships": [
    {
      "principalId": "USER_UUID",
      "deviceId": "VERIFIED_DEVICE_ID",
      "tools": [],
      "folders": []
    }
  ]
}
```

The policy must be outside every folder it grants. Override the default only
with `CCD_RELATIONSHIP_POLICY` or `--relationship-policy`.

## Enforcement

- Both `principalId` and `deviceId` must match exactly.
- Unknown, MCP, shell, delegation, web, Glob, and Grep tools deny by default.
- The dormant path gate recognizes only `Read`, `Write`, and `Edit`.
- Literal paths are resolved through the filesystem before containment checks;
  the canonical authorized path is also the path passed forward for execution.
- A policy inside a granted folder is rejected, and the policy itself cannot be
  accessed by a remote tool.
- Filesystem-root grants are rejected.
- Missing identity, missing policy, missing path, and policy errors deny access.
- Each Claude managed conversation binds to one communication session and
  rejects messages from a different relationship.
- Live Claude and Codex adapters expose no relationship-policy tools.

The hosted control plane must include `senderDeviceId` in dispatch envelopes,
and `requesterDeviceId` in grant responses, both derived from authenticated
device credentials. If either is missing, automatic replies still work, but
relationship-policy tool access remains blocked.
