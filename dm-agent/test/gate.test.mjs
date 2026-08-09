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

// 1f. Capabilities: enabling a class means "ask me once about each thing", and the identity
//     of "each thing" differs by class — a skill is the capability, a shell command's text IS
//     the payload, a file is what a write is about.
{
  const { Policy } = await import("../src/policy.js");
  const { AgentState } = await import("../src/state.js");
  const outside = join(root, "outside");
  const policy = new Policy({
    folders: [ws], commands: new Map(),
    capabilities: new Set(["skills", "bash", "write", "mcp"]),
  });
  const state = new AgentState(join(root, `grants-${Math.random().toString(36).slice(2)}.json`));
  const asked = [];
  const agent = new LocalDmAgent({
    workspace: ws, policy, state, audit: { record() {} },
    approvals: { ask: async (r) => { asked.push(r); return true; } },
    ownerLabel: "@owner", peerLabel: "@peer", log: () => {},
  });

  const n = () => asked.length;
  const lastPrompt = () => asked[asked.length - 1];
  let before = n();
  await agent.decide("Bash", { command: "git status" });
  check("a first shell command asks", n() === before + 1);
  before = n();
  await agent.decide("Bash", { command: "git status" });
  check("the same command does not ask again", n() === before);
  await agent.decide("Bash", { command: "rm -rf /" });
  check("a DIFFERENT command is a new question", n() === before + 1);

  before = n();
  await agent.decide("Skill", { skill: "pdf" });
  await agent.decide("Skill", { skill: "pdf" });
  check("a skill asks once, then is remembered", n() === before + 1);

  before = n();
  await agent.decide("Write", { file_path: join(ws, "a.md"), content: "x" });
  await agent.decide("Edit", { file_path: join(ws, "a.md"), old_string: "x", new_string: "y" });
  check("write asks once per file, not per edit", n() === before + 1);
  before = n();
  await agent.decide("Write", { file_path: join(ws, "b.md"), content: "x" });
  check("a different file is a new question", n() === before + 1);

  // A write outside the folders is the owner's call, like a read — but it must reach them as a
  // write. Refusing it outright used to seem safer; in practice it left an owner who wanted one
  // file written next door with no way to say so, and the prompt is where that belongs.
  before = n();
  const out = await agent.decide("Write", { file_path: join(outside, "c.md"), content: "x" });
  check("write outside the shared folders asks the owner", n() === before + 1);
  check("...and this owner said yes", out.allow === true);
  check("...recorded as a write escalation, not a read one", out.rule === "owner-escalated-write");
  check("...and the prompt says it CHANGES a file", /CHANGES a file/.test(lastPrompt()?.summary ?? ""));
  check("...and names the path", (lastPrompt()?.summary ?? "").includes(join(outside, "c.md")));

  // What must never be asked is still never asked. These sit above the folder logic, so the
  // change above cannot have opened them: a shell rc or the agent's own state being one `y`
  // away is delayed code execution and a self-granted permission respectively.
  before = n();
  const rc = await agent.decide("Write", { file_path: join(homedir(), ".zshrc"), content: "x" });
  check("a shell rc is refused without asking", rc.allow === false && rc.rule === "path-never-writable");
  const own = await agent.decide("Write", { file_path: join(homedir(), ".aicoo-dm-agent", "state.json"), content: "x" });
  check("the agent's own state is refused without asking", own.allow === false);
  check("...and neither woke the owner", n() === before);

  // A capability the owner did NOT enable is refused, and says which one is missing.
  const bare = new LocalDmAgent({
    workspace: ws, policy: new Policy({ folders: [ws], commands: new Map(), capabilities: new Set() }),
    state, audit: { record() {} },
    approvals: { ask: async () => { asked.push({}); return true; } },
    ownerLabel: "@owner", peerLabel: "@peer", log: () => {},
  });
  before = n();
  const off = await bare.decide("Bash", { command: "ls" });
  check("a capability that was never enabled is denied", off.allow === false && off.rule === "capability-not-enabled");
  check("...without asking the owner", n() === before);

  // A remembered refusal stays refused: re-asking is how a peer wears an owner down.
  const denier = new LocalDmAgent({
    workspace: ws, policy, state: new AgentState(join(root, `d-${Math.random().toString(36).slice(2)}.json`)),
    audit: { record() {} },
    approvals: { ask: async () => { asked.push({}); return false; } },
    ownerLabel: "@owner", peerLabel: "@peer", log: () => {},
  });
  await denier.decide("Skill", { skill: "nope" });
  before = n();
  // Different input shape, same skill: the short-lived decision memo cannot match this, so a
  // second refusal here proves the PERSISTED grant is doing the remembering, not the cache.
  const again = await denier.decide("Skill", { skill: "nope", args: "second attempt" });
  check("a refusal is remembered too", again.allow === false && again.rule === "grant-remembered-deny");
  check("...and is not asked a second time", n() === before);
}

