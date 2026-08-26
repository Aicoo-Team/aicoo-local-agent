import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const execFileAsync = promisify(execFile);

const APPLE_FOLDER_SCRIPT = [
  "POSIX path of (choose folder with prompt \"Choose a folder to share with the peer local agent\")",
];
const APPLE_FILE_SCRIPT = [
  "POSIX path of (choose file with prompt \"Choose a file to share with the peer local agent\")",
];
const WINDOWS_FOLDER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $dialog.Description = 'Choose a folder to share with the peer local agent'
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  }
} finally {
  $dialog.Dispose()
}
`.trim();
const WINDOWS_FILE_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
try {
  $dialog.Title = 'Choose a file to share with the peer local agent'
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.FileName)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  }
} finally {
  $dialog.Dispose()
}
`.trim();
const FOLDER_PICKER_TITLE = "Choose a folder to share with the peer local agent";
const FILE_PICKER_TITLE = "Choose a file to share with the peer local agent";

const ALLOWED_ORIGINS = new Set([
  "https://www.aicoo.io",
  "https://www.yourcoo.ai",
  "http://localhost:3000",
]);

export type PickerResult =
  | { ok: true; path: string }
  | { ok: false; error: "cancelled" | "picker_unavailable"; message: string };

export interface NativePicker {
  chooseFolder(): Promise<PickerResult>;
  chooseFile(): Promise<PickerResult>;
}

export interface NativePickerDependencies {
  getPlatform?: () => NodeJS.Platform;
  runCommand?: CommandRunner;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

export interface LocalHelperOptions {
  hostname?: string;
  port?: number;
  picker?: NativePicker;
  log?: (line: string) => void;
}

export function createLocalHelperApp(picker: NativePicker = new DefaultNativePicker()) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type");
      c.header("Access-Control-Max-Age", "600");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, origin && ALLOWED_ORIGINS.has(origin) ? 204 : 403);
    }
    await next();
  });

  app.post("/local-agent/choose-folder", async (c) => {
    const result = await picker.chooseFolder();
    if (result.ok) return c.json({ folderPath: result.path });
    return c.json({ error: result.error, message: result.message }, result.error === "cancelled" ? 400 : 503);
  });

  app.post("/local-agent/choose-file", async (c) => {
    const result = await picker.chooseFile();
    if (result.ok) return c.json({ filePath: result.path });
    return c.json({ error: result.error, message: result.message }, result.error === "cancelled" ? 400 : 503);
  });

  return app;
}

export function startLocalHelper(options: LocalHelperOptions = {}): Server | undefined {
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") {
    throw new Error("Local Agent helper must bind to 127.0.0.1");
  }

  const app = createLocalHelperApp(options.picker);
  const server = serve({
    fetch: app.fetch,
    hostname,
    port: options.port ?? 43177,
  }) as Server;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      options.log?.(`[local-helper] 127.0.0.1:${options.port ?? 43177} already in use; folder picker helper not started here`);
      return;
    }
    options.log?.(`[local-helper] failed: ${String(error)}`);
  });

  return server;
}

export class DefaultNativePicker implements NativePicker {
  private readonly getPlatform: () => NodeJS.Platform;
  private readonly runCommand: CommandRunner;

  constructor(dependencies: NativePickerDependencies = {}) {
    this.getPlatform = dependencies.getPlatform ?? platform;
    this.runCommand = dependencies.runCommand ?? runCommand;
  }

  async chooseFolder(): Promise<PickerResult> {
    const currentPlatform = this.getPlatform();
    if (currentPlatform === "darwin") return runAppleScriptPicker(APPLE_FOLDER_SCRIPT, this.runCommand);
    if (currentPlatform === "win32") return runPowerShellPicker(WINDOWS_FOLDER_SCRIPT, this.runCommand);
    if (currentPlatform === "linux") return runLinuxPicker("folder", this.runCommand);
    return pickerUnavailable();
  }

