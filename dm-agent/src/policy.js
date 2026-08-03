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

/**
 * Resolve to a real path, because the wall compares canonical paths.
 *
 * A folder that does not exist cannot be canonicalised, and the unresolved path it falls back
 * to will not match anything the wall later resolves — on macOS `/tmp/x` and `/private/tmp/x`
 * are the same directory and different strings. Failing closed is right; failing closed in
 * silence, with every read denied for a reason nobody can see, is its own bug. Say it here.
 */
function resolveFolder(folder, log) {
  const expanded = path.resolve(expandHome(String(folder)));
  try {
    return realpathSync(expanded);
  } catch {
    log?.(`[policy] WARNING: ${expanded} does not exist. Reads there will be denied until it does.`);
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

/**
 * Capability classes this relationship may use. Deliberately classes and not a list of
 * specific skills or MCP tools: an owner does not know the name of every skill on their
 * machine, so naming them in advance is precision they cannot actually supply. They pick
 * "this peer may use skills"; which skill, on the day, is a question at the moment of use.
 */
export const CAPABILITIES = {
  skills: "the skills installed on this machine (each one asks the first time)",
  mcp: "the MCP servers configured on this machine (each tool asks the first time)",
  bash: "shell commands (each distinct command asks — a remembered one is that exact text)",
  web: "fetching URLs (each host asks the first time)",
  write: "creating and editing files INSIDE the shared folders only (each file asks the first time)",
};

function parseCapabilities(raw, log) {
  if (raw === undefined || raw === null) return new Set();
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string")) {
    throw new PolicyError(`"capabilities" must be an array of strings, e.g. ["skills", "mcp"] — known: ${Object.keys(CAPABILITIES).join(", ")}`);
  }
  const chosen = new Set();
  for (const name of raw) {
    const key = name.trim().toLowerCase();
    if (!(key in CAPABILITIES)) {
      throw new PolicyError(`unknown capability "${name}" — known: ${Object.keys(CAPABILITIES).join(", ")}`);
    }
    chosen.add(key);
  }
  // Shell is the one that is not bounded by anything the owner wrote down. Every other class
  // is a menu someone curated; this one is the machine.
  if (chosen.has("bash")) {
    log?.(`[policy] note: "bash" lets a peer propose ANY shell command. Each distinct one still stops for your approval, but nothing limits what can be proposed.`);
  }
  // Writing is the first capability that changes the machine rather than reporting on it, and
  // a write inside a project folder is execution in disguise — .git/hooks, package.json
  // scripts, a Makefile. Worth saying out loud even though it is bounded by the folders.
  if (chosen.has("write")) {
    log?.(`[policy] note: "write" lets a peer change files in the shared folders. In a code folder that is close to execution (.git/hooks, package.json scripts), so share a folder where that is acceptable.`);
  }
  return chosen;
}

/**
 * Who is on the other end, as far as consent is concerned.
 *
 * "named" is an authenticated Aicoo user the owner connected to deliberately. Remembering a
 * decision about them is meaningful: it is a decision about a person.
 *
 * "guest" is whoever is holding a share link. Remembering anything about them is incoherent —
 * remembered for WHOM? The link is one-time, so the next holder is a different person, and the
 * only thing distinguishing them is a client-supplied fingerprint that can be forged. So a
 * guest relationship keeps no standing grants: every call is asked, every time.
 */
const TRUST_LEVELS = ["named", "guest"];

function parseTrust(raw, log) {
  if (raw === undefined || raw === null) return "named";
  const value = String(raw).trim().toLowerCase();
  if (!TRUST_LEVELS.includes(value)) {
    throw new PolicyError(`unknown trust "${raw}" — must be one of: ${TRUST_LEVELS.join(", ")}`);
  }
  if (value === "guest") {
    log?.(`[policy] guest relationship: nothing is remembered. Every single call asks you, every time, and there is no reading outside the shared folders.`);
  }
  return value;
}

export class Policy {
  /** @param {{folders: string[], commands: Map<string, object>, capabilities: Set<string>, trust?: string, source?: string}} input */
  constructor({ folders, commands, capabilities, trust, source }) {
    this.folders = folders;
    this.commands = commands;
    this.capabilities = capabilities ?? new Set();
    this.trust = trust ?? "named";
    this.source = source;
  }

  /** No policy file: one folder, read-only, no commands, no capabilities. */
  static readOnly(workspace, log) {
    return new Policy({ folders: [resolveFolder(workspace, log)], commands: new Map(), capabilities: new Set() });
  }

  can(capability) {
    return this.capabilities.has(capability);
  }

  /** Anonymous link holder: nothing is remembered, and nothing outside the folders is offered. */
  get isGuest() {
    return this.trust === "guest";
  }

  static fromFile(file, workspace, log) {
    if (!existsSync(file)) return Policy.readOnly(workspace, log);

    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new PolicyError(`${file} is not valid JSON: ${String(error.message ?? error)}`);
    }

    const folders = Array.isArray(raw.folders) && raw.folders.length
      ? raw.folders.map((folder) => resolveFolder(folder, log))
      : [resolveFolder(workspace, log)];
    const commands = parseCommands(raw.commands, log);
    const capabilities = parseCapabilities(raw.capabilities, log);
    const trust = parseTrust(raw.trust, log);
    return new Policy({ folders, commands, capabilities, trust, source: file });
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
    const caps = this.capabilities.size ? [...this.capabilities].join(", ") : "none";
    return `folders: ${folders} · commands: ${commands} · capabilities: ${caps}`;
  }
}