// 1g. Sharing a folder is consent to the work inside it, never to the machine's keys. These
//     all sit INSIDE the shared folder when someone shares their home directory, which is
//     careless rather than consenting — and the check used to run only outside the folders,
//     so each of these was one ordinary approval away.
{
  const { Policy } = await import("../src/policy.js");
  const { AgentState } = await import("../src/state.js");
  const { homedir } = await import("node:os");
  const H = homedir();
  const policy = new Policy({
    folders: [H], commands: new Map(), capabilities: new Set(["write"]),
  });
  const state = new AgentState(join(root, `s-${Math.random().toString(36).slice(2)}.json`));
  let woken = 0;
  const agent = new LocalDmAgent({
    workspace: H, policy, state, audit: { record() {} },
    approvals: { ask: async () => { woken += 1; return true; } }, // would say yes if asked
    ownerLabel: "@owner", peerLabel: "@peer", log: () => {},
  });

  const refuses = [
    ["Read", join(H, ".ssh", "id_rsa"), "reading a private key"],
    ["Write", join(H, ".ssh", "authorized_keys"), "writing authorized_keys is remote persistence"],
    ["Write", join(H, ".aws", "credentials"), "writing cloud credentials"],
    ["Write", join(H, ".zshrc"), "a shell rc file runs on next login"],
    ["Write", join(H, ".claude", "settings.json"), "settings configure the runtime this agent runs in"],
    ["Write", join(H, "p", ".git", "hooks", "pre-commit"), "a git hook runs on next commit"],
    // The agent's own grants: one "may I write this file?" would become every future yes.
    ["Write", join(H, ".aicoo-dm-agent", "x", "state.json"), "writing its own grants file"],
    ["Read", join(H, ".aicoo-dm-agent", "x", "state.json"), "reading its own grants file"],
  ];
  for (const [tool, target, why] of refuses) {
    const before = woken;
    const d = await agent.decide(tool, { file_path: target, content: "x" });
    check(`refused inside a shared folder: ${why}`, d.allow === false);
    check(`...without asking the owner: ${why}`, woken === before);
  }

  // …and none of that blocks the ordinary case it exists to protect.
  const ok = await agent.decide("Write", { file_path: join(H, "p", "README.md"), content: "x" });
  check("an ordinary file in the shared folder is still just an approval", ok.allow === true);
}

