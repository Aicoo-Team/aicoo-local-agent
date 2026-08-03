import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * What a given peer is allowed to reach on this machine.
 *
 * Absent policy file = exactly today's behaviour: the one --workspace folder,
 * read-only, no commands. A policy only ever widens folders and adds commands;
 * it can never grant a tool the gate does not already know about.
 */

/** Binaries whose presence in a declared command is worth saying out loud. */
const NOTEWORTHY = ["sudo", "rm", "curl", "wget", "ssh", "scp", "chmod", "chown", "dd", "kill", "pkill"];

export class PolicyError extends Error {}

function expandHome(target) {
  return target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
}

/** Resolve to a real path so the wall compares canonical paths, as insideWorkspace does. */
function resolveFolder(folder) {
  const expanded = path.resolve(expandHome(String(folder)));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function parseCommands(raw, log) {
  const commands = new Map();
  for (const [name, entry] of Object.entries(raw ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
      throw new PolicyError(`command name "${name}" must be lowercase letters, digits and dashes (max 40 chars)`);
    }
    // A command written as a string is the shell-injection shape: it only means
    // anything once something splits it, and whatever splits it becomes the
    // attack surface. Refuse it loudly rather than quietly running it through a shell.
    if (typeof entry === "string" || Array.isArray(entry)) {
      throw new PolicyError(
        `command "${name}" must be an object like { "argv": ["npm", "test"] } — a bare string or array is not accepted`,
      );
    }
    const argv = entry?.argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part.length > 0)) {
      throw new PolicyError(`command "${name}" needs a non-empty argv array of strings, e.g. { "argv": ["npm", "test"] }`);
    }
    const describe = typeof entry.describe === "string" ? entry.describe : undefined;
    const timeoutMs = Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : undefined;
    commands.set(name, { name, argv: [...argv], ...(describe ? { describe } : {}), ...(timeoutMs ? { timeoutMs } : {}) });

    const hit = argv.filter((part) => NOTEWORTHY.includes(path.basename(part)));
    if (hit.length) {
      // The owner's machine and the owner's call — say it, do not block it.
      log?.(`[policy] note: command "${name}" runs ${hit.join(", ")}. Anyone you grant it to can trigger that.`);
    }
  }
  return commands;
}

export class Policy {
  /** @param {{folders: string[], commands: Map<string, object>, source?: string}} input */
  constructor({ folders, commands, source }) {
    this.folders = folders;
    this.commands = commands;
    this.source = source;
  }

  /** No policy file: one folder, read-only, no commands. */
  static readOnly(workspace) {
    return new Policy({ folders: [resolveFolder(workspace)], commands: new Map() });
  }

  static fromFile(file, workspace, log) {
    if (!existsSync(file)) return Policy.readOnly(workspace);

    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new PolicyError(`${file} is not valid JSON: ${String(error.message ?? error)}`);
    }

    const folders = Array.isArray(raw.folders) && raw.folders.length
      ? raw.folders.map(resolveFolder)
      : [resolveFolder(workspace)];
    const commands = parseCommands(raw.commands, log);
    return new Policy({ folders, commands, source: file });
  }

  get commandNames() {
    return [...this.commands.keys()];
  }

  command(name) {
    return this.commands.get(name);
  }

  /** Human-readable summary for the startup banner. */
  describe() {
    const folders = this.folders.map((f) => f.replace(homedir(), "~")).join(", ");
    const commands = this.commandNames.length ? this.commandNames.join(", ") : "none";
    return `folders: ${folders} · commands: ${commands}`;
  }
}
