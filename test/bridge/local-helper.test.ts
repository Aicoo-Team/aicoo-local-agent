import { describe, expect, it } from "vitest";
import { createLocalHelperApp, startLocalHelper, type NativePicker } from "../../src/bridge/local-helper.js";

describe("local folder/file picker helper", () => {
  it("returns a selected folder path without local-agent identifiers", async () => {
    const app = createLocalHelperApp(picker({ ok: true, path: "/tmp/aicoo-demo" }));

    const response = await app.request("/local-agent/choose-folder", {
      method: "POST",
      headers: { origin: "https://www.aicoo.io" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://www.aicoo.io");
    const body = await response.json();
    expect(body).toEqual({ folderPath: "/tmp/aicoo-demo" });
    expect(JSON.stringify(body)).not.toMatch(/token|device|endpoint|session/i);
  });

  it("returns a selected file path", async () => {
    const app = createLocalHelperApp(picker({ ok: true, path: "/tmp/aicoo-demo/notes.md" }));

    const response = await app.request("/local-agent/choose-file", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ filePath: "/tmp/aicoo-demo/notes.md" });
  });

  it("returns cancelled as a non-500 response", async () => {
    const app = createLocalHelperApp(picker({
      ok: false,
      error: "cancelled",
      message: "Folder selection was cancelled.",
    }));

    const response = await app.request("/local-agent/choose-folder", { method: "POST" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "cancelled",
      message: "Folder selection was cancelled.",
    });
  });

  it("returns picker_unavailable as a non-500 response", async () => {
    const app = createLocalHelperApp(picker({
      ok: false,
      error: "picker_unavailable",
      message: "Folder picker is unavailable. Paste the folder path manually.",
    }));

    const response = await app.request("/local-agent/choose-folder", { method: "POST" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "picker_unavailable",
      message: "Folder picker is unavailable. Paste the folder path manually.",
    });
  });

  it("allows only Aicoo web origins for CORS", async () => {
    const app = createLocalHelperApp(picker({ ok: true, path: "/tmp/aicoo-demo" }));

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

  it("allows configured extra web origins for CORS", async () => {
    process.env.CCD_LOCAL_HELPER_ORIGINS = "https://preview.example";
    const app = createLocalHelperApp(picker({ ok: true, path: "/tmp/aicoo-demo" }));

    const allowed = await app.request("/local-agent/choose-folder", {
      method: "OPTIONS",
      headers: { origin: "https://preview.example" },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://preview.example");
    delete process.env.CCD_LOCAL_HELPER_ORIGINS;
  });

  it("rejects non-localhost binding", () => {
    expect(() => startLocalHelper({ hostname: "0.0.0.0", port: 0 })).toThrow("127.0.0.1");
  });
});

function picker(result: Awaited<ReturnType<NativePicker["chooseFolder"]>>): NativePicker {
  return {
    chooseFolder: async () => result,
    chooseFile: async () => result,
  };
}
