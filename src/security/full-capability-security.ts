const MAX_BASH_COMMAND_CHARS = 32_768;
const MAX_BASH_TIMEOUT_MS = 120_000;
const MIN_BASH_TIMEOUT_MS = 1_000;

const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|DATABASE_URL|AUTH)(?:$|_)/iu;
const SECRET_FIELD_NAME = /(?:^|_)(?:access_?token|refresh_?token|api_?key|secret|password|passwd|private_?key|authorization)(?:$|_)/iu;
const TOKEN_PATTERN = /\b(?:gh[pousr]_|sk-|aicoo_(?:dev|live)_)[A-Za-z0-9_-]{12,}\b/gu;

export type BashHardeningDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Preserve arbitrary shell capability while making the kernel sandbox non-bypassable. */
export function hardenBashInput(input: Record<string, unknown>): BashHardeningDecision {
  const command = input.command;
  if (
    typeof command !== "string"
    || !command.trim()
    || command.length > MAX_BASH_COMMAND_CHARS
    || command.includes("\0")
  ) {
    return { behavior: "deny", message: "Aicoo rejected an invalid shell command" };
  }
  const requestedTimeout = typeof input.timeout === "number" && Number.isFinite(input.timeout)
    ? Math.round(input.timeout)
    : MAX_BASH_TIMEOUT_MS;
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      command,
      timeout: Math.min(MAX_BASH_TIMEOUT_MS, Math.max(MIN_BASH_TIMEOUT_MS, requestedTimeout)),
      dangerouslyDisableSandbox: false,
    },
  };
}

/** Environment variables denied to sandboxed subprocesses; the host runtime can still authenticate. */
export function credentialEnvironmentRules(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Array<{ name: string; mode: "deny" }> {
  return Object.keys(environment)
    .filter((name) => CREDENTIAL_ENV_NAME.test(name))
    .sort()
    .map((name) => ({ name, mode: "deny" as const }));
}

/** Redact common credentials before any tool output is returned to the peer-controlled model. */
export function redactToolOutput(
  output: unknown,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): unknown {
  const knownSecrets = Object.entries(environment)
    .filter(([name, value]) => CREDENTIAL_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  return redactValue(output, knownSecrets, new WeakSet<object>(), 0);
}

function redactValue(
  value: unknown,
  knownSecrets: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactString(value, knownSecrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 20 || seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, knownSecrets, seen, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_FIELD_NAME.test(key) ? "[REDACTED]" : redactValue(item, knownSecrets, seen, depth + 1),
  ]));
}

function redactString(value: string, knownSecrets: readonly string[]): string {
  let redacted = value.replace(TOKEN_PATTERN, "[REDACTED]");
  for (const secret of knownSecrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}
