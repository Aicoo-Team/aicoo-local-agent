import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
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

    expect(permissions.enabledTools()).toEqual(["Read", "Write"]);
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(allowed, "notes.md") } },
      inbound(),
    )).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: join(realpathSync.native(directory), "allowed", "notes.md") },
    });
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
    const allowed = join(directory, "allowed");
    mkdirSync(allowed);
    const policy = writePolicy(directory, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Bash", "Task", "mcp__fs__write_file", "Read"],
        folders: ["allowed"],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(policy, directory);

    expect(permissions.enabledTools()).toEqual(["Read"]);
    for (const toolName of ["Bash", "Task", "mcp__fs__write_file", "SlashCommand"]) {
      expect(permissions.authorize(
        { toolName, input: { file_path: "/etc/passwd" } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Unsupported") });
    }
  });

  it("creates and updates presets without requiring users to edit JSON", () => {
    const directory = makeDirectory();
    const project = join(directory, "project");
    const config = join(directory, "config");
    mkdirSync(project);
    mkdirSync(config);
    const file = join(config, "relationships.json");

    upsertRelationshipPreset({
      file,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "read-project",
      folder: project,
    });
    let permissions = RelationshipPolicy.fromFile(file, directory);
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(project, "README.md") } },
      inbound(),
    )).toMatchObject({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "Write", input: { file_path: join(project, "README.md") } },
      inbound(),
    )).toMatchObject({ behavior: "deny" });

    upsertRelationshipPreset({
      file,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: project,
    });
    permissions = RelationshipPolicy.fromFile(file, directory);
    expect(permissions.authorize(
      { toolName: "Write", input: { file_path: join(project, "README.md") } },
      inbound(),
    )).toMatchObject({ behavior: "allow" });

    const document = JSON.parse(readFileSync(file, "utf8")) as { relationships: unknown[] };
    expect(document.relationships).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")(
    "denies symlink traversal and returns the canonical path it authorized",
    () => {
      const directory = makeDirectory();
      const project = join(directory, "project");
      const real = join(project, "real");
      const secrets = join(directory, "secrets");
      const config = join(directory, "config");
      mkdirSync(real, { recursive: true });
      mkdirSync(secrets);
      mkdirSync(config);
      writeFileSync(join(real, "safe.txt"), "safe");
      writeFileSync(join(secrets, "id_rsa"), "secret");
      symlinkSync(real, join(project, "alias"));
      symlinkSync(secrets, join(project, "link"));
      const policy = writePolicy(config, {
        version: 1,
        relationships: [{
          principalId: "prn_a",
          deviceId: "device-a1",
          tools: ["Read"],
          folders: [project],
        }],
      });
      const permissions = RelationshipPolicy.fromFile(policy, project);

      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "alias", "safe.txt") } },
        inbound(),
      )).toMatchObject({
        behavior: "allow",
        updatedInput: { file_path: realpathSync.native(join(real, "safe.txt")) },
      });
      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "link", "id_rsa") } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: `${project}/link/../secrets/id_rsa` } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
    },
  );

  it("refuses policy self-access and policies stored inside granted folders", () => {
    const directory = makeDirectory();
    const project = join(directory, "project");
    const config = join(directory, "config");
    mkdirSync(project);
    mkdirSync(config);
    const safePolicy = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read", "Write"],
        folders: [project],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(safePolicy, project);

    expect(permissions.authorize(
      { toolName: "Write", input: { file_path: safePolicy } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("policy") });

    const unsafePolicy = writePolicy(project, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [project],
      }],
    });
    expect(() => RelationshipPolicy.fromFile(unsafePolicy, project))
      .toThrow("Relationship policy must be stored outside every granted folder");
  });

  it("denies Glob/Grep traversal, unknown tools, and root grants", () => {
    const directory = makeDirectory();
    const project = join(directory, "project");
    const config = join(directory, "config");
    mkdirSync(project);
    mkdirSync(config);
    const policy = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Glob", "Grep", "MultiEdit"],
        folders: [project],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(policy, project);

    expect(permissions.authorize(
      { toolName: "Glob", input: { pattern: "../../../**/*.env" } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Unsupported") });
    expect(permissions.authorize(
      { toolName: "Grep", input: { pattern: "AWS_SECRET", glob: "../../**/*" } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Unsupported") });
    expect(permissions.authorize(
      { toolName: "MultiEdit", input: { file_path: join(project, "a.ts") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Unsupported") });

    expect(() => upsertRelationshipPreset({
      file: join(config, "root-policy.json"),
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: parse(directory).root,
    })).toThrow("Filesystem root cannot be granted");
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
