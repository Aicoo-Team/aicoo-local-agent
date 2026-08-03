import { globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Last line before a reply leaves the machine.
 *
 * Deliberately not entropy guessing: it collects the actual values assigned in env-shaped
 * files inside the granted folders, and redacts those exact strings. It does not need to
 * recognise what a secret looks like — only that this string is a value from the owner's
 * config and is now on its way out.
 *
 * A sandbox cannot do this. It governs what a process may touch, never what a model may
 * say, and reading an allowed file then quoting it is a perfectly ordinary read.
 */

const ENV_FILE_PATTERN = "**/{.env,.env.*,*.env}";
const MAX_FILE_BYTES = 256 * 1024;
// Short values ("true", "3000", "debug") are not secrets and redacting them would mangle
// ordinary prose — a reply containing the word "development" must not become [redacted].
const MIN_SECRET_LENGTH = 8;
// Length alone is not enough: NODE_ENV=development clears it, and redacting the word
// "development" out of a sentence is a worse failure than not redacting at all. The
// variable *name* is the owner's own labelling of what is sensitive, so trust it.
const SENSITIVE_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE|AUTH|SIGNATURE|SALT|PEPPER|DSN|COOKIE|SESSION)/i;
// …with one shape-based fallback, for the case the name gives nothing away.
const CREDENTIALS_IN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

function looksSensitive(name, value) {
  return SENSITIVE_NAME.test(name) || CREDENTIALS_IN_URL.test(value);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Values assigned in env-shaped files under the granted folders. */
export function collectSecrets(folders, { log } = {}) {
  const secrets = new Map(); // value -> the file it came from
  for (const folder of folders) {
    let matches = [];
    try {
      matches = globSync(ENV_FILE_PATTERN, { cwd: folder, dot: true });
    } catch (error) {
      log?.(`[redact] could not scan ${folder}: ${String(error.message ?? error)}`);
      continue;
    }
    for (const match of matches) {
      // `absolute: true` is not honoured by fs.globSync here — it returns paths relative to
      // `cwd`. Resolving them ourselves is the difference between scanning the files and
      // silently scanning nothing, which is the worst way for a redactor to fail.
      const file = path.resolve(folder, match);
      try {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
          if (!assignment) continue;
          const [, name, rawValue] = assignment;
          const value = unquote(rawValue);
          if (value.length >= MIN_SECRET_LENGTH && looksSensitive(name, value)) {
            secrets.set(value, path.basename(file));
          }
        }
      } catch (error) {
        log?.(`[redact] could not read ${file}: ${String(error.message ?? error)}`);
      }
    }
  }
  if (secrets.size) log?.(`[redact] watching ${secrets.size} value(s) from env files in the shared folders`);
  return secrets;
}

/**
 * Replace any collected value found in `text`. Marked, never silently dropped — the owner
 * should be able to see that the mechanism fired, and the asker should know something was
 * withheld rather than receive a subtly wrong answer.
 */
export function redact(text, secrets) {
  if (!secrets?.size || !text) return { text, redacted: [] };
  const redacted = [];
  // Longest first, so a value that contains another is replaced whole.
  const ordered = [...secrets.entries()].sort((a, b) => b[0].length - a[0].length);
  let output = text;
  for (const [value, source] of ordered) {
    if (!output.includes(value)) continue;
    output = output.split(value).join(`[redacted: value from ${source}]`);
    redacted.push({ source, length: value.length });
  }
  return { text: output, redacted };
}
