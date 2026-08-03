import { realpathSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Policy, PolicyError } from "../src/policy.js";
import { runDeclaredCommand, RUN_COMMAND_TOOL } from "../src/commands.js";
import { LocalDmAgent } from "../src/agent.js";
import { collectSecrets, redact } from "../src/redact.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-agent-cmd-")));
const ws = join(root, "workspace");
mkdirSync(ws);
writeFileSync(join(ws, ".env"), [
  "NODE_ENV=development",
  "SERVICE_API_TOKEN=sk-live-9f3a2b7c4d5e6f70",
  "PORT=3000",
].join("\n"));

const checks = [];
const check = (label, cond) => checks.push([label, cond]);

function policyFile(contents) {
  const file = join(root, `policy-${checks.length}.json`);
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

function makeAgent(policy, answer) {
  const asked = [];
  const audited = [];
  const agent = new LocalDmAgent({
    workspace: ws,
    state: { sessionId: null },
    approvals: { ask: async (req) => { asked.push(req); return answer; } },
    audit: { record: (e) => audited.push(e) },
    policy,
    ownerLabel: "@owner",
    peerLabel: "@peer",
    log: () => {},
  });
  return { agent, asked, audited };
}

// ── policy loader ─────────────────────────────────────────────────────────────
{
  let threw = null;
  try {
    Policy.fromFile(policyFile({ commands: { "run-tests": "npm test" } }), ws);
  } catch (error) { threw = error; }
  check("a command written as a bare string is rejected", threw instanceof PolicyError);

  threw = null;
  try {
    Policy.fromFile(policyFile({ commands: { "run-tests": { argv: "npm test" } } }), ws);
  } catch (error) { threw = error; }
  check("argv as a string is rejected", threw instanceof PolicyError);

  threw = null;
  try {
    Policy.fromFile(policyFile({ commands: { "Run Tests": { argv: ["npm", "test"] } } }), ws);
  } catch (error) { threw = error; }
  check("an unsafe command name is rejected", threw instanceof PolicyError);

  const ok = Policy.fromFile(policyFile({ commands: { "run-tests": { argv: ["npm", "test"] } } }), ws);
  check("a well-formed command loads", ok.command("run-tests")?.argv.join(" ") === "npm test");

  const none = Policy.fromFile(join(root, "does-not-exist.json"), ws);
  check("no policy file means no commands", none.commandNames.length === 0);
  check("no policy file still grants the workspace", none.folders.includes(ws));
}

// ── the gate ──────────────────────────────────────────────────────────────────
const policy = Policy.fromFile(
  policyFile({ commands: { "run-tests": { argv: ["node", "-e", "console.log('ok')"] } } }),
  ws,
);

{
  // The whole point of ordering: probing for command names must not ring the terminal.
  const { agent, asked } = makeAgent(policy, true);
  const d = await agent.decide(RUN_COMMAND_TOOL, { name: "rm-rf" });
  check("an undeclared command is denied", d.allow === false);
  check("an undeclared command does NOT wake the owner", asked.length === 0);
}
{
  const { agent, asked } = makeAgent(policy, true);
  const d = await agent.decide(RUN_COMMAND_TOOL, { name: "run-tests" });
  check("a declared command asks the owner", asked.length === 1);
  check("owner allow runs it", d.allow === true);
  check(
    "the prompt names the command and its exact argv",
    asked[0].summary.includes('"run-tests"') && asked[0].summary.includes("node -e"),
  );
  check("the prompt contains no shell metacharacters", !/[;&|`$]/.test(asked[0].summary.replace(/\$/g, "")));
}
{
  const { agent } = makeAgent(policy, false);
  const d = await agent.decide(RUN_COMMAND_TOOL, { name: "run-tests" });
  check("owner deny blocks it", d.allow === false);
}
{
  const { agent, asked } = makeAgent(policy, true);
  await agent.decide("ToolSearch", {});
  check("ToolSearch is allowed without a prompt", asked.length === 0);
}
{
  const { agent, asked } = makeAgent(policy, true);
  const d = await agent.decide("Bash", { command: "npm test" });
  check("Bash is still refused outright", d.allow === false);
  check("Bash does not wake the owner", asked.length === 0);
}
{
  // A repeated command is a second request, so it must be a second question.
  const { agent, asked } = makeAgent(policy, true);
  await agent.decide(RUN_COMMAND_TOOL, { name: "run-tests" });
  await agent.decide(RUN_COMMAND_TOOL, { name: "run-tests" });
  check("the two gate paths of one call ask once", asked.length === 1);
}
{
  const { agent, audited } = makeAgent(policy, true);
  await agent.decide(RUN_COMMAND_TOOL, { name: "nope" });
  check("the refusal is audited with the deciding rule", audited[0]?.rule === "command-not-declared");
}

// ── --auto-allow-read is about reads, and only reads ──────────────────────────
{
  const { ApprovalBroker } = await import("../src/approval.js");
  const dir = join(root, "auto-allow");
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 1, autoAllowRead: true, log: () => {} });
  check("a read is auto-allowed by the flag", (await broker.ask({ toolName: "Read", summary: "x", kind: "read" })) === true);
  // Would otherwise block for the timeout; 1s is the whole point of the short window here.
  check("a command is NOT auto-allowed by it", (await broker.ask({ toolName: "command:x", summary: "x", kind: "exec" })) === false);
  check("an unlabelled request is treated as exec", (await broker.ask({ toolName: "?", summary: "x" })) === false);
}

// ── the runner ────────────────────────────────────────────────────────────────
{
  const result = await runDeclaredCommand({ name: "echo", argv: ["node", "-e", "console.log('3 passed')"] }, { cwd: ws });
  check("a command runs and returns output", result.ok && result.output.includes("3 passed"));

  const failed = await runDeclaredCommand({ name: "boom", argv: ["node", "-e", "process.exit(3)"] }, { cwd: ws });
  check("a non-zero exit is reported, not thrown", failed.ok === false && failed.exitCode === 3);

  const missing = await runDeclaredCommand({ name: "ghost", argv: ["definitely-not-a-binary-xyz"] }, { cwd: ws });
  check("a missing binary is reported cleanly", missing.status === "not_found");

  const slow = await runDeclaredCommand(
    { name: "slow", argv: ["node", "-e", "setTimeout(()=>{},5000)"], timeoutMs: 300 },
    { cwd: ws },
  );
  check("a slow command is killed and reported as a timeout", slow.status === "timeout");

  const big = await runDeclaredCommand(
    { name: "big", argv: ["node", "-e", "console.log('x'.repeat(50000))"] },
    { cwd: ws },
  );
  check("large output is truncated, not an ENOBUFS crash", big.output.includes("[truncated at"));

  // No shell exists, so the metacharacters are just characters.
  const injected = await runDeclaredCommand(
    { name: "inject", argv: ["node", "-e", "console.log(process.argv[1] ?? 'none')", "; rm -rf /tmp/nope"] },
    { cwd: ws },
  );
  check("shell metacharacters arrive as a literal argument", injected.output.includes("; rm -rf /tmp/nope"));
}

// ── redaction ─────────────────────────────────────────────────────────────────
{
  const secrets = collectSecrets([ws]);
  check("secret-length values are collected", secrets.has("sk-live-9f3a2b7c4d5e6f70"));
  check("short values like a port are not collected", !secrets.has("3000"));

  const leak = redact("The token is sk-live-9f3a2b7c4d5e6f70, try that.", secrets);
  check("a leaked value is replaced", !leak.text.includes("sk-live-9f3a2b7c4d5e6f70"));
  check("the replacement is visible, not silent", leak.text.includes("[redacted: value from .env]"));
  check("the redaction is reported to the caller", leak.redacted.length === 1);

  const clean = redact("You're missing SERVICE_API_TOKEN — ask the owner for it.", secrets);
  check("naming a variable is untouched", clean.text.includes("SERVICE_API_TOKEN") && clean.redacted.length === 0);

  const prose = redact("The environment is development and the port is 3000.", secrets);
  check("ordinary prose is untouched", prose.redacted.length === 0);
}

let failures = 0;
for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(failures === 0 ? `\nCOMMANDS-OK (${checks.length} checks)` : `\nCOMMANDS-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
