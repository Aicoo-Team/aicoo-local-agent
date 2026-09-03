import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_PROFILE_NAME,
  renderCodexPermissionProfile,
  writeCodexPermissionProfile,
} from "../../src/adapters/codex/permission-profile.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("codex permission profile", () => {
  it("gives chat-only no profile at all", () => {
    expect(renderCodexPermissionProfile({ preset: "chat-only", folders: ["/srv/project"] })).toBeUndefined();
    // A preset that should have a folder but does not must not silently degrade into a profile
    // whose only grant is ":minimal" — that would read as "scoped" while granting nothing useful.
    expect(renderCodexPermissionProfile({ preset: "read-project", folders: [] })).toBeUndefined();
  });

  it("denies the root read the built-in presets grant, and restores only :minimal", () => {
    const profile = renderCodexPermissionProfile({ preset: "read-project", folders: ["/srv/project"] })!;
    expect(profile).toContain(`default_permissions = ${JSON.stringify(CODEX_PROFILE_NAME)}`);
    // Without ":root" = "deny" the session can read the whole disk: the built-in presets grant
    // root-level read, and writable_roots scopes writes only.
    expect(profile).toContain('":root" = "deny"');
    // Without ":minimal" the sandbox aborts (SIGABRT) before the command can even exec.
    expect(profile).toContain('":minimal" = "read"');
    expect(profile).toContain('extends = ":read-only"');
    expect(profile).toContain('"/srv/project" = true');
    expect(profile).toContain('"." = "read"');
  });

  it("lets macOS developer-tool shims read the selected toolchain", () => {
    const profile = renderCodexPermissionProfile({
      preset: "read-project",
      folders: ["/srv/project"],
      platform: "darwin",
      developerDirectory: "/Library/Developer/CommandLineTools",
    })!;

    expect(profile).toContain('"/Library/Developer/CommandLineTools" = "read"');
  });

  it("pins macOS developer tools to the private runtime environment", () => {
    // Regression: /usr/bin/git delegated through xcrun, which tried to write its cache outside
    // the immutable project boundary even though the generated TMPDIR itself was private.
    const dir = tempDir("codex-macos-toolchain-");
    const developerDirectory = "/Library/Developer/CommandLineTools";
    const prepared = writeCodexPermissionProfile(join(dir, "home"), {
      preset: "read-project",
      folders: ["/srv/project"],
      platform: "darwin",
      developerDirectory,
      authFile: join(dir, "missing-auth.json"),
    })!;
    const profile = readFileSync(join(prepared.codexHome, "config.toml"), "utf8");

    expect(prepared.environment).toMatchObject({ DEVELOPER_DIR: developerDirectory });
    expect(prepared.environment?.PATH).toMatch(
      new RegExp(`^${developerDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/usr/bin:`),
    );
    expect(profile).toContain(`DEVELOPER_DIR = ${JSON.stringify(developerDirectory)}`);
  });

  it("allows the configured Codex launcher, its target, and the directories needed to execute them", () => {
    const dir = tempDir("codex-runtime-path-");
    const launcherDirectory = join(dir, "launcher");
    const targetDirectory = join(dir, "runtime");
    mkdirSync(launcherDirectory);
    mkdirSync(targetDirectory);
    const target = join(targetDirectory, "codex-real");
    const launcher = join(launcherDirectory, "codex");
    writeFileSync(target, "runtime");
    symlinkSync(target, launcher);

    const profile = renderCodexPermissionProfile({
      preset: "read-project",
      folders: ["/srv/project"],
      runtimeExecutable: launcher,
    })!;

    expect(profile).toContain(`${JSON.stringify(launcherDirectory)} = "read"`);
    expect(profile).toContain(`${JSON.stringify(launcher)} = "read"`);
    const resolvedTarget = realpathSync.native(target);
    expect(profile).toContain(`${JSON.stringify(dirname(resolvedTarget))} = "read"`);
    expect(profile).toContain(`${JSON.stringify(resolvedTarget)} = "read"`);
    expect(profile).not.toContain(`${JSON.stringify(dir)} = "read"`);
  });

  it("grants a known package-manager launcher and only its canonical package runtime", () => {
    const dir = tempDir("codex-command-runtime-");
    const launcherDirectory = join(dir, "launcher");
    const packageRoot = join(dir, "packages", "npm");
    const target = join(packageRoot, "bin", "npm-cli.js");
    mkdirSync(launcherDirectory);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"npm"}');
    writeFileSync(target, "runtime");
    const launcher = join(launcherDirectory, "npm");
    symlinkSync(target, launcher);

    const profile = renderCodexPermissionProfile({
      preset: "read-project",
      folders: ["/srv/project"],
      platform: "linux",
      commandExecutables: [launcher],
    })!;

    expect(profile).toContain(`${JSON.stringify(launcher)} = "read"`);
    expect(profile).toContain(`${JSON.stringify(realpathSync.native(target))} = "read"`);
    expect(profile).toContain(`${JSON.stringify(realpathSync.native(packageRoot))} = "read"`);
    expect(profile).not.toContain(`${JSON.stringify(dir)} = "read"`);
  });

  it("uses the native null device for Git in Windows project sessions", () => {
    const dir = tempDir("codex-windows-profile-");
    const prepared = writeCodexPermissionProfile(join(dir, "home"), {
      preset: "read-project",
      folders: ["C:\\work\\project"],
      platform: "win32",
      authFile: join(dir, "missing-auth.json"),
    })!;
    const profile = readFileSync(join(prepared.codexHome, "config.toml"), "utf8");

    expect(prepared.environment).toMatchObject({
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(profile).toContain('GIT_CONFIG_GLOBAL = "NUL"');
    expect(profile).not.toContain("/Library/Developer/CommandLineTools");
  });

  it("grants write only for edit-project", () => {
    const read = renderCodexPermissionProfile({ preset: "read-project", folders: ["/srv/p"] })!;
    const edit = renderCodexPermissionProfile({ preset: "edit-project", folders: ["/srv/p"] })!;
    expect(read).toContain('"." = "read"');
    expect(read).toContain('extends = ":read-only"');
    expect(edit).toContain('"." = "write"');
    expect(edit).toContain('extends = ":workspace"');
  });

  it("does not widen read-only folders when one relationship has mixed folder presets", () => {
    const profile = renderCodexPermissionProfile({
      preset: "edit-project",
      folders: ["/srv/read-only", "/srv/writable"],
      writableFolders: ["/srv/writable"],
    })!;
    expect(profile).toContain('"." = "read"');
    expect(profile).toContain('"/srv/writable" = "write"');
    expect(profile).not.toContain('"/srv/read-only" = "write"');
  });

  it("keeps network closed for every preset", () => {
    for (const preset of ["read-project", "edit-project"] as const) {
      const profile = renderCodexPermissionProfile({ preset, folders: ["/srv/p"] })!;
      expect(profile).toContain("enabled = false");
    }
  });

  it("keeps credentials out of the command environment", () => {
    const profile = renderCodexPermissionProfile({ preset: "edit-project", folders: ["/srv/p"] })!;
    expect(profile).toContain("[shell_environment_policy]");
    expect(profile).toContain('inherit = "core"');
    expect(profile).toContain('"*TOKEN*"');
    expect(profile).toContain('"*SECRET*"');
  });

  it("adds only explicitly granted remote MCP tools to the private Codex home", () => {
    const profile = renderCodexPermissionProfile({
      preset: "read-project",
      folders: ["/srv/p"],
      mcpServers: [{
        name: "docs",
        url: "https://mcp.example.com/v1",
        enabledTools: ["search", "read"],
        bearerTokenEnvVar: "DOCS_AUTH",
      }],
    })!;
    expect(profile).toContain('mcp_oauth_credentials_store = "file"');
    expect(profile).toContain('[history]\npersistence = "none"');
    expect(profile).toContain('[memories]\ndisable_on_external_context = true');
    expect(profile).toContain('[mcp_servers."docs"]');
    expect(profile).toContain('enabled_tools = ["read", "search"]');
    expect(profile).toContain('[mcp_servers."docs".tools."read"]\napproval_mode = "approve"');
    expect(profile).toContain('"DOCS_AUTH"');
    expect(profile).not.toContain("command =");
    expect(profile).not.toContain("http_headers");
  });

  it("does not expose the macOS toolchain or scratch directory to MCP-only sessions", () => {
    const profile = renderCodexPermissionProfile({
      preset: "chat-only",
      folders: [],
      platform: "darwin",
      developerDirectory: "/Library/Developer/CommandLineTools",
      runtimeTempDirectory: "/private/aicoo/session-tmp",
      mcpServers: [{ name: "docs", url: "https://mcp.example.com/v1", enabledTools: ["search"] }],
    })!;

    expect(profile).not.toContain("/Library/Developer/CommandLineTools");
    expect(profile).not.toContain("/private/aicoo/session-tmp");
  });

  it("writes a private CODEX_HOME so the owner's own config cannot leak in", () => {
    const dir = tempDir("codex-profile-");
    const ownerHome = join(dir, "owner-home");
    const ownerPlugin = join(ownerHome, "plugins", "owner-private-plugin");
    mkdirSync(ownerPlugin, { recursive: true });
    writeFileSync(join(ownerPlugin, "plugin.json"), '{"name":"owner-private-plugin"}');
    const authFile = join(ownerHome, "auth.json");
    writeFileSync(authFile, '{"token":"test-only"}', { mode: 0o600 });
    const prepared = writeCodexPermissionProfile(join(dir, "home"), {
      preset: "read-project",
      folders: ["/srv/project"],
      authFile,
    })!;
    expect(prepared.profileName).toBe(CODEX_PROFILE_NAME);
    expect(prepared.environment).toMatchObject({
      TMPDIR: join(prepared.codexHome, "tmp"),
      NPM_CONFIG_CACHE: join(prepared.codexHome, "tmp", "npm-cache"),
      NPM_CONFIG_USERCONFIG: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    const profile = readFileSync(join(prepared.codexHome, "config.toml"), "utf8");
    expect(profile).toContain(`TMPDIR = ${JSON.stringify(join(prepared.codexHome, "tmp"))}`);
    expect(profile).toContain('GIT_CONFIG_GLOBAL = "/dev/null"');
    expect(profile).toContain('GIT_CONFIG_NOSYSTEM = "1"');
    expect(readFileSync(join(prepared.codexHome, "auth.json"), "utf8")).toBe('{"token":"test-only"}');
    // A plugin can bundle skills, MCP servers, and executable hooks. Copying the owner's
    // plugin directory would grant all of those without a relationship-level capability record.
    expect(existsSync(join(prepared.codexHome, "plugins"))).toBe(false);
    expect(profile).toContain("[features]");
    expect(profile).toContain("plugins = false");
    expect(profile).toContain("apps = false");
    expect(profile).toContain("remote_plugin = false");
    expect(profile).toContain("hooks = false");
    expect(profile).toContain('":root" = "deny"');
  });

  it("copies only owner skill bundles into an isolated full-agent home", () => {
    const dir = tempDir("codex-owner-skills-");
    const ownerRoot = join(dir, "owner");
    const skill = join(ownerRoot, "plugins", "calendar", "skills", "schedule");
    mkdirSync(join(skill, "scripts"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Schedule\nUse the calendar safely.\n");
    writeFileSync(join(skill, "scripts", "list.js"), "console.log('listed')\n");
    writeFileSync(join(ownerRoot, "plugins", "calendar", "plugin.json"), '{"hooks":["unsafe"]}');
    writeFileSync(join(ownerRoot, "plugins", "calendar", "hooks.json"), '{"SessionStart":"shell"}');

    const prepared = writeCodexPermissionProfile(join(dir, "isolated"), {
      preset: "chat-only",
      folders: [],
      isolateRuntime: true,
      includeOwnerSkills: true,
      ownerSkillRoots: [ownerRoot],
      authFile: join(dir, "missing-auth.json"),
    })!;

    const copiedSkills = join(prepared.codexHome, "skills");
    expect(existsSync(copiedSkills)).toBe(true);
    const discovered = execFileSync("find", [copiedSkills, "-name", "SKILL.md"], { encoding: "utf8" });
    expect(discovered).toContain("SKILL.md");
    expect(execFileSync("find", [prepared.codexHome, "-name", "plugin.json"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("find", [prepared.codexHome, "-name", "hooks.json"], { encoding: "utf8" })).toBe("");
    expect(readFileSync(join(prepared.codexHome, "config.toml"), "utf8")).toContain(
      `${JSON.stringify(copiedSkills)} = "read"`,
    );
  });

  it("allows the exact Codex runtime to launch in an isolated zero-grant profile", () => {
    const dir = tempDir("codex-isolated-runtime-");
    const runtime = join(dir, "codex");
    writeFileSync(runtime, "runtime");

    const profile = renderCodexPermissionProfile({
      preset: "chat-only",
      folders: [],
      isolateRuntime: true,
      runtimeExecutable: runtime,
    })!;

    expect(profile).toContain(`${JSON.stringify(runtime)} = "read"`);
    expect(profile).toContain(`${JSON.stringify(dirname(runtime))} = "read"`);
  });
});

/**
 * The unit tests above assert the TOML we emit. They cannot prove the kernel honours it, and that
 * is the only property that actually matters — so this exercises the real sandbox when codex is
 * present. Skipped rather than failed when it is not, so CI without codex stays green.
 */
const codexAvailable = (() => {
  try {
    execFileSync("codex", ["--version"], { stdio: "pipe" });
    return process.platform === "darwin" || process.platform === "linux";
  } catch {
    return false;
  }
})();

describe.skipIf(!codexAvailable)("codex permission profile (live sandbox)", () => {
  function probe(codexHome: string, cwd: string, argv: string[]): { ok: boolean; output: string } {
    try {
      const output = execFileSync("codex", ["sandbox", "-P", CODEX_PROFILE_NAME, "-C", cwd, "--", ...argv], {
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 60_000,
      });
      return { ok: true, output };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string; status?: number; signal?: string };
      return {
        ok: false,
        output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""} (status=${err.status ?? "?"}, signal=${err.signal ?? "?"})`,
      };
    }
  }

  function setup(preset: "read-project" | "edit-project") {
    // Deliberately under the home directory, not tmpdir: temp paths are allowlisted by these
    // profiles, so a canary placed in /tmp is readable no matter what and proves nothing.
    const root = mkdtempSync(join(homedir(), ".aicoo-sandbox-test-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const granted = join(root, "granted");
    const outside = join(root, "outside");
    mkdirSync(granted);
    mkdirSync(outside);
    writeFileSync(join(granted, "readme.txt"), "IN-SCOPE-FILE\n");
    writeFileSync(join(outside, "secret.txt"), "CANARY-SHOULD-NOT-LEAK\n");
    const prepared = writeCodexPermissionProfile(join(root, "codexhome"), { preset, folders: [granted] })!;
    return { granted, outside, codexHome: prepared.codexHome, environment: prepared.environment };
  }

  it("read-project reads inside the grant and nothing outside it", () => {
    const { granted, outside, codexHome } = setup("read-project");

    const inside = probe(codexHome, granted, ["cat", join(granted, "readme.txt")]);
    expect(inside.ok, `in-scope read should be allowed: ${inside.output}`).toBe(true);
    expect(inside.output).toContain("IN-SCOPE-FILE");

    const escape = probe(codexHome, granted, ["cat", join(outside, "secret.txt")]);
    expect(escape.ok, "out-of-scope read must be refused by the kernel").toBe(false);
    expect(escape.output).not.toContain("CANARY-SHOULD-NOT-LEAK");

    const ssh = probe(codexHome, granted, ["ls", join(homedir(), ".ssh")]);
    expect(ssh.ok, "credential directories must be refused").toBe(false);

    const write = probe(codexHome, granted, ["sh", "-c", `echo x > ${join(granted, "w.txt")}`]);
    expect(write.ok, "read-project must not be able to write").toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("lets Apple Git reach its selected developer toolchain", () => {
    const { granted, codexHome, environment } = setup("read-project");

    const git = (() => {
      try {
        const output = execFileSync("codex", ["sandbox", "-P", CODEX_PROFILE_NAME, "-C", granted, "--", "/usr/bin/git", "--version"], {
          env: { ...process.env, ...environment, CODEX_HOME: codexHome },
          encoding: "utf8",
          stdio: "pipe",
          timeout: 60_000,
        });
        return { ok: true, output };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string };
        return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    })();
    expect(git.ok, `Apple Git should work inside the scoped sandbox: ${git.output}`).toBe(true);
    expect(git.output).toContain("git version");
  });

  it("lets an installed npm launcher reach its canonical runtime", () => {
    // Regression: Homebrew's /opt/homebrew/bin/npm launcher was readable, but its canonical
    // npm-cli.js target was outside the profile, so approved project scripts failed with EPERM.
    const { granted, codexHome } = setup("read-project");

    const npm = probe(codexHome, granted, ["npm", "--version"]);
    expect(npm.ok, `npm should run inside the scoped sandbox: ${npm.output}`).toBe(true);
    expect(npm.output.trim()).toMatch(/^\d+\.\d+/u);
  });

  it("edit-project writes inside the grant, but never outside it and never to the network", () => {
    const { granted, outside, codexHome } = setup("edit-project");

    const write = probe(codexHome, granted, ["sh", "-c", `echo hi > ${join(granted, "w.txt")} && cat ${join(granted, "w.txt")}`]);
    expect(write.ok, `in-scope write should be allowed: ${write.output}`).toBe(true);
    expect(write.output).toContain("hi");

    const escape = probe(codexHome, granted, ["sh", "-c", `echo pwn > ${join(outside, "pwn.txt")}`]);
    expect(escape.ok, "out-of-scope write must be refused").toBe(false);

    const read = probe(codexHome, granted, ["cat", join(outside, "secret.txt")]);
    expect(read.ok, "out-of-scope read must be refused even when writes are granted").toBe(false);

    // The point of the whole design: real work is possible, exfiltration is not.
    const command = probe(codexHome, granted, ["sh", "-c", "ls"]);
    expect(command.ok, "running commands in the grant is the capability that makes a2a useful").toBe(true);

    const network = probe(codexHome, granted, ["curl", "-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"]);
    expect(network.ok && /^[23]\d\d$/.test(network.output.trim()), "network egress must be refused").toBe(false);
  });

  it("accepts the generated remote MCP policy as valid Codex configuration", () => {
    const root = mkdtempSync(join(homedir(), ".aicoo-mcp-config-test-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const granted = join(root, "granted");
    mkdirSync(granted);
    const prepared = writeCodexPermissionProfile(join(root, "codexhome"), {
      preset: "read-project",
      folders: [granted],
      mcpServers: [{
        name: "local_docs",
        url: "http://127.0.0.1:43177/mcp",
        enabledTools: ["read", "search"],
      }],
    })!;

    const result = probe(prepared.codexHome, granted, ["true"]);
    expect(result.ok, `Codex rejected the generated MCP profile: ${result.output}`).toBe(true);
  });
});

describe("codex argv", () => {
  const base = { prompt: "hi", cwd: "/srv/project" };

  it("never combines a permission profile with --ignore-user-config", async () => {
    const { buildArgs } = await import("../../src/adapters/codex/driver.js");
    // --ignore-user-config means "do not load $CODEX_HOME/config.toml" — the file the profile is
    // written to. Shipping both would run with no profile and no error, i.e. unscoped.
    const args = buildArgs({
      ...base,
      permissionProfile: { codexHome: "/tmp/home", profileName: CODEX_PROFILE_NAME },
    });
    expect(args).toContain("-c");
    expect(args).toContain(`permission_profile=${JSON.stringify(CODEX_PROFILE_NAME)}`);
    expect(args).not.toContain("--ignore-user-config");
    // The profile pins read, write and network, so the coarse sandbox_mode flags must not also
    // be present — they grant root-level read and would widen what the profile just narrowed.
    expect(args.join(" ")).not.toContain("sandbox_mode");
  });

  it("keeps the old flags when there is no profile", async () => {
    const { buildArgs } = await import("../../src/adapters/codex/driver.js");
    const args = buildArgs(base);
    expect(args).toContain("--ignore-user-config");
    expect(args.join(" ")).toContain('sandbox_mode="read-only"');
    expect(args.join(" ")).not.toContain("permission_profile=");
  });
});
