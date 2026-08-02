import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const execFileAsync = promisify(execFile);

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
  async chooseFolder(): Promise<PickerResult> {
    if (platform() !== "darwin") return pickerUnavailable();
    return runAppleScriptPicker([
      "POSIX path of (choose folder with prompt \"Choose a folder to share with the peer local agent\")",
    ]);
  }

  async chooseFile(): Promise<PickerResult> {
    if (platform() !== "darwin") return pickerUnavailable();
    return runAppleScriptPicker([
      "POSIX path of (choose file with prompt \"Choose a file to share with the peer local agent\")",
    ]);
  }
}

async function runAppleScriptPicker(script: string[]): Promise<PickerResult> {
  try {
    const { stdout } = await execFileAsync("osascript", script.flatMap((line) => ["-e", line]), {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const selected = stdout.trim();
    if (!selected) {
      return { ok: false, error: "cancelled", message: "Folder selection was cancelled." };
    }
    return { ok: true, path: selected };
  } catch (error) {
    const maybe = error as { code?: number | string; stderr?: string; message?: string };
    const text = `${maybe.stderr ?? ""}\n${maybe.message ?? ""}`;
    if (maybe.code === 1 && (text.includes("-128") || text.toLowerCase().includes("user canceled"))) {
      return { ok: false, error: "cancelled", message: "Folder selection was cancelled." };
    }
    return pickerUnavailable();
  }
}

function pickerUnavailable(): PickerResult {
  return {
    ok: false,
    error: "picker_unavailable",
    message: "Folder picker is unavailable. Paste the folder path manually.",
  };
}
