import { describe, expect, it } from "vitest";
import { buildCodexSpawnCommand, requiresWindowsShell } from "../../src/adapters/codex/driver.js";
import { executableNames } from "../../src/adapters/select-adapter.js";

describe("Windows runtime executable handling", () => {
  it("does not select the extensionless POSIX shim on Windows", () => {
    expect(executableNames("codex", "win32", ".EXE;.CMD;.BAT")).toEqual([
      "codex.exe",
      "codex.cmd",
      "codex.bat",
    ]);
  });

  it("honors supported PATHEXT ordering and adds missing fallbacks", () => {
    expect(executableNames("codex", "win32", ".CMD;.EXE")).toEqual([
      "codex.cmd",
      "codex.exe",
      "codex.bat",
    ]);
  });

  it("keeps POSIX executable discovery unchanged", () => {
    expect(executableNames("codex", "darwin")).toEqual(["codex"]);
    expect(executableNames("codex", "linux")).toEqual(["codex"]);
  });

  it("uses a shell only for Windows command shims", () => {
    expect(requiresWindowsShell("C:\\npm\\codex.cmd", "win32")).toBe(true);
    expect(requiresWindowsShell("C:\\npm\\codex.BAT", "win32")).toBe(true);
    expect(requiresWindowsShell("C:\\bin\\codex.exe", "win32")).toBe(false);
    expect(requiresWindowsShell("/usr/local/bin/codex.cmd", "darwin")).toBe(false);
  });

  it("launches Windows command shims through ComSpec without shell:true argv joining", () => {
    const args = [
      "exec",
      "resume",
      "thread & echo injected",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "-C",
      "C:\\Users\\Jo Smith\\proj",
      "-",
    ];

    expect(buildCodexSpawnCommand("C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\codex.cmd", args, "win32", {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\codex.cmd",
        ...args,
      ],
    });
  });

  it("keeps native executables and POSIX launchers on the direct spawn path", () => {
    const args = ["exec", "--json", "-"];

    expect(buildCodexSpawnCommand("C:\\bin\\codex.exe", args, "win32")).toEqual({
      command: "C:\\bin\\codex.exe",
      args,
    });
    expect(buildCodexSpawnCommand("/usr/local/bin/codex.cmd", args, "darwin")).toEqual({
      command: "/usr/local/bin/codex.cmd",
      args,
    });
  });
});
