import { execFile } from "node:child_process";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

/**
 * Can this machine reach the model's API at all?
 *
 * Deliberately a network check and not a trial turn. Two earlier attempts ran a short prompt
 * through the SDK and both reported healthy on a machine where every real turn was failing
 * with a 403 — a brief probe slips through often enough to be useless as a signal, and a real
 * turn does not. Meanwhile this check has been unambiguous every single time: 403 when the
 * network refuses, 405 when it does not. 405 is the endpoint saying "wrong method", which is
 * exactly what we want — proof of reach without spending a token or touching an account.
 *
 * curl rather than fetch because curl honours HTTP_PROXY/HTTPS_PROXY the same way the runtime
 * subprocess does. Node's fetch ignores them, so it would report a block the runtime does not
 * have — measuring a different machine than the one doing the work.
 */
export async function checkModelReachable({ timeoutMs = 20_000 } = {}) {
  const seconds = Math.max(5, Math.round(timeoutMs / 1000));
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", String(seconds), ENDPOINT],
      { timeout: timeoutMs + 5000, env: process.env },
      (error, stdout) => {
        const status = Number(String(stdout).trim());
        if (error && !status) {
          // No curl, or it could not run at all. Not evidence of a block — say so rather than
          // refusing to start over a check that did not happen.
          resolve({ ok: true, skipped: true, reason: String(error.message ?? error) });
          return;
        }
        if (status === 403) {
          resolve({ ok: false, status, reason: "403" });
          return;
        }
        if (!status) {
          resolve({ ok: false, status: 0, reason: "no response" });
          return;
        }
        // 405, 401, 400 — all mean the request arrived. That is the whole question here.
        resolve({ ok: true, status });
      },
    );
  });
}

/**
 * Turn the result into the one sentence that unblocks someone.
 *
 * "Failed to authenticate. API Error: 403" reads as a credentials problem and sends people to
 * re-login, which cannot help: the 403 happens before any credential is considered. Naming the
 * proxy is the difference between a two-minute fix and an evening.
 */
export function explainUnreachable(result) {
  if (result?.status === 403) {
    return [
      "this machine cannot reach api.anthropic.com — the network refused the request (403).",
      "This is NOT a login problem; re-authenticating will not help.",
      "Start the agent with your proxy, for example:",
      "   HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 aicoo-dm-agent start …",
      "Confirm it works — this must print 405, not 403:",
      "   curl -s -o /dev/null -w '%{http_code}\\n' https://api.anthropic.com/v1/messages",
    ].join("\n   ");
  }
  if (result?.status === 0) {
    return [
      "no response from api.anthropic.com at all — the machine appears to be offline,",
      "or a proxy is set but not running.",
    ].join("\n   ");
  }
  return String(result?.reason ?? "unknown");
}
