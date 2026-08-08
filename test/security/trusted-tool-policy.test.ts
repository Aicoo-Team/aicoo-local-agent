import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/adapters/runtime-adapter.js";
import { RelationshipPolicy } from "../../src/security/relationship-policy.js";
import {
  readTrustedToolPolicies,
  markTrustedToolPolicyUsesReported,
  pendingTrustedToolPolicyUses,
  revokeTrustedToolPolicy,
  upsertTrustedToolPolicy,
} from "../../src/security/trusted-tool-policy.js";

describe("trusted collaborator tool policies", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("matches one verified device, normalized tool, canonical folder, and owner identity", () => {
    const fixture = setup();
    upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      normalizedTool: "Read",
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
      normalizedTool: "Read",
      useCount: 1,
      lastUsedAt: expect.any(String),
    });
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
      normalizedTool: "Read",
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
      normalizedTool: "GitStatus",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    });

    const restarted = load(fixture, "bridge-new");
    expect(restarted.authorize(
      { toolName: "Read", input: { file_path: fixture.notes } },
      message(),
    )).toMatchObject({ behavior: "deny" });
    expect(restarted.authorize(
      { toolName: "GitStatus", input: { repository: fixture.project } },
      message(),
    )).toMatchObject({ behavior: "allow" });
  });

  it("revokes the exact tool on the next policy load and deduplicates exact active records", () => {
    const fixture = setup();
    const first = upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: fixture.project,
      normalizedTool: "Edit",
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
      normalizedTool: "Edit",
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

  it("rejects filesystem roots", () => {
    const fixture = setup();
    expect(() => upsertTrustedToolPolicy({
      file: fixture.trustedFile,
      ownerPrincipalId: "owner",
      ownerDeviceId: "owner-device",
      requesterPrincipalId: "requester",
      requesterDeviceId: "requester-device",
      folder: parse(fixture.project).root,
      normalizedTool: "Read",
      scope: "persistent",
      createdFrom: "cli",
      createdBy: "owner",
    })).toThrow("Filesystem roots");
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
      normalizedTool: "Read" as const,
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
      normalizedTool: "Read",
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
      normalizedTool: "Read",
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
