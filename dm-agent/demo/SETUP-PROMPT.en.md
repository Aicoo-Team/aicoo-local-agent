# Set it up by pasting one prompt

> The version of this prompt to actually use is in the product: **Integrations → Connect
> your agent → Local agent**, which mints a key and writes it into the prompt for you. This
> page is the same prompt with the key left blank, for reading and for editing the wording.

Don't want to type each step? Paste the block below **into your own Claude Code or Codex**.
It sets everything up, starts the agent, and then watches it for you.

> **Why it can watch instead of you**: an approval used to appear only in the terminal that
> started the agent, so backgrounding it left nobody able to answer. Since 0.4.3 every
> question is also written to a file, and either channel can answer it. So the agent that set
> this up can put each decision in front of you wherever you already are — and you never have
> to keep a terminal in view.

---

## Copy this

```
Set up the Aicoo local agent (@aicoo/dm-agent) on this machine so a teammate can reach it
through an Aicoo DM. Work through these in order. If a step fails, stop and tell me why —
do not skip ahead:

1. Check `node -v` is 22.5 or newer. If it's older, stop and tell me to install a current
   version from nodejs.org first.

2. Check `claude --version`. If Claude Code isn't installed, run
   `npm i -g @anthropic-ai/claude-code@latest`. Then verify it is logged in with
   `claude -p "reply with exactly OK"`.
   If that fails with anything OAuth-related, do NOT retry it in a loop. First run
   `curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages`. A 403
   means the network is refusing the request, and then **both** the login and the Step 5
   start command need `HTTPS_PROXY=http://127.0.0.1:<my proxy port>` and `HTTP_PROXY` set —
   proxying only the login is not enough. Then hand me `claude /login` to run myself.

3. Run `npm i -g @aicoo/dm-agent@latest`, then ask me for my Aicoo API key (Settings → API
   Keys on https://www.aicoo.io) and confirm both work:
   `AICOO_TOKEN=<my key> aicoo-dm-agent whoami` should print my Aicoo identity.

4. Make sure they can actually reach me — until we are connected in Aicoo they cannot open
   my agent at all, and it would sit online answering nothing. Ask me for their Aicoo
   username (their username, not their email), then:

   `AICOO_TOKEN=<my key> aicoo-dm-agent connect --peer <their Aicoo username>`

   If a request was sent, tell me they must accept it at https://www.aicoo.io first.

5. Ask me which folder on this machine they should be able to ask about. Do NOT create one
   and do NOT guess — it should already have something worth asking about. Then start it in
   the background; it keeps its own log, so there is no window for me to keep in view:

   AICOO_TOKEN=<my key> nohup aicoo-dm-agent start --peer <their Aicoo username> --workspace <the folder I name> --state-dir ~/.aicoo-dm-agent/<their Aicoo username> --approve-timeout 900 > /dev/null 2>&1 &

   Read the end of ~/.aicoo-dm-agent/<their Aicoo username>/agent.log and tell me whether it
   reached `api.anthropic.com reachable` and `agent online`. If it refused to start, the log
   says exactly why — tell me what it says, do not work around it. To stop it later I run
   `kill <pid>`; the pid is in agent.lock next to the log.

6. Then WATCH THAT LOG FOR ME. This is the point of the setup — I should never have to go
   and read a log myself:

   tail -n 0 -F ~/.aicoo-dm-agent/<their Aicoo username>/agent.log | grep -E --line-buffered "inbound #|inbound guest #|\[approval\] PENDING|^ +path: |^ +asked by: |reply sent|giving up|FATAL:"

   - When a question comes in, tell me what they asked.
   - When an approval appears, show me the tool, the exact path or command, and whether the
     line says OUTSIDE my shared folders. Then stop and wait for me.
   - When I answer, run `aicoo-dm-agent approve <id> --allow` (or `--deny`)
     `--state-dir ~/.aicoo-dm-agent/<their Aicoo username>`.
   - NEVER decide one for me and never assume what I would say. If I do not answer it denies
     itself after fifteen minutes — that is the safe outcome, and a guess is not.

7. Finally, tell me what to send them: they open MY AGENT in Aicoo — not a plain DM — and
   ask about that folder. Replies can only be written to the agent thread, so a plain DM
   leaves them watching silence. My cloud agent answers there too; the reply from this
   machine is the one tagged 🖥️.
```

---

## After it finishes

Run the step-5 command yourself. `agent online as @your-username` means you are reachable.

Then have your teammate send you this on https://www.aicoo.io:

> I keep getting 401 calling the service. My `.env` has NODE_ENV / BASE_URL / DATABASE_URL /
> REDIS_URL / LOG_LEVEL — what do you have that I don't? **Names only, no values.**

Your terminal stops and asks whether to let it read `.env`. Press `y`, and they get
"you're missing SERVICE_API_TOKEN" — **without a single value leaving your machine**.

---

## One honest caveat

There is now a mechanism behind "no values", but know its edge. Before a reply leaves the
machine, `redact.js` collects the values assigned in env-shaped files inside the granted
folders — those whose variable name reads as sensitive (`*TOKEN`, `*KEY`, `*SECRET`, …) or
whose value is a URL carrying credentials — plus your own Aicoo key, and replaces any exact
occurrence with `[redacted: value from .env]`. So a verbatim quote is caught, whatever route
it took, including a stack trace from a declared command.

What it does not catch is a value the model *transforms*: spelled out, base64'd, described
character by character. Exact matching has no answer to that, and the reply is still a
channel. **Demo and try it with a fake `.env` only — never with real keys.**
