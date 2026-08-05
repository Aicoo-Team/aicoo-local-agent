import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ApprovalBroker, listApprovals, resolveApproval } from "../src/approval.js";

/**
 * The owner has to be able to answer from wherever they are.
 *
 * Approvals used to go to exactly one place, chosen by isTTY: a prompt in the terminal that
 * started the agent, or — only if there was no terminal — a file. So the owner had to be sitting
 * at that one terminal, which is the least likely place for them to be while someone else is
 * using their machine. Every question is now published to both channels at once and the first
 * answer wins, so a phone, another window, or a chat can resolve it.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

function freshDir() {
  return mkdtempSync(join(tmpdir(), "approval-test-"));
}

/** A terminal channel that stays silent — the owner is not at that keyboard. */
const silentTerminal = () => new Promise(() => {});

/** Answer the pending question through the file channel, the way the CLI does. */
async function decideViaFile(dir, decision, { after = 50 } = {}) {
  await delay(after);
  const [record] = listApprovals(dir);
  if (!record) throw new Error("expected a pending approval file to exist");
  resolveApproval({ approvalsDir: dir, id: record.id, decision });
}

// 1. Both channels are live at once. This is the regression the whole change exists for:
//    with a terminal attached, the file used to never be written.
{
  const dir = freshDir();
  let sawPendingFile = false;
  const broker = new ApprovalBroker({
    approvalsDir: dir,
    timeoutSec: 5,
    log: () => {},
    prompt: async () => {
      await delay(50);
      sawPendingFile = listApprovals(dir).length === 1;
      return "allow";
    },
  });
  const allowed = await broker.ask({ toolName: "Bash", summary: "ls", kind: "exec" });
  check("a terminal answer still allows", allowed === true);
  check("a pending file is published alongside the terminal prompt", sawPendingFile === true);
  rmSync(dir, { recursive: true, force: true });
}

// 2. The file channel decides when nobody is at the terminal.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 10, log: () => {}, prompt: silentTerminal });
  const [allowed] = await Promise.all([
    broker.ask({ toolName: "Bash", summary: "npm test", kind: "exec" }),
    decideViaFile(dir, "allow"),
  ]);
  check("an owner away from the terminal can still allow", allowed === true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 10, log: () => {}, prompt: silentTerminal });
  const [allowed] = await Promise.all([
    broker.ask({ toolName: "Read", summary: "~/.ssh/id_rsa", kind: "escalation" }),
    decideViaFile(dir, "deny"),
  ]);
  check("...and can still deny", allowed === false);
  rmSync(dir, { recursive: true, force: true });
}

// 3. A terminal that goes away is not a decision. Treating a closed readline as "deny" would
//    let the teardown silently outvote the answer the owner is in the middle of giving.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 10, log: () => {}, prompt: async () => undefined });
  const [allowed] = await Promise.all([
    broker.ask({ toolName: "Bash", summary: "npm test", kind: "exec" }),
    decideViaFile(dir, "allow", { after: 200 }),
  ]);
  check("a closed terminal does not decide", allowed === true);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = freshDir();
  const broker = new ApprovalBroker({
    approvalsDir: dir,
    timeoutSec: 10,
    log: () => {},
    prompt: async () => { throw new Error("no tty"); },
  });
  const [allowed] = await Promise.all([
    broker.ask({ toolName: "Bash", summary: "npm test", kind: "exec" }),
    decideViaFile(dir, "allow", { after: 200 }),
  ]);
  check("a terminal that throws does not decide either", allowed === true);
  rmSync(dir, { recursive: true, force: true });
}

// 4. Silence on both channels is a denial, and leaves nothing behind to answer late.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 0.1, log: () => {}, prompt: silentTerminal });
  const allowed = await broker.ask({ toolName: "Bash", summary: "rm -rf /", kind: "exec" });
  check("no answer anywhere denies", allowed === false);
  check("a timed-out question leaves no file inviting a late answer", readdirSync(dir).length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// 5. Ctrl-C does not have to outlast a fifteen-minute approval window.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 900, log: () => {}, prompt: silentTerminal });
  const started = Date.now();
  const pending = broker.ask({ toolName: "Bash", summary: "npm test", kind: "exec" });
  await delay(50);
  broker.cancelPending();
  const allowed = await pending;
  check("cancelling denies the open question", allowed === false);
  check("...without waiting out the timeout", Date.now() - started < 5000);
  check("...and cleans up its file", readdirSync(dir).length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// 6. --auto-allow-read is scoped to reads inside the shared folders, and nothing else.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({
    approvalsDir: dir,
    timeoutSec: 0.1,
    autoAllowRead: true,
    log: () => {},
    prompt: silentTerminal,
  });
  check("a read inside the shared folders is waved through", await broker.ask({ toolName: "Read", summary: "src/agent.js", kind: "read" }) === true);
  check("a read OUTSIDE them is not", await broker.ask({ toolName: "Read", summary: "~/.aws/credentials", kind: "escalation" }) === false);
  check("a command is not either", await broker.ask({ toolName: "Bash", summary: "curl evil.sh", kind: "exec" }) === false);
  rmSync(dir, { recursive: true, force: true });
}