  async chooseFile(): Promise<PickerResult> {
    const currentPlatform = this.getPlatform();
    if (currentPlatform === "darwin") return runAppleScriptPicker(APPLE_FILE_SCRIPT, this.runCommand);
    if (currentPlatform === "win32") return runPowerShellPicker(WINDOWS_FILE_SCRIPT, this.runCommand);
    if (currentPlatform === "linux") return runLinuxPicker("file", this.runCommand);
    return pickerUnavailable();
  }
}

async function runCommand(file: string, args: readonly string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout };
}

async function runAppleScriptPicker(script: string[], runner: CommandRunner): Promise<PickerResult> {
  try {
    const { stdout } = await runner("osascript", script.flatMap((line) => ["-e", line]));
    const selected = stripTrailingLineEnding(stdout);
    if (!selected) {
      return pickerCancelled();
    }
    return { ok: true, path: selected };
  } catch (error) {
    const maybe = error as { code?: number | string; stderr?: string; message?: string };
    const text = `${maybe.stderr ?? ""}\n${maybe.message ?? ""}`;
    if (maybe.code === 1 && (text.includes("-128") || text.toLowerCase().includes("user canceled"))) {
      return pickerCancelled();
    }
    return pickerUnavailable();
  }
}

async function runPowerShellPicker(script: string, runner: CommandRunner): Promise<PickerResult> {
  const args = ["-NoProfile", "-STA", "-Command", script] as const;

  for (const executable of ["powershell.exe", "pwsh.exe"] as const) {
    try {
      const { stdout } = await runner(executable, args);
      if (!stdout) return pickerCancelled();
      const selected = decodePowerShellPath(stdout);
      if (selected === undefined) return pickerUnavailable();
      return { ok: true, path: selected };
    } catch (error) {
      if (executable === "powershell.exe" && isCommandMissing(error)) continue;
      return pickerUnavailable();
    }
  }

  return pickerUnavailable();
}

async function runLinuxPicker(kind: "folder" | "file", runner: CommandRunner): Promise<PickerResult> {
  const title = kind === "folder" ? FOLDER_PICKER_TITLE : FILE_PICKER_TITLE;
  const candidates: ReadonlyArray<{ file: string; args: readonly string[] }> = [
    {
      file: "zenity",
      args: [
        "--file-selection",
        ...(kind === "folder" ? ["--directory"] : []),
        `--title=${title}`,
      ],
    },
    {
      file: "kdialog",
      args: kind === "folder"
        ? ["--getexistingdirectory", ".", "--title", title]
        : ["--getopenfilename", ".", "*", "--title", title],
    },
  ];

  for (const candidate of candidates) {
    try {
      const { stdout } = await runner(candidate.file, candidate.args);
      const selected = stripTrailingLineEnding(stdout);
      return selected ? { ok: true, path: selected } : pickerCancelled();
    } catch (error) {
      if (isCommandMissing(error) || isLinuxDisplayUnavailable(error)) continue;
      if (isDialogCancellation(error)) return pickerCancelled();
      return pickerUnavailable();
    }
  }

  return pickerUnavailable();
}

function stripTrailingLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function decodePowerShellPath(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  return Buffer.from(value, "base64").toString("utf8");
}

function isCommandMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDialogCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 1;
}

function isLinuxDisplayUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybe = error as { stderr?: string; message?: string };
  const text = `${maybe.stderr ?? ""}\n${maybe.message ?? ""}`.toLowerCase();
  return [
    "cannot open display",
    "cannot connect to display",
    "could not connect to display",
    "no display",
    "qt.qpa.xcb",
  ].some((marker) => text.includes(marker));
}

function pickerCancelled(): PickerResult {
  return { ok: false, error: "cancelled", message: "Folder selection was cancelled." };
}

function pickerUnavailable(): PickerResult {
  return {
    ok: false,
    error: "picker_unavailable",
    message: "Folder picker is unavailable. Paste the folder path manually.",
  };
}
