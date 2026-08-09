import { realpathSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDmAgent } from "../src/agent.js";

/**
 * The credential store that lives INSIDE the shared folder.
 *
 * Every other wall in this agent guards somewhere an owner would never knowingly share.
 * A .env is the opposite: sharing a project means sharing the file the project keeps its
 * database password in. So the test that matters is not "is it outside the folder" — it is
 * "the owner shared this folder on purpose, and the keys in it are STILL not readable".
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-agent-dotenv-")));
const ws = join(root, "workspace");
mkdirSync(ws);
mkdirSync(join(ws, ".codex"));
mkdirSync(join(ws, "packages", "api"), { recursive: true });

// A real-shaped secret, so a refusal that leaked it would be visible rather than subtle.
const SECRET = "PGPASSWORD=hunter2-do-not-echo-this";
writeFileSync(join(ws, ".env"), `${SECRET}\nNEXTAUTH_SECRET=abcdefghijklmnop\n`);
writeFileSync(join(ws, ".env.aicoo-dev"), SECRET);
writeFileSync(join(ws, ".codex", ".env"), SECRET);
writeFileSync(join(ws, "packages", "api", ".env.production"), SECRET);
writeFileSync(join(ws, ".env.example"), "PGPASSWORD=\nNEXTAUTH_SECRET=\n");
writeFileSync(join(ws, ".env.testing.example"), "PGPASSWORD=\n");
writeFileSync(join(ws, "ok.md"), "ordinary file");
writeFileSync(join(ws, "environment.md"), "not a dotenv file despite the name");

function makeAgent() {
  const asked = [];
  const agent = new LocalDmAgent({
    workspace: ws,
    state: { sessionId: null },
    // Says yes to everything. Anything refused below is refused by the wall, never by a
    // decision — that is the whole point of the distinction being tested.
    approvals: { ask: async (req) => { asked.push(req); return true; } },
    ownerLabel: "@owner",
    peerLabel: "@peer",
    log: () => {},
  });
  return { agent, asked };
}

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

// 1. A dotenv file inside the shared workspace is refused by rule, and the owner is never
//    shown a prompt for it. A prompt here would be the attack, not the defence: it asks a
//    busy person to distinguish `.env.example` from `.env` at a glance, mid-conversation.
{
  const cases = [
    [".env", "the workspace root .env"],
    [".env.aicoo-dev", "a suffixed .env"],
    [".codex/.env", "a .env nested in a tool's own directory"],
    ["packages/api/.env.production", "a .env deep in a monorepo"],
  ];
  for (const [file, label] of cases) {
    const { agent, asked } = makeAgent();
    const d = await agent.decide("Read", { file_path: join(ws, file) });
    check(`refused: ${label}`, d.allow === false);
    check(`...by the wall, not by the owner: ${label}`, d.rule === "path-wall-sensitive");
    check(`...and the owner was never prompted: ${label}`, asked.length === 0);
  }
}

// 1b. Same file, reached the other ways a peer can reach it: a relative path, and Grep
//     pointed straight at it. The gate reads `file_path`, `path` and `notebook_path`, so a
//     wall wired to only one of them would have an open door next to it.
{
  const { agent, asked } = makeAgent();
  const rel = await agent.decide("Read", { file_path: ".env" });
  check("refused via a workspace-relative path", rel.allow === false && rel.rule === "path-wall-sensitive");

  const grep = await agent.decide("Grep", { pattern: "PGPASSWORD", path: join(ws, ".env") });
  check("refused when Grep names the file directly", grep.allow === false && grep.rule === "path-wall-sensitive");
  check("neither one troubled the owner", asked.length === 0);
}

// 1c. Not writable either — a peer with the write capability must not be able to overwrite
//     the owner's credentials any more than read them.
{
  const { agent, asked } = makeAgent();
  const d = await agent.decide("Write", { file_path: join(ws, ".env"), content: "x" });
  check("a dotenv file is not writable either", d.allow === false);
  check("...recorded as never-writable", d.rule === "path-never-writable");
  check("...without asking", asked.length === 0);
}

// 2. Ordinary repository work still works. A wall that also swallows `.env.example` teaches
//    the owner to stop sharing folders, which costs more than it protects: the example file
//    is checked in precisely BECAUSE it holds no values.
{
  const cases = [
    [".env.example", "the example file"],
    [".env.testing.example", "a suffixed example file"],
    ["ok.md", "an ordinary file"],
    ["environment.md", "a file whose name merely starts with 'environment'"],
  ];
  for (const [file, label] of cases) {
    const { agent, asked } = makeAgent();
    const d = await agent.decide("Read", { file_path: join(ws, file) });
    check(`still readable: ${label}`, d.allow === true);
    check(`...as an ordinary owner decision: ${label}`, d.rule === "owner-approved");
    check(`...which the owner was actually asked: ${label}`, asked.length === 1);
  }
}

// 3. The refusal itself must not become the leak. A message that reported what it was
//    protecting — the matching line, the first bytes, even the byte count — would hand over
//    the secret through the door marked "denied". The peer reads this text.
{
  const { agent } = makeAgent();
  const d = await agent.decide("Read", { file_path: join(ws, ".env") });
  const message = String(d.reason);
  check("the refusal does not echo the secret value", !message.includes("hunter2-do-not-echo-this"));
  check("...nor the variable names in the file", !/PGPASSWORD|NEXTAUTH_SECRET/.test(message));
  check("...and says what to do instead", /example/i.test(message));
}

// 4. The audit records a wall as a wall. Filed as consent it would read, a year later, as the
//    owner having waved their credentials through.
{
  const entries = [];
  const agent = new LocalDmAgent({
    workspace: ws,
    state: { sessionId: null },
    approvals: { ask: async () => true },
    audit: { record: (entry) => entries.push(entry) },
    ownerLabel: "@owner",
    peerLabel: "@peer",
    log: () => {},
  });
  await agent.decide("Read", { file_path: join(ws, ".env") });
  const entry = entries[entries.length - 1];
  check("the audit records the denial", entry.decision === "deny");
  check("...as not-a-decision, because nobody decided it", entry.scope === "not-a-decision");
}

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(failures === 0 ? `\nDOTENV-WALL-OK (${checks.length} checks)` : `\nDOTENV-WALL-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
