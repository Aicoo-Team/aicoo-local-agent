import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SavedCredentials {
  token: string;
  userId?: string;
  deviceId?: string;
}

export interface CredentialStoreOptions {
  homeDirectory?: string;
  warn?: (message: string) => void;
}

interface StoredLocalAgentCredentials {
  token?: string;
  deviceToken?: string;
  userId?: string;
  deviceId?: string;
}

function defaultSpool(homeDirectory: string): string {
  return join(homeDirectory, ".aicoo", "local-agent", "bridge.spool");
}

function isDefaultSpool(spoolFile: string | undefined, homeDirectory: string): boolean {
  return !spoolFile || spoolFile === defaultSpool(homeDirectory);
}

function legacyCredentialsFile(homeDirectory: string): string {
  return join(homeDirectory, ".aicoo", "credentials.json");
}

function migratedLegacyCredentialsFile(homeDirectory: string): string {
  return join(homeDirectory, ".aicoo", "credentials.localagent.migrated.json");
}

function readStoredCredentials(file: string): unknown | undefined {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    /* unreadable credentials file */
  }
  return undefined;
}

function localAgentToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const credentials = value as StoredLocalAgentCredentials;
  if (typeof credentials.token === "string" && credentials.token.length > 0) return credentials.token;
  if (typeof credentials.deviceToken === "string" && credentials.deviceToken.length > 0) {
    return credentials.deviceToken;
  }
  return undefined;
}

function legacyLocalAgentToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const credentials = value as Record<string, unknown>;
  if (typeof credentials.access_token === "string" || typeof credentials.refresh_token === "string") {
    return undefined;
  }
  // Every credential written by the legacy local-agent included updatedAt.
  // Require that marker before destructively moving a file from the shared path.
  if (typeof credentials.updatedAt !== "string") return undefined;
  return localAgentToken(value);
}

function warn(options: CredentialStoreOptions, message: string): void {
  (options.warn ?? console.warn)(message);
}

function archiveLegacyLocalAgentCredentials(
  legacyFile: string,
  legacy: unknown,
  homeDirectory: string,
  options: CredentialStoreOptions,
): string | undefined {
  // Compare the complete parsed credential, not only its token, before moving
  // the shared path aside. An OAuth login may have replaced it meanwhile.
  const currentLegacy = readStoredCredentials(legacyFile);
  if (
    !legacyLocalAgentToken(currentLegacy)
    || JSON.stringify(currentLegacy) !== JSON.stringify(legacy)
  ) {
    warn(options, `Left ${legacyFile} untouched because it changed before it could be archived.`);
    return undefined;
  }

  const preferredArchive = migratedLegacyCredentialsFile(homeDirectory);
  const archiveFile = existsSync(preferredArchive)
    ? `${preferredArchive}.${randomUUID()}`
    : preferredArchive;
  try {
    renameSync(legacyFile, archiveFile);
    return archiveFile;
  } catch (error) {
    warn(options, `Could not archive legacy local-agent credentials at ${legacyFile}: ${String(error)}`);
    return undefined;
  }
}

export function getCredentialsFile(
  spoolFile?: string,
  options: CredentialStoreOptions = {},
): string {
  const homeDirectory = options.homeDirectory ?? homedir();
  if (isDefaultSpool(spoolFile, homeDirectory)) {
    return join(homeDirectory, ".aicoo", "local-agent", "credentials.json");
  }
  return `${spoolFile}.credentials.json`;
}

export function loadSavedToken(
  spoolFile?: string,
  options: CredentialStoreOptions = {},
): string | undefined {
  const homeDirectory = options.homeDirectory ?? homedir();
  const file = getCredentialsFile(spoolFile, options);
  const stored = readStoredCredentials(file);
  const token = localAgentToken(stored);
  if (token) {
    if (isDefaultSpool(spoolFile, homeDirectory)) {
      const legacyFile = legacyCredentialsFile(homeDirectory);
      const legacy = readStoredCredentials(legacyFile);
      if (legacyLocalAgentToken(legacy)) {
        const archiveFile = archiveLegacyLocalAgentCredentials(
          legacyFile,
          legacy,
          homeDirectory,
          options,
        );
        if (archiveFile) {
          warn(options, `Archived orphaned local-agent credentials from ${legacyFile} at ${archiveFile}.`);
        }
      }
    }
    return token;
  }
  if (stored !== undefined) {
    warn(options, `Ignoring credentials at ${file}: not a local-agent credential.`);
  }

  if (!isDefaultSpool(spoolFile, homeDirectory)) return undefined;

  const legacyFile = legacyCredentialsFile(homeDirectory);
  const legacy = readStoredCredentials(legacyFile);
  const legacyToken = legacyLocalAgentToken(legacy);
  if (!legacyToken) {
    if (legacy !== undefined) {
      warn(options, `Ignoring credentials at ${legacyFile}: owned by another Aicoo component.`);
    }
    return undefined;
  }

  const legacyCredentials = legacy as StoredLocalAgentCredentials;
  saveSavedCredentials(
    {
      token: legacyToken,
      ...(typeof legacyCredentials.userId === "string" ? { userId: legacyCredentials.userId } : {}),
      ...(typeof legacyCredentials.deviceId === "string" ? { deviceId: legacyCredentials.deviceId } : {}),
    },
    spoolFile,
    options,
  );

  const archiveFile = archiveLegacyLocalAgentCredentials(
    legacyFile,
    legacy,
    homeDirectory,
    options,
  );
  if (archiveFile) {
    warn(options, `Migrated local-agent credentials from ${legacyFile} to ${file}; archived the legacy file at ${archiveFile}.`);
  } else {
    warn(options, `Migrated local-agent credentials to ${file}, but left ${legacyFile} in place.`);
  }
  return legacyToken;
}

export function saveSavedCredentials(
  credentials: SavedCredentials,
  spoolFile?: string,
  options: CredentialStoreOptions = {},
): void {
  const file = getCredentialsFile(spoolFile, options);
  mkdirSync(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporaryFile,
    JSON.stringify({ ...credentials, updatedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  renameSync(temporaryFile, file);
}
