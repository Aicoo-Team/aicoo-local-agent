import { realpathSync, mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideWorkspace } from "../src/agent.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "dm-agent-wall-")));
const ws = join(root, "workspace");
const secret = join(root, "outside");
mkdirSync(ws);
mkdirSync(secret);
writeFileSync(join(ws, "ok.md"), "in workspace");
writeFileSync(join(secret, "secret.txt"), "OUT OF BOUNDS");
symlinkSync(secret, join(ws, "escape-link"));
symlinkSync(join(secret, "secret.txt"), join(ws, "escape-file"));

const cases = [
  ["ok.md", true, "plain file inside"],
  [".", true, "workspace root itself"],
  ["./nested/../ok.md", true, "normalized path staying inside"],
  ["nope.md", true, "not-yet-existing file inside is allowed"],
  [join(secret, "secret.txt"), false, "absolute path outside"],
  ["../outside/secret.txt", false, "relative traversal outside"],
  ["escape-link/secret.txt", false, "read through a symlinked DIRECTORY escaping the workspace"],
  ["escape-file", false, "read through a symlinked FILE escaping the workspace"],
  ["escape-link/newfile.txt", false, "non-existent leaf under an escaping symlink"],
  ["/etc/hosts", false, "system file"],
  [`${ws}-sibling/x`, false, "sibling dir sharing the workspace name prefix"],
];

let failures = 0;
for (const [candidate, expected, label] of cases) {
  const actual = insideWorkspace(candidate, ws);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${candidate}) -> ${actual}, expected ${expected}`);
}
console.log(failures === 0 ? `\nWALL-OK (${cases.length} cases)` : `\nWALL-FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
