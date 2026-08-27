import { describe, expect, it, vi } from "vitest";
import {
  createLocalHelperApp,
  DefaultNativePicker,
  startLocalHelper,
  type CommandRunner,
  type NativePicker,
} from "../local-helper.js";

describe("native local folder/file picker", () => {
  // Regression: Windows previously fell through to picker_unavailable instead of opening a folder dialog.
  it("uses the Windows folder picker on win32", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => encodedOutput("C:\\work"));
    const picker = windowsPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "C:\\work" });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(runCommand.mock.calls[0]?.[1].slice(0, 3)).toEqual(["-NoProfile", "-STA", "-Command"]);
    expect(runCommand.mock.calls[0]?.[1][3]).toContain("System.Windows.Forms.FolderBrowserDialog");
  });

  // Regression: Windows file selection must use OpenFileDialog, not the folder dialog.
  it("uses the Windows file picker on win32", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => encodedOutput("C:\\work\\notes.md"));
    const picker = windowsPicker(runCommand);

    await expect(picker.chooseFile()).resolves.toEqual({ ok: true, path: "C:\\work\\notes.md" });
    expect(runCommand.mock.calls[0]?.[1][3]).toContain("System.Windows.Forms.OpenFileDialog");
  });

  // Regression: trimming or escaping command output used to risk changing drive-letter paths containing spaces.
  it("returns a Windows path with a drive letter and spaces unchanged", async () => {
    const selected = "C:\\Users\\Example User\\Project";
    const picker = windowsPicker(async () => encodedOutput(selected));

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: selected });
  });

  // Regression: shell interpolation can corrupt Unicode and apostrophes in selected paths.
  it("preserves Unicode and apostrophes in Windows paths", async () => {
    const selected = "D:\\团队\\O'Brien's Project\\résumé.md";
    const picker = windowsPicker(async () => encodedOutput(selected));

    await expect(picker.chooseFile()).resolves.toEqual({ ok: true, path: selected });
  });

  // Regression: dismissing a Windows dialog must be reported as cancellation, not an execution failure.
  it("reports an empty Windows dialog result as cancelled", async () => {
    const picker = windowsPicker(async () => ({ stdout: "" }));

    await expect(picker.chooseFolder()).resolves.toEqual({
      ok: false,
      error: "cancelled",
      message: "Folder selection was cancelled.",
    });
  });

  // Regression: installations without Windows PowerShell should safely fall back to PowerShell Core.
  it("falls back to pwsh.exe when powershell.exe is missing", async () => {
    const runCommand = vi.fn<CommandRunner>(async (file) => {
      if (file === "powershell.exe") throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return encodedOutput("C:\\fallback");
    });
    const picker = windowsPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "C:\\fallback" });
    expect(runCommand.mock.calls.map(([file]) => file)).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  // Regression: a machine with neither PowerShell executable must return the stable unavailable response.
  it("returns picker_unavailable when PowerShell is missing", async () => {
    const picker = windowsPicker(async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    await expect(picker.chooseFolder()).resolves.toEqual(unavailableResult());
  });

  // Regression: dialog startup failures must not leak process errors or be mistaken for cancellation.
  it("returns picker_unavailable when PowerShell fails", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => {
      throw Object.assign(new Error("dialog failed"), { code: 1 });
    });
    const picker = windowsPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual(unavailableResult());
    expect(runCommand).toHaveBeenCalledOnce();
  });

  // Regression: adding Windows dispatch must not replace the established macOS osascript picker.
  it("continues to use osascript on macOS", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => ({ stdout: "/Users/example/Project\n" }));
    const picker = new DefaultNativePicker({ getPlatform: () => "darwin", runCommand });

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "/Users/example/Project" });
    expect(runCommand.mock.calls[0]?.[0]).toBe("osascript");
  });

  // Regression: Ubuntu previously fell through to picker_unavailable without trying its native dialog.
  it("uses zenity for Linux folder and file selection", async () => {
    const runCommand = vi.fn<CommandRunner>(async (_file, args) => ({
      stdout: args.includes("--directory") ? "/home/alice/Project\n" : "/home/alice/Project/notes.md\n",
    }));
    const picker = linuxPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "/home/alice/Project" });
    await expect(picker.chooseFile()).resolves.toEqual({ ok: true, path: "/home/alice/Project/notes.md" });
    expect(runCommand.mock.calls[0]).toEqual([
      "zenity",
      ["--file-selection", "--directory", "--title=Choose a folder to share with the peer local agent"],
    ]);
    expect(runCommand.mock.calls[1]).toEqual([
      "zenity",
      ["--file-selection", "--title=Choose a file to share with the peer local agent"],
    ]);
  });

  // Regression: KDE systems commonly have kdialog but not zenity.
  it("falls back to kdialog when zenity is missing", async () => {
    const runCommand = vi.fn<CommandRunner>(async (file) => {
      if (file === "zenity") throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return { stdout: "/home/alice/KDE Project\n" };
    });
    const picker = linuxPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "/home/alice/KDE Project" });
    expect(runCommand.mock.calls.map(([file]) => file)).toEqual(["zenity", "kdialog"]);
    expect(runCommand.mock.calls[1]?.[1]).toEqual([
      "--getexistingdirectory", ".", "--title", "Choose a folder to share with the peer local agent",
    ]);
  });

  // Regression: zenity may be installed on a headless or KDE session but unable to open a display.
  it("falls back to kdialog when zenity cannot open the display", async () => {
    const runCommand = vi.fn<CommandRunner>(async (file) => {
      if (file === "zenity") {
        throw Object.assign(new Error("zenity failed"), {
          code: 1,
          stderr: "Gtk-WARNING **: cannot open display",
        });
      }
      return { stdout: "/home/alice/KDE Project\n" };
    });
    const picker = linuxPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({ ok: true, path: "/home/alice/KDE Project" });
    expect(runCommand.mock.calls.map(([file]) => file)).toEqual(["zenity", "kdialog"]);
  });

  // Regression: closing a Linux dialog is a user cancellation, not a missing picker.
  it("reports Linux dialog cancellation without trying another UI", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => {
      throw Object.assign(new Error("cancelled"), { code: 1 });
    });
    const picker = linuxPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual({
      ok: false,
      error: "cancelled",
      message: "Folder selection was cancelled.",
    });
    expect(runCommand).toHaveBeenCalledOnce();
  });

  // Regression: Linux paths may contain spaces, apostrophes, and non-ASCII characters.
  it("preserves Linux Unicode paths exactly", async () => {
    const selected = "/home/alice/团队/O'Brien's Project/résumé.md";
    const picker = linuxPicker(async () => ({ stdout: `${selected}\n` }));

    await expect(picker.chooseFile()).resolves.toEqual({ ok: true, path: selected });
  });

  // Regression: headless Linux and minimal servers must keep the manual-path fallback.
  it("returns picker_unavailable when Linux GUI pickers are missing", async () => {
    const runCommand = vi.fn<CommandRunner>(async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const picker = linuxPicker(runCommand);

    await expect(picker.chooseFolder()).resolves.toEqual(unavailableResult());
    expect(runCommand.mock.calls.map(([file]) => file)).toEqual(["zenity", "kdialog"]);
  });

  it("keeps unsupported platforms on the manual-path fallback", async () => {
    const runCommand = vi.fn<CommandRunner>();
    const picker = new DefaultNativePicker({ getPlatform: () => "freebsd", runCommand });

    await expect(picker.chooseFolder()).resolves.toEqual(unavailableResult());
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("local helper security boundaries", () => {
  // Regression: picker support must not broaden the localhost helper's CORS allowlist.
  it("allows configured Aicoo origins and rejects an untrusted preflight", async () => {
    const app = createLocalHelperApp(stubPicker());
    const allowed = await app.request("/local-agent/choose-folder", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    const rejected = await app.request("/local-agent/choose-folder", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  // Regression: native picker support must never permit binding the helper to a non-loopback interface.
  it("retains the 127.0.0.1-only binding guard", () => {
    expect(() => startLocalHelper({ hostname: "0.0.0.0", port: 0 })).toThrow("127.0.0.1");
  });
});

function windowsPicker(runCommand: CommandRunner): DefaultNativePicker {
  return new DefaultNativePicker({ getPlatform: () => "win32", runCommand });
}

function linuxPicker(runCommand: CommandRunner): DefaultNativePicker {
  return new DefaultNativePicker({ getPlatform: () => "linux", runCommand });
}

function encodedOutput(path: string): { stdout: string } {
  return { stdout: Buffer.from(path, "utf8").toString("base64") };
}

function unavailableResult() {
  return {
    ok: false,
    error: "picker_unavailable",
    message: "Folder picker is unavailable. Paste the folder path manually.",
  } as const;
}

function stubPicker(): NativePicker {
  const result = { ok: true, path: "C:\\work" } as const;
  return { chooseFolder: async () => result, chooseFile: async () => result };
}