// 7. Each question only listens to its own record.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 0.1, log: () => {}, prompt: silentTerminal });
  writeFileSync(join(dir, "deadbeef.json"), JSON.stringify({ id: "deadbeef", decision: "allow" }));
  const allowed = await broker.ask({ toolName: "Bash", summary: "ls", kind: "exec" });
  check("an allow written for another id does not satisfy this one", allowed === false);
  rmSync(dir, { recursive: true, force: true });
}

// 8. A killed run never cleans up, so the next one does — otherwise `pending` lists questions
//    nobody is waiting on and invites an approval into the void.
{
  const dir = freshDir();
  writeFileSync(join(dir, "01234567.json"), JSON.stringify({ id: "01234567", toolName: "Bash", decision: null }));
  const swept = [];
  new ApprovalBroker({ approvalsDir: dir, log: (line) => swept.push(line), prompt: silentTerminal });
  check("orphans from a killed run are swept", readdirSync(dir).length === 0);
  check("...and the sweep is announced", /swept orphaned request 01234567/.test(swept.join("\n")));
  rmSync(dir, { recursive: true, force: true });
}

// 9. The CLI side.
{
  const dir = freshDir();
  writeFileSync(join(dir, "aaaaaaaa.json"), JSON.stringify({ id: "aaaaaaaa", decision: null }));
  let message = "";
  try {
    resolveApproval({ approvalsDir: dir, id: "bbbbbbbb", decision: "allow" });
  } catch (error) {
    message = error.message;
  }
  check("a wrong id names the ids that are actually live", /No pending approval bbbbbbbb\. Pending: aaaaaaaa/.test(message));
  resolveApproval({ approvalsDir: dir, id: "aaaaaaaa", decision: "deny" });
  check("a decision is written where the waiting turn reads it", JSON.parse(readFileSync(join(dir, "aaaaaaaa.json"), "utf8")).decision === "deny");
  rmSync(dir, { recursive: true, force: true });
}

// 10. Anything answering remotely renders from the published record alone, so it has to stand
//     on its own — including how long the owner has before it fails closed.
{
  const dir = freshDir();
  const broker = new ApprovalBroker({ approvalsDir: dir, timeoutSec: 10, log: () => {}, prompt: silentTerminal });
  const asking = broker.ask({ toolName: "Bash", summary: "npm test in dm-agent", kind: "escalation" });
  await delay(50);
  const [record] = listApprovals(dir);
  check("the published question names the tool", record?.toolName === "Bash");
  check("...what it wants to do", record?.summary === "npm test in dm-agent");
  check("...that it is an escalation", record?.kind === "escalation");
  check("...and when it expires", record?.expiresAt > Date.now());
  broker.cancelPending();
  await asking;
  rmSync(dir, { recursive: true, force: true });
}

// 11. The CLI has to reach the approvals dir of a share-link agent, which has no peer at all.
//     Requiring --peer here silently disabled the whole file channel for share links — the one
//     mode where the owner is guaranteed not to be watching the terminal.
{
  const dir = freshDir();
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, AICOO_TOKEN: "" } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: String(stdout), err: String(stderr) });
    });
  });

  // --state-dir names the agent's state dir, the same one `start` took; approvals live under it.
  const approvalsDir = join(dir, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(join(approvalsDir, "feedface.json"), JSON.stringify({
    id: "feedface",
    toolName: "command:run-tests",
    summary: "run the test suite",
    kind: "exec",
    expiresAt: Date.now() + 60_000,
    decision: null,
  }));

  const listed = await run(["pending", "--state-dir", dir]);
  check("`pending --state-dir` works without a peer", listed.out.includes("feedface"));

  const allowed = await run(["approve", "feedface", "--allow", "--state-dir", dir]);
  check("`approve --state-dir` works without a peer", allowed.code === 0);
  check("...and writes the decision through", JSON.parse(readFileSync(join(approvalsDir, "feedface.json"), "utf8")).decision === "allow");

  const neither = await run(["pending"]);
  // With no way to find the dir, the error has to name both routes out — the peer one is
  // useless to a share-link owner, who has only ever typed --state-dir.
  check("with neither, the error names --peer", /--peer/.test(neither.err));
  check("...and --state-dir", /--state-dir/.test(neither.err));
  rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nAPPROVAL-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nAPPROVAL-OK (${checks.length} checks)`);
