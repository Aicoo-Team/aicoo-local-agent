import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/adapters/runtime-adapter.js";
import { RelationshipPolicy } from "../../src/security/relationship-policy.js";
import {
  invalidateTrustedToolPolicy,
  markTrustedToolPolicyUsed,
  readTrustedToolPolicies,
  markTrustedToolPolicyUsesReported,
  pendingTrustedToolPolicyUses,
  revokeTrustedToolPolicy,
  upsertTrustedToolPolicy,
} from "../../src/security/trusted-tool-policy.js";

describe("trusted collaborator access presets", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("matches one verified device, access preset, canonical folder, and owner identity", () => {
    const fixture = setup();
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    const policy = load(fixture, "bridge-new");

    expect(policy.authorize(
      { toolName: "Read", input: { file_path: "notes.txt" } },
      message(),
    )).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: realpathSync.native(fixture.notes) },
    });
    expect(policy.authorize(
      { toolName: "Write", input: { file_path: "notes.txt" } },
      message(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("not allowed") });
    expect(policy.authorize(
      { toolName: "Read", input: { file_path: fixture.outside } },
      message(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
    expect(policy.authorize(
      { toolName: "Read", input: { file_path: "notes.txt" } },
      message({ senderDeviceId: "other-device" }),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("No policy") });

    expect(readTrustedToolPolicies(fixture.trustedFile).policies[0]).toMatchObject({
      accessPreset: "read-project",
      useCount: 1,
      lastUsedAt: expect.any(String),
    });
  });

  it("selects one trusted project by policy ID and refuses ambiguous access", () => {
    const fixture = setup();
    const secondProject = join(fixture.directory, "second-project");
    mkdirSync(secondProject);
    const first = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "edit-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    const second = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: secondProject,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    const policy = load(fixture, "bridge-new");

    expect(policy.accessFor(message())).toMatchObject({ status: "selection_required", folders: [] });
    const selected = message({
      payload: { task: { text: "Inspect it", projectAccessId: second.policyId } },
    });
    expect(policy.accessFor(selected)).toMatchObject({
      status: "selected",
      preset: "read-project",
      folders: [realpathSync.native(secondProject)],
    });
    expect(policy.authorize(
      { toolName: "Write", input: { file_path: join(secondProject, "notes.txt") } },
      selected,
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("not allowed") });
    expect(policy.accessFor(message({
      payload: { task: { text: "Inspect it", projectAccessId: `${first.policyId}-unknown` } },
    }))).toMatchObject({ status: "not_found", folders: [] });
  });

  it("expires bridge-run access on restart while persistent access survives", () => {
    const fixture = setup();
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "edit-project",
      scope: "bridge_run",
      bridgeInstanceId: "bridge-old",
      createdFrom: "cli",
      createdBy: "owner",
    });
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });

    const restarted = load(fixture, "bridge-new");
    expect(restarted.authorize(
      { toolName: "Write", input: { file_path: fixture.notes } },
      message(),
    )).toMatchObject({ behavior: "deny" });
    expect(restarted.authorize(
      { toolName: "GitStatus", input: { repository: fixture.project } },
      message(),
    )).toMatchObject({ behavior: "allow" });
  });

  it("revokes the exact preset on the next policy load and deduplicates exact active records", () => {
    const fixture = setup();
    const first = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "edit-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    const duplicate = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "edit-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    expect(duplicate.policyId).toBe(first.policyId);
    expect(readTrustedToolPolicies(fixture.trustedFile).policies).toHaveLength(1);

    revokeTrustedToolPolicy({ file: fixture.trustedFile, policyId: first.policyId, revokedBy: "owner" });

    expect(load(fixture, "bridge-new").authorize(
      { toolName: "Edit", input: { file_path: fixture.notes } },
      message(),
    )).toMatchObject({ behavior: "deny" });
  });

  it("lets the local owner revoke a synchronized policy without supplying its server revision", () => {
    // Regression: `ccd trusted-access revoke` omitted serverRevision, which became revision zero
    // and was rejected as stale for every policy originally synchronized from Aicoo settings.
    const fixture = setup();
    const policy = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: "ttp_server_managed",
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "edit-project",
      scope: "persistent",
      createdFrom: "settings",
      createdBy: "owner",
      serverRevision: 9,
    });

    expect(revokeTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: policy.policyId,
      revokedBy: "owner",
    })).toMatchObject({ status: "revoked", revokedBy: "owner" });
  });

  it("rejects filesystem roots", () => {
    const fixture = setup();
    expect(() => upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: parse(fixture.project).root,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    })).toThrow("Filesystem roots");
  });

  it("migrates legacy per-tool policy files to access presets", () => {
    const fixture = setup();
    const createdAt = new Date().toISOString();
    writeFileSync(fixture.trustedFile, JSON.stringify({
      version: 2,
      revision: 4,
      serverRevisions: { "legacy-read": 7, "legacy-write": 8 },
      policies: [
        {
          policyId: "legacy-read",
          ownerPrincipalId: "owner",
          ownerDeviceId: "owner-device",
          requesterPrincipalId: "requester",
          requesterDeviceId: "requester-device",
          canonicalFolder: realpathSync.native(fixture.project),
          normalizedTool: "GitDiff",
          scope: "persistent",
          status: "active",
          createdFrom: "settings",
          createdAt,
          createdBy: "owner",
          useCount: 0,
          pendingUses: [],
        },
        {
          policyId: "legacy-write",
          ownerPrincipalId: "owner",
          ownerDeviceId: "owner-device",
          requesterPrincipalId: "requester",
          requesterDeviceId: "requester-device",
          canonicalFolder: realpathSync.native(fixture.project),
          normalizedTool: "GitCommit",
          scope: "persistent",
          status: "active",
          createdFrom: "settings",
          createdAt,
          createdBy: "owner",
          useCount: 0,
          pendingUses: [],
        },
      ],
    }));

    expect(readTrustedToolPolicies(fixture.trustedFile)).toMatchObject({
      version: 3,
      revision: 4,
      policies: [
        { policyId: "legacy-read", accessPreset: "read-project" },
        { policyId: "legacy-write", accessPreset: "edit-project" },
      ],
    });
  });

  it("keeps a newer revocation ahead of a delayed allow event", () => {
    const fixture = setup();
    const input = {
      file: fixture.trustedFile,
      policyId: "ttp-hosted",
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project" as const,
      scope: "persistent" as const,
      createdFrom: "settings" as const,
      createdBy: "owner",
      serverRevision: 4,
    };
    upsertTrustedToolPolicy(input);
    revokeTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: input.policyId,
      revokedBy: "owner",
      serverRevision: 5,
    });

    expect(() => upsertTrustedToolPolicy(input)).toThrow("Stale trusted tool policy revision");
    expect(readTrustedToolPolicies(fixture.trustedFile).policies).toEqual([
      expect.objectContaining({ policyId: input.policyId, status: "revoked" }),
    ]);
  });

  it("queues each hosted policy use until the bridge reports its sequence", () => {
    const fixture = setup();
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: "ttp-local-cli",
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: "ttp-hosted-usage",
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "settings",
      createdBy: "owner",
      serverRevision: 6,
    });

    load(fixture, "bridge-new").authorize(
      { toolName: "Read", input: { file_path: fixture.notes } },
      message(),
    );
    const [pending] = pendingTrustedToolPolicyUses(
      fixture.trustedFile,
      "owner",
      "owner-device",
    );
    expect(pending).toMatchObject({
      serverRevision: 6,
      uses: [{ sequence: 1, usedAt: expect.any(String) }],
    });

    markTrustedToolPolicyUsesReported(fixture.trustedFile, "ttp-hosted-usage", 1);
    expect(pendingTrustedToolPolicyUses(fixture.trustedFile, "owner", "owner-device")).toEqual([]);
  });

  it("invalidates a cached hosted policy and drops unsendable usage", () => {
    const fixture = setup();
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      policyId: "ttp-deleted-hosted",
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      accessPreset: "read-project",
      scope: "persistent",
      createdFrom: "settings",
      createdBy: "owner",
      serverRevision: 3,
    });
    markTrustedToolPolicyUsed(fixture.trustedFile, "ttp-deleted-hosted");

    invalidateTrustedToolPolicy(fixture.trustedFile, "ttp-deleted-hosted", "Hosted policy no longer exists");

    expect(readTrustedToolPolicies(fixture.trustedFile).policies[0]).toMatchObject({
      status: "invalid",
      pendingUses: [],
      invalidatedReason: "Hosted policy no longer exists",
    });
    expect(pendingTrustedToolPolicyUses(fixture.trustedFile, "owner", "owner-device")).toEqual([]);
  });

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "aicoo-trusted-tools-"));
    cleanups.push(directory);
    const project = join(directory, "project");
    const config = join(directory, "config");
    mkdirSync(project);
    mkdirSync(config);
    const notes = join(project, "notes.txt");
    const outside = join(directory, "outside.txt");
    writeFileSync(notes, "inside");
    writeFileSync(outside, "outside");
    const relationshipFile = join(config, "relationships.json");
    const trustedFile = join(config, "trusted-tools.json");
    writeFileSync(relationshipFile, JSON.stringify({ version: 1, relationships: [] }));
    return { directory, project, notes, outside, relationshipFile, trustedFile };
  }
});

function load(
  fixture: { project: string; relationshipFile: string; trustedFile: string },
  bridgeInstanceId: string,
): RelationshipPolicy {
  return RelationshipPolicy.fromFile(fixture.relationshipFile, fixture.project, {
    trustedToolPolicyFile: fixture.trustedFile,
    ownerPrincipalId: "owner",
    ownerDeviceId: "owner-device",
    bridgeInstanceId,
  });
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const now = new Date().toISOString();
  return {
    id: "msg",
    clientMessageId: "client",
    communicationSessionId: "comm",
    senderPrincipalId: "requester",
    senderDeviceId: "requester-device",
    target: { kind: "runtime_session", principalId: "owner", sessionHandle: "session" },
    kind: "text",
    payload: { text: "task" },
    sequence: 1,
    createdAt: now,
    expiresAt: now,
    trust: "untrusted_external_content",
    ...overrides,
  };
}