// 1h. A guest relationship — whoever is holding a one-time share link — keeps no standing
//     grants. "Remembered for whom?" has no answer when the next holder is a different person
//     and the only thing telling them apart is a fingerprint they control.
{
  const { Policy } = await import("../src/policy.js");
  const { AgentState } = await import("../src/state.js");
  const policy = new Policy({
    folders: [ws], commands: new Map(),
    capabilities: new Set(["bash", "skills"]), trust: "guest",
  });
  const state = new AgentState(join(root, `g-${Math.random().toString(36).slice(2)}.json`));
  const asked = [];
  const agent = new LocalDmAgent({
    workspace: ws, policy, state, audit: { record() {} },
    approvals: { ask: async (r) => { asked.push(r); return true; } },
    ownerLabel: "@owner", peerLabel: "a visitor", log: () => {},
  });

  check("policy exposes the guest tier", policy.isGuest === true);

  await agent.decide("Bash", { command: "ls" });
  const first = asked.length;
  // Vary the input so the short-lived decision memo cannot answer, isolating the grant path.
  const second = await agent.decide("Bash", { command: "ls", timeout: 1 });
  check("a guest is asked again for the same capability", asked.length > first);
  check("and it is recorded as a one-off, not a grant", second.rule === "guest-allowed-once");
  check("nothing was persisted for a guest", state.listGrants().length === 0);

  // The prompt must not promise persistence the relationship will not deliver.
  check("the prompt says 'this once'", /this once/.test(asked[0]?.summary ?? ""));
  check("the prompt does not promise later calls", !/any later/.test(asked[0]?.summary ?? ""));

  // A guest CAN ask for a file just outside the folders: a one-time link with a password was
  // sent to someone specific, so it is a real decision. What the prompt must not do is let the
  // owner think the holder's identity was verified.
  const before = asked.length;
  const out = await agent.decide("Read", { file_path: "/etc/hosts" });
  check("a guest may escalate outside the shared folder", out.allow === true);
  check("...and the owner is actually asked", asked.length === before + 1);
  const esc = asked[asked.length - 1];
  check("the escalation prompt names the path", (esc?.summary ?? "").includes("/etc/hosts"));
  check("...says the identity is not verified", /not verified/.test(esc?.summary ?? ""));
  check("...and is still a one-off, nothing persisted", state.listGrants().length === 0);

  // The hard refusals stay hard for a guest too — a link is not a way around them.
  const cred = await agent.decide("Read", { file_path: join(homedir(), ".ssh", "id_rsa") });
  check("a guest still cannot reach credential stores", cred.allow === false && cred.rule === "path-wall-sensitive");

  // A named peer in the same situation still gets the remembering behaviour.
  const named = new LocalDmAgent({
    workspace: ws,
    policy: new Policy({ folders: [ws], commands: new Map(), capabilities: new Set(["bash"]) }),
    state: new AgentState(join(root, `n-${Math.random().toString(36).slice(2)}.json`)),
    audit: { record() {} },
    approvals: { ask: async () => true },
    ownerLabel: "@owner", peerLabel: "@peer", log: () => {},
  });
  await named.decide("Bash", { command: "ls" });
  const namedAgain = await named.decide("Bash", { command: "ls", timeout: 1 });
  check("a named peer still gets a standing grant", namedAgain.rule === "grant-remembered");
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

// 9. The audit line has to stand on its own a year later. "peer: a visitor via your link" is a
//    display label — it cannot tell two visitors apart, does not say whose machine or which
//    one, and above all does not say how far the answer reached.
{
  const { Policy } = await import("../src/policy.js");
  const { AgentState } = await import("../src/state.js");
  const entries = [];
  const policy = new Policy({ folders: [ws], commands: new Map(), capabilities: new Set(["write"]) });
  const agent = new LocalDmAgent({
    workspace: ws, policy,
    state: new AgentState(join(root, `audit-${Math.random().toString(36).slice(2)}.json`)),
    audit: { record: (e) => entries.push(e) },
    approvals: { ask: async () => true },
    ownerLabel: "@owner", peerLabel: 'a visitor via your "demo" link',
    ownerId: "u_owner_1", deviceId: "dev_abc123", peerId: null,
    log: () => {},
  });
  await agent.decide("Read", { file_path: join(ws, "ok.md") });
  const e = entries[entries.length - 1];
  check("the audit says whose machine", e.ownerId === "u_owner_1");
  check("...and which machine", e.deviceId === "dev_abc123");
  check("...and keeps the human label too", /visitor/.test(e.peer));
  check("...and records no peer id for someone unidentified", e.peerId === null);
  check("...and says how far the yes reaches", e.scope === "turn");

  entries.length = 0;
  await agent.decide("Read", { file_path: join(homedir(), ".ssh", "id_rsa") });
  // A wall is not consent. Recording it with a consent scope would misread as the owner
  // having agreed to something.
  check("a wall is not recorded as a decision the owner made", entries[entries.length - 1].scope === "not-a-decision");

  entries.length = 0;
  await agent.decide("Write", { file_path: join(root, "outside", "z.md"), content: "x" });
  const esc = entries[entries.length - 1];
  check("an out-of-folder write is scoped to this once", esc.scope === "once");
  check("...and named as a write escalation", esc.rule === "owner-escalated-write");
}

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(failures === 0 ? `\nGATE-OK (${checks.length} checks)` : `\nGATE-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
