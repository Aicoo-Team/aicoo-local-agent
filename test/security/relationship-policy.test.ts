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
  resetRelationshipPolicy,
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

  it("resolves relative paths against an approved folder", () => {
    const directory = makeDirectory();
    const workspace = join(directory, "workspace");
    const allowed = join(directory, "approved");
    const config = join(directory, "config");
    mkdirSync(workspace);
    mkdirSync(allowed);
    mkdirSync(config);
    writeFileSync(join(allowed, "README.md"), "approved readme");
    const policy = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [allowed],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(policy, workspace);

    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: "README.md" } },
      inbound(),
    )).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: join(realpathSync.native(allowed), "README.md") },
    });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: "../secret.txt" } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
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

  it("requires explicit project selection when one verified device has multiple folders", () => {
    const directory = makeDirectory();
    const first = join(directory, "first-project");
    const second = join(directory, "second-project");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(config);
    const file = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);

    expect(permissions.accessFor(inbound())).toMatchObject({
      status: "selection_required",
      preset: "chat-only",
      folders: [],
    });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(first, "README.md") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("must select") });

    const selected = inbound({
      payload: {
        task: { text: "Inspect the selected project", projectAccessId: second },
      },
    });
    expect(permissions.accessFor(selected)).toMatchObject({
      status: "selected",
      preset: "read-project",
      folders: [realpathSync.native(second)],
    });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(second, "README.md") } },
      selected,
    )).toMatchObject({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(first, "README.md") } },
      selected,
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
  });

  it("selects several explicitly granted projects for one initial boundary", () => {
    const directory = makeDirectory();
    const first = join(directory, "first-project");
    const second = join(directory, "second-project");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(config);
    const file = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);
    const selected = inbound({
      payload: {
        task: {
          text: "Compare both projects",
          projectAccessIds: [first, second],
        },
      },
    });

    expect(permissions.accessFor(selected)).toMatchObject({
      status: "selected",
      preset: "read-project",
      folders: [realpathSync.native(first), realpathSync.native(second)].sort(),
    });
    for (const project of [first, second]) {
      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "README.md") } },
        selected,
      )).toMatchObject({ behavior: "allow" });
    }
  });

  it("preflights unambiguous project names from the objective using active grants only", () => {
    const directory = makeDirectory();
    const first = join(directory, "first-project");
    const second = join(directory, "second-project");
    const unrelated = join(directory, "unrelated-project");
    const config = join(directory, "config");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(unrelated);
    mkdirSync(config);
    const file = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second, unrelated],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);

    expect(permissions.accessFor(inbound({
      kind: "task_invite",
      payload: { task: { text: "Compare first-project with second-project" } },
    }))).toMatchObject({
      status: "selected",
      selectionSource: "objective_preflight",
      folders: [realpathSync.native(first), realpathSync.native(second)].sort(),
    });
    expect(permissions.accessFor(inbound({
      kind: "task_invite",
      payload: { task: { text: "Compare both projects" } },
    }))).toMatchObject({
      status: "selection_required",
      folders: [],
    });
  });

  it("does not guess between duplicate project names during objective preflight", () => {
    const directory = makeDirectory();
    const first = join(directory, "first", "project");
    const second = join(directory, "second", "project");
    const config = join(directory, "config");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    mkdirSync(config);
    const file = writePolicy(config, {
      version: 1,
      relationships: [{
        principalId: "prn_a",
        deviceId: "device-a1",
        tools: ["Read"],
        folders: [first, second],
      }],
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);

    expect(permissions.accessFor(inbound({
      kind: "task_invite",
      payload: { task: { text: "Inspect project" } },
    }))).toMatchObject({ status: "selection_required", folders: [] });
    expect(permissions.accessFor(inbound({
      kind: "task_invite",
      payload: { task: { text: `Inspect ${realpathSync.native(second)}` } },
    }))).toMatchObject({
      status: "selected",
      selectionSource: "objective_preflight",
      folders: [realpathSync.native(second)],
    });
  });

  it("forgets generated peer permissions when a bridge run resets its policy", () => {
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
      preset: "edit-project",
      folder: project,
    });

    resetRelationshipPolicy(file);

    const permissions = RelationshipPolicy.fromFile(file, directory);
    expect(permissions.enabledTools()).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, relationships: [] });
  });

  it("derives Git access from the project preset", () => {
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
      preset: "edit-project",
      folder: project,
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);

    expect(permissions.authorizeBoundary(
      { toolName: "GitStatus", input: { repository: project } },
      inbound(),
    )).toMatchObject({ behavior: "allow", updatedInput: { repository: realpathSync.native(project) } });
    expect(permissions.authorize(
      { toolName: "GitStatus", input: { repository: project } },
      inbound(),
    )).toMatchObject({ behavior: "allow", updatedInput: { repository: realpathSync.native(project) } });
  });

  it("prevents peer edits from planting Git configuration or attribute execution", () => {
    const directory = makeDirectory();
    const project = join(directory, "project");
    const config = join(directory, "config");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(config);
    const file = join(config, "relationships.json");
    upsertRelationshipPreset({
      file,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: project,
    });
    const permissions = RelationshipPolicy.fromFile(file, directory);

    for (const filePath of [join(project, ".git", "config"), join(project, ".gitattributes")]) {
      expect(permissions.authorize(
        { toolName: "Write", input: { file_path: filePath } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Execution-on-next-use") });
    }
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

  it.runIf(process.platform !== "win32")(
    "denies symlink escapes created before and after policy load",
    () => {
      const directory = makeDirectory();
      const project = join(directory, "project");
      const secrets = join(directory, "secrets");
      const config = join(directory, "config");
      mkdirSync(project);
      mkdirSync(secrets);
      mkdirSync(config);
      writeFileSync(join(secrets, "id_rsa"), "secret");
      symlinkSync(join(secrets, "id_rsa"), join(project, "key-link"));
      const policy = writePolicy(config, {
        version: 1,
        relationships: [{
          principalId: "prn_a",
          deviceId: "device-a1",
          tools: ["Read", "Write"],
          folders: [project],
        }],
      });
      const permissions = RelationshipPolicy.fromFile(policy, project);
      symlinkSync(secrets, join(project, "late-link"));

      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "key-link") } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "late-link", "id_rsa") } },
        inbound(),
      )).toMatchObject({ behavior: "deny", message: expect.stringContaining("outside") });
      expect(permissions.authorize(
        { toolName: "Write", input: { file_path: join(project, "late-link", "new-secret.txt") } },
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

  it("denies Glob/Grep traversal and unknown tools", () => {
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

  });

  it("allows explicit root grants but still blocks sensitive paths", () => {
    const directory = makeDirectory();
    const root = parse(directory).root;
    const config = join(directory, "config");
    mkdirSync(config);
    const policyFile = join(config, "root-policy.json");

    upsertRelationshipPreset({
      file: policyFile,
      principalId: "prn_a",
      deviceId: "device-a1",
      preset: "edit-project",
      folder: root,
    });
    const permissions = RelationshipPolicy.fromFile(policyFile, directory);

    expect(permissions.grantedFolders()).toContain(root);
    expect(permissions.sandboxDenyReadPaths()).toContain(join(root, ".ssh"));
    expect(permissions.sandboxDenyWritePaths()).toContain(join(root, "package.json"));
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(directory, "notes.md") } },
      inbound(),
    )).toMatchObject({ behavior: "allow" });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(directory, ".env") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Credential") });
    expect(permissions.authorize(
      { toolName: "Read", input: { file_path: join(directory, ".ssh", "id_rsa") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Credential") });
    expect(permissions.authorize(
      { toolName: "Edit", input: { file_path: join(directory, "package.json") } },
      inbound(),
    )).toMatchObject({ behavior: "deny", message: expect.stringContaining("Execution-on-next-use") });
  });

  it.runIf(process.platform !== "win32")(
    "denies path canonicalization failures instead of throwing",
    () => {
      const directory = makeDirectory();
      const project = join(directory, "project");
      const config = join(directory, "config");
      mkdirSync(project);
      mkdirSync(config);
      writeFileSync(join(project, "file.txt"), "not a directory");
      writeFileSync(join(project, "safe.txt"), "safe");
      symlinkSync("loop", join(project, "loop"));
      const policy = writePolicy(config, {
        version: 1,
        relationships: [{
          principalId: "prn_a",
          deviceId: "device-a1",
          tools: ["Read"],
          folders: [project],
        }],
      });
      const permissions = RelationshipPolicy.fromFile(policy, directory);

      for (const file_path of [
        join(project, "loop", "x"),
        join(project, "file.txt", "child"),
        `${project}\u0000`,
        join(project, "x".repeat(10_000)),
      ]) {
        expect(() => permissions.authorize({ toolName: "Read", input: { file_path } }, inbound()))
          .not.toThrow();
        expect(permissions.authorize({ toolName: "Read", input: { file_path } }, inbound()))
          .toMatchObject({ behavior: "deny", message: expect.stringContaining("resolved safely") });
      }
      expect(permissions.authorize(
        { toolName: "Read", input: { file_path: join(project, "safe.txt") } },
        inbound(),
      )).toMatchObject({ behavior: "allow" });
    },
  );

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
