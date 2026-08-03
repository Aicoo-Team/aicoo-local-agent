import { realpathSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDmAgent } from "../src/agent.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-agent-gate-")));
const ws = join(root, "workspace");
mkdirSync(ws);
writeFileSync(join(ws, "ok.md"), "hi");

function makeAgent(answer) {
  const asked = [];
  const agent = new LocalDmAgent({
    workspace: ws,
    state: { sessionId: null },
    approvals: { ask: async (req) => { asked.push(req); return answer; } },
    ownerLabel: "@owner",
    peerLabel: "@peer",
    log: () => {},
  });
  return { agent, asked };
}

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

// 1. Out-of-workspace read is denied BY THE WALL, without ever waking the owner.
{
  const { agent, asked } = makeAgent(true); // broker would say yes if consulted
  const d = await agent.decide("Read", { file_path: "/etc/hosts" });
  check("out-of-workspace read denied", d.allow === false);
  check("owner NOT asked for out-of-workspace read", asked.length === 0);
}

// 2. Non-read tools are denied before any prompt.
for (const tool of ["Bash", "Write", "Edit", "WebFetch", "Task"]) {
  const { agent, asked } = makeAgent(true);
  const d = await agent.decide(tool, { command: "echo hi" });
  check(`${tool} denied by allowlist`, d.allow === false);
  check(`${tool} did not prompt owner`, asked.length === 0);
}

// 3. Traversal is checked on the path-shaped field, and which field that is per tool.
{
  const { agent, asked } = makeAgent(true);
  const globbed = await agent.decide("Glob", { pattern: "../../**" });
  check("Glob: a traversing pattern is denied", globbed.allow === false);
  check("Glob traversal does not prompt", asked.length === 0);
}
{
  const { agent, asked } = makeAgent(true);
  // Grep's pattern is a regex: `..` means "any two characters", not a parent directory.
  const grepped = await agent.decide("Grep", { pattern: "foo..bar", path: ws });
  check("Grep: a regex containing .. is NOT mistaken for traversal", grepped.allow === true);
  check("Grep: the regex still went to the owner for approval", asked.length === 1);
}
{
  const { agent, asked } = makeAgent(true);
  const grepGlob = await agent.decide("Grep", { pattern: "safe", glob: "../*.env", path: ws });
  check("Grep: a traversing glob filter is denied", grepGlob.allow === false);
  check("Grep traversal does not prompt", asked.length === 0);
}

// 4. In-workspace read DOES ask the owner, and honours "allow".
{
  const { agent, asked } = makeAgent(true);
  const d = await agent.decide("Read", { file_path: join(ws, "ok.md") });
  check("in-workspace read asks the owner", asked.length === 1);
  check("owner allow -> allowed", d.allow === true);
}

// 5. Owner deny is honoured (fail closed).
{
  const { agent } = makeAgent(false);
  const d = await agent.decide("Read", { file_path: join(ws, "ok.md") });
  check("owner deny -> denied", d.allow === false);
}

// 6. Memo: the same call reaching the gate twice (hook + canUseTool) asks once.
{
  const { agent, asked } = makeAgent(true);
  await agent.decide("Read", { file_path: join(ws, "ok.md") });
  await agent.decide("Read", { file_path: join(ws, "ok.md") });
  check("duplicate call prompts owner only once", asked.length === 1);
}

// 7. A *different* call is not covered by the memo.
{
  const { agent, asked } = makeAgent(true);
  await agent.decide("Read", { file_path: join(ws, "ok.md") });
  await agent.decide("Read", { file_path: join(ws, "other.md") });
  check("different call prompts again", asked.length === 2);
}

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(failures === 0 ? `\nGATE-OK (${checks.length} checks)` : `\nGATE-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
