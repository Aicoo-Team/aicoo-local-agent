import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getCredentialsFile,
  loadSavedToken,
  saveSavedCredentials,
} from "../../src/cli/credentials.js";

function makeHome(): string {
  const homeDirectory = mkdtempSync(join(tmpdir(), "ccd-credentials-"));
  mkdirSync(join(homeDirectory, ".aicoo"));
  return homeDirectory;
}

describe("local-agent credential storage", () => {
  it("stores default-spool credentials inside the local-agent directory", () => {
    const homeDirectory = makeHome();
    const expectedFile = join(homeDirectory, ".aicoo", "local-agent", "credentials.json");

    expect(getCredentialsFile(undefined, { homeDirectory })).toBe(expectedFile);
    expect(getCredentialsFile(
      join(homeDirectory, ".aicoo", "local-agent", "bridge.spool"),
      { homeDirectory },
    )).toBe(expectedFile);
  });

  it("migrates legacy local-agent credentials without deleting the shared file", () => {
    const homeDirectory = makeHome();
    const warn = vi.fn();
    const aicooDirectory = join(homeDirectory, ".aicoo");
    const legacyFile = join(aicooDirectory, "credentials.json");
    const legacyCredentials = {
      token: "aicoo_dev_legacy",
      userId: "user-1",
      deviceId: "device-1",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    writeFileSync(legacyFile, JSON.stringify(legacyCredentials), { mode: 0o600 });

    expect(loadSavedToken(undefined, { homeDirectory, warn })).toBe("aicoo_dev_legacy");
    expect(JSON.parse(readFileSync(legacyFile, "utf8"))).toEqual(legacyCredentials);

    const migratedFile = join(aicooDirectory, "local-agent", "credentials.json");
    expect(JSON.parse(readFileSync(migratedFile, "utf8"))).toMatchObject({
      token: "aicoo_dev_legacy",
      userId: "user-1",
      deviceId: "device-1",
    });
    expect(statSync(migratedFile).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Migrated local-agent credentials"));
  });

  it("ignores Skills OAuth credentials at the legacy shared path", () => {
    const homeDirectory = makeHome();
    const warn = vi.fn();
    const legacyFile = join(homeDirectory, ".aicoo", "credentials.json");
    const oauthCredentials = {
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      client_id: "aicoo-skills",
      expires_at: 4_102_444_800_000,
    };
    writeFileSync(legacyFile, JSON.stringify(oauthCredentials), { mode: 0o600 });

    expect(loadSavedToken(undefined, { homeDirectory, warn })).toBeUndefined();
    expect(JSON.parse(readFileSync(legacyFile, "utf8"))).toEqual(oauthCredentials);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("owned by another Aicoo component"));
  });

  it("never overwrites Skills OAuth credentials when saving the default spool", () => {
    const homeDirectory = makeHome();
    const legacyFile = join(homeDirectory, ".aicoo", "credentials.json");
    const oauthCredentials = {
      access_token: "oauth-access",
      refresh_token: "oauth-refresh",
      client_id: "aicoo-skills",
      expires_at: 4_102_444_800_000,
    };
    writeFileSync(legacyFile, JSON.stringify(oauthCredentials), { mode: 0o600 });

    saveSavedCredentials(
      { token: "aicoo_dev_new", userId: "user-1", deviceId: "device-1" },
      undefined,
      { homeDirectory },
    );

    expect(JSON.parse(readFileSync(legacyFile, "utf8"))).toEqual(oauthCredentials);
    expect(JSON.parse(readFileSync(
      join(homeDirectory, ".aicoo", "local-agent", "credentials.json"),
      "utf8",
    ))).toMatchObject({ token: "aicoo_dev_new" });
  });

  it("keeps custom-spool credential paths unchanged", () => {
    const homeDirectory = makeHome();
    const spoolFile = join(homeDirectory, "custom", "bridge.spool");

    expect(getCredentialsFile(spoolFile, { homeDirectory })).toBe(
      `${spoolFile}.credentials.json`,
    );
  });
});
