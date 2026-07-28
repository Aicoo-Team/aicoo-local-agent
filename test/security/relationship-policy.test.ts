import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/adapters/runtime-adapter.js";
import {
  RelationshipPolicy,
  upsertRelationshipPreset,
} from "../../src/security/relationship-policy.js";

describe("RelationshipPolicy", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("requires an exact verified user+device match and explicit tool+folder access", () => {
    const directory = makeDirectory();
    const allowed = join(directory, "allowed");
    const policy = writePolicy(directory, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read", "Write", "WebSearch"],
        folders: ["allowed"],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(policy, directory);

    expect(permissions.enabledTools()).toEqual(["Read", "WebSearch", "Write"]);
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(allowed, "notes.md") } },
      inbound(),
    )).toEqual({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "WebSearch", input: { query: "Aicoo" } },
      inbound(),
    )).toEqual({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(directory, "private.md") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
    expect(permissions.authorize(
      { toolName: "Edit", input: { file_path: join(allowed, "notes.md") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("not allowed") });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(allowed, "notes.md") } },
      inbound({ senderDeviceId: "different-device" }),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("No policy") });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(allowed, "notes.md") } },
      inbound({ senderDeviceId: undefined }),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("unavailable") });
  });

  it("keeps shell and delegation tools blocked because folders cannot scope them safely", () => {
    const directory = makeDirectory();
    const policy = writePolicy(directory, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Bash", "Agent", "Read"],
        folders: ["."],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(policy, directory);

    expect(permissions.enabledTools()).toEqual(["Read"]);
    expect(permissions.authorize(
      { toolName: "Bash", input: { command: "pwd" } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("cannot be safely restricted") });
  });

  it("creates and updates presets without requiring users to edit JSON", () => {
    const directory = makeDirectory();
    const file = join(directory, "relationships.json");

    upsertRelationshipPreset({
      file,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "read-project",
      folder: directory,
    });
    let permissions = RelationshipPolicy.fromFile(file, directory);
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(directory, "README.md") } },
      inbound(),
    )).toEqual({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "Write", input: { file_path: join(directory, "README.md") } },
      inbound(),
    )).toMatchObject({ behavior: "deny" });

    upsertRelationshipPreset({
      file,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: directory,
    });
    permissions = RelationshipPolicy.fromFile(file, directory);
    expect(permissions.authorize(
      { toolName: "Write", input: { file_path: join(directory, "README.md") } },
      inbound(),
    )).toEqual({ behavior: "allow" });

    const document = JSON.parse(readFileSync(file, "utf8")) as { relationships: unknown[] };
    expect(document.relationships).toHaveLength(1);
  });

  function makeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-policy-"));
    directories.push(directory);
    return directory;
  }
});

function writePolicy(directory: string, value: unknown): string {
  const file = join(directory, "relationships.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "msg_1",
    clientMessageId: "client_1",
    communicationSessionId: "comm_1",
    senderPrincipalId: "prn_a",
    senderDeviceId: "device-a1",
    target: {
      kind: "runtime_session",
      principalId: "prn_b",
      endpointId: "ep_b",
      sessionHandle: "rs_b",
    },
    kind: "text",
    payload: { text: "hello" },
    sequence: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    trust: "untrusted_external_content",
    ...overrides,
  };
}
