import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSafeGit,
  parseSafeGitCommand,
  safeGitOperation,
  safeGitShellInput,
} from "../../src/security/safe-git.js";

describe("safe Git collaboration tools", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("parses only the bounded Git command surface", () => {
    expect(parseSafeGitCommand("git status --short", "/srv/project")).toMatchObject({
      toolName: "GitStatus", repository: "/srv/project",
    });
    expect(parseSafeGitCommand("git diff --staged -- src/app.ts", "/srv/project")).toMatchObject({
      toolName: "GitDiff",
    });
    expect(parseSafeGitCommand("git log --oneline -n 5", "/srv/project")).toMatchObject({
      toolName: "GitLog",
    });
    expect(parseSafeGitCommand("git add -- src/app.ts", "/srv/project")).toMatchObject({
      toolName: "GitAdd",
    });
    expect(parseSafeGitCommand("git commit -m 'safe message'", "/srv/project")).toMatchObject({
      toolName: "GitCommit",
    });
    for (const command of [
      "git reset --hard", "git clean -fd", "git push", "git status; touch /tmp/pwned",
      "git diff | cat", "git -c alias.status='!touch /tmp/pwned' status",
    ]) {
      expect(parseSafeGitCommand(command, "/srv/project"), command).toBeUndefined();
    }
  });

  it("executes status, diff, add, and commit without invoking hooks or global config", () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "notes.txt"), "changed\n", "utf8");

    const status = safeGitOperation({ toolName: "GitStatus", repository });
    const diff = safeGitOperation({ toolName: "GitDiff", repository });
    const add = safeGitOperation({ toolName: "GitAdd", repository, paths: ["notes.txt"] });
    const commit = safeGitOperation({ toolName: "GitCommit", repository, message: "update notes" });
    expect(status && executeSafeGit(status)).toContain("notes.txt");
    expect(diff && executeSafeGit(diff)).toContain("changed");
    expect(add && executeSafeGit(add)).toBe("");
    expect(commit && executeSafeGit(commit)).toContain("update notes");
  });

  it("rejects Git pathspecs outside the approved repository", () => {
    const repository = makeRepository();
    expect(safeGitOperation({ toolName: "GitAdd", repository, paths: ["../secret.txt"] })).toBeUndefined();
    expect(safeGitOperation({ toolName: "GitDiff", repository, paths: ["/etc/passwd"] })).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("rewrites Claude GitAdd without clean filters or raw git add", () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "notes.txt"), "shell staged\n", "utf8");
    const operation = safeGitOperation({ toolName: "GitAdd", repository, paths: ["notes.txt"] });
    expect(operation).toBeDefined();
    const input = safeGitShellInput(operation!);
    expect(input.command).toContain("hash-object");
    expect(input.command).toContain("update-index");
    expect(input.command).not.toContain("'add'");

    execFileSync("/bin/sh", ["-c", String(input.command)]);
    expect(execFileSync("git", ["-C", repository, "diff", "--staged"], { encoding: "utf8" }))
      .toContain("shell staged");
  });

  it("renders every Windows Claude Git command for Git Bash with native Git isolation", () => {
    const repository = makeRepository();
    const operations = [
      safeGitOperation({ toolName: "GitStatus", repository }),
      safeGitOperation({ toolName: "GitDiff", repository }),
      safeGitOperation({ toolName: "GitLog", repository }),
      safeGitOperation({ toolName: "GitAdd", repository, paths: ["notes.txt"] }),
      safeGitOperation({ toolName: "GitCommit", repository, message: "windows test" }),
    ];

    for (const operation of operations) {
      expect(operation).toBeDefined();
      const input = safeGitShellInput(operation!, "win32");
      expect(input.command).toContain("GIT_CONFIG_NOSYSTEM='1'");
      expect(input.command).toContain("GIT_CONFIG_GLOBAL='NUL'");
      expect(input.command).toContain("GIT_TERMINAL_PROMPT='0'");
      expect(input.command).toContain("core.hooksPath=NUL");
      expect(input.command).not.toContain("/dev/null");
    }

    const add = safeGitShellInput(operations[3]!, "win32");
    expect(add.command).toContain("hash-object");
    expect(add.command).toContain("update-index");
  });

  function makeRepository(): string {
    const directory = mkdtempSync(join(tmpdir(), "ccd-safe-git-"));
    directories.push(directory);
    const repository = join(directory, "repo");
    mkdirSync(repository);
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Aicoo Test"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@aicoo.local"]);
    writeFileSync(join(repository, "notes.txt"), "initial\n", "utf8");
    execFileSync("git", ["-C", repository, "add", "notes.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    return repository;
  }
});
