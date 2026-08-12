import { AicooApi } from "../src/api.js";

/**
 * A new agent must survive an old server.
 *
 * The upload rides the message poll, so if a deployment that predates the POST handler answers
 * 405, an agent with anything queued turns every poll into a failing request. It then stops
 * receiving messages entirely — and because the poll doubles as the reachability signal, it
 * concludes it cannot reach Aicoo and restarts itself on a five-minute cycle. Publishing the
 * client before deploying the server would have done that to everyone with a backlog.
 *
 * Confirmed against production before the server half shipped: POST → 405, GET → 200.
 */

const checks = [];
const check = (label, cond) => { checks.push([label, cond]); };

/** An AicooApi whose HTTP layer is replaced by a script of responses. */
function apiWith(handler) {
  const api = new AicooApi({ baseUrl: "https://example.test", token: "t", log: () => {} });
  const calls = [];
  api.request = async (path, opts = {}) => {
    calls.push({ method: opts.method ?? "GET", path, body: opts.body });
    return handler(opts.method ?? "GET", opts.body);
  };
  return { api, calls };
}

const httpError = (status) => Object.assign(new Error(`http ${status}`), { status });
const okBody = { links: [], messages: [{ id: 1 }] };

// 1. The ordinary case: a server that speaks both.
{
  const { api, calls } = apiWith((method) =>
    method === "POST" ? { ...okBody, decisions: { accepted: ["e1"], rejected: [] } } : okBody);
  const res = await api.guestMessages(0, [{ clientEventId: "e1" }]);
  check("a backlog goes up as a POST", calls[0].method === "POST");
  check("...carrying the rows", calls[0].body.decisions.length === 1);
  check("...and the answer comes back", res.decisions.accepted[0] === "e1");
  check("...along with the messages", res.messages.length === 1);
}

// 2. Nothing queued stays a GET — the shape every published agent already speaks.
{
  const { api, calls } = apiWith(() => okBody);
  const res = await api.guestMessages(0, []);
  check("no backlog means no POST", calls[0].method === "GET");
  check("an absent decisions field is null, not an empty result", res.decisions === null);
}

// 3. The regression this file exists for.
{
  const { api, calls } = apiWith((method) => {
    if (method === "POST") throw httpError(405);
    return okBody;
  });
  const res = await api.guestMessages(0, [{ clientEventId: "e1" }]);
  check("a 405 does not propagate as a poll failure", res.messages.length === 1);
  check("...the messages arrive anyway, over GET", calls.at(-1).method === "GET");
  check("...and nothing is reported as delivered", res.decisions === null);
}
{
  // A route that does not exist at all answers 404 rather than 405.
  const { api } = apiWith((method) => {
    if (method === "POST") throw httpError(404);
    return okBody;
  });
  const res = await api.guestMessages(0, [{ clientEventId: "e1" }]);
  check("a 404 is treated the same way", res.messages.length === 1);
}
{
  // Once is enough. Retrying the POST on every poll for the life of the process would double
  // every request against a deployment that is never going to accept it.
  const { api, calls } = apiWith((method) => {
    if (method === "POST") throw httpError(405);
    return okBody;
  });
  await api.guestMessages(0, [{ clientEventId: "e1" }]);
  await api.guestMessages(0, [{ clientEventId: "e1" }]);
  await api.guestMessages(0, [{ clientEventId: "e1" }]);
  check("the unsupported deployment is remembered", calls.filter((c) => c.method === "POST").length === 1);
  check("...and the polls keep working", calls.filter((c) => c.method === "GET").length === 3);
}

// 4. Real failures must still be real. Swallowing a 500 would hide an outage behind a
//    successful-looking poll, which is the opposite of what this is for.
{
  const { api } = apiWith((method) => {
    if (method === "POST") throw httpError(500);
    return okBody;
  });
  let threw = false;
  try { await api.guestMessages(0, [{ clientEventId: "e1" }]) } catch { threw = true }
  check("a 500 on upload still fails the poll", threw === true);
}
{
  const { api } = apiWith((method) => {
    if (method === "POST") throw httpError(401);
    return okBody;
  });
  let threw = false;
  try { await api.guestMessages(0, [{ clientEventId: "e1" }]) } catch { threw = true }
  check("a rejected key still fails the poll", threw === true);
}

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
if (failed) {
  console.error(`\nUPLOAD-COMPAT-FAILURES: ${failed}`);
  process.exit(1);
}
console.log(`\nUPLOAD-COMPAT-OK (${checks.length} checks)`);
