import { realpathSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
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

// 1. A read outside the shared folders is the owner's call, not an automatic refusal —
//    "the file is one directory up" is ordinary, and a wall that deletes the capability is
//    not safety. But it must arrive marked as an escalation, carrying the resolved path.
{
  const { agent, asked } = makeAgent(true);
  const d = await agent.decide("Read", { file_path: "/etc/hosts" });
  check("out-of-folder read asks the owner", asked.length === 1);
  check("it is marked as an escalation, not an ordinary read", asked[0]?.kind === "escalation");
  check("the prompt says it is outside the shared folders", /OUTSIDE/.test(asked[0]?.summary ?? ""));
  check("the prompt carries the resolved path", (asked[0]?.summary ?? "").includes("/etc/hosts"));
  check("owner allow means allow", d.allow === true);
  check("and it is recorded as an escalation", d.rule === "owner-escalated");
}

// 1b. …and an owner who says no is obeyed.
{
  const { agent, asked } = makeAgent(false);
  const d = await agent.decide("Read", { file_path: "/etc/hosts" });
  check("owner deny means deny", d.allow === false);
  check("declined escalation is recorded as such", d.rule === "owner-declined-escalation");
  check("the owner was asked exactly once", asked.length === 1);
}

// 1c. Credential stores are refused WITHOUT asking. There is no legitimate version of this
//     request, and a prompt for one is just an invitation to fat-finger `y`.
{
  const { agent, asked } = makeAgent(true); // broker would say yes if consulted
  const d = await agent.decide("Read", { file_path: join(homedir(), ".ssh", "id_rsa") });
  check("credential path denied", d.allow === false);
  check("credential path denied by rule, not by the owner", d.rule === "path-wall-sensitive");
  check("owner NOT asked about a credential path", asked.length === 0);
}

// 1d. The escalation budget is what keeps the wall protecting attention as well as files:
//     a peer who can ring the terminal indefinitely eventually gets a `y` out of fatigue.
{
  const { agent, asked } = makeAgent(true);
  for (let i = 0; i < 5; i++) await agent.decide("Read", { file_path: `/etc/hosts${i}` });
  check("escalations are capped per turn", asked.length === 3);
  const last = await agent.decide("Read", { file_path: "/etc/passwd" });
  check("past the cap it denies", last.allow === false);
  check("past the cap it does not ask", last.rule === "escalation-budget");
}

// 1e. A symlink must be shown to the owner as where it actually lands, or the prompt is
//     asking them to consent to a fiction.
{
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.md"), "x");
  symlinkSync(outside, join(ws, "looks-innocent"));
  const { agent, asked } = makeAgent(false);
  await agent.decide("Read", { file_path: join(ws, "looks-innocent", "secret.md") });
  check("symlinked path still reaches the owner", asked.length === 1);
  check("the owner is shown the real destination, not the symlink", (asked[0]?.summary ?? "").includes(realpathSync(outside)));
  check("the disguising name is not what they approve", !(asked[0]?.summary ?? "").includes("looks-innocent"));
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
