# Set it up by pasting one prompt

Don't want to type each step? Paste the block below **into your own Claude Code or Codex**.
It does the first steps for you and then hands the last command back, for you to run in
your own terminal.

> **Why the last step has to be yours**: the approval prompt `allow? [y/N]` appears in
> whichever terminal started the agent. If an assistant starts it in the background, nobody
> can see the prompt and nobody can answer it — which disables the entire feature.

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
   If that fails with anything OAuth-related, do NOT retry it in a loop. Hand me the
   command `claude /login` to run myself, and warn me that if the browser succeeds but the
   terminal times out after ~30s, it's a proxy issue and I should run
   `HTTPS_PROXY=http://127.0.0.1:<my proxy port> claude /login` instead.

3. Run `npm i -g @aicoo/dm-agent`, then `which aicoo-dm-agent` to confirm the command is on
   PATH.

4. Create a demo folder with a FAKE .env — the values must be fake, never my real secrets:
   mkdir -p ~/aicoo-demo and write six variables into ~/aicoo-demo/.env:
   NODE_ENV / BASE_URL / DATABASE_URL / API_KEY_PEPPER / REDIS_URL / LOG_LEVEL,
   with made-up values.

5. Ask me for my Aicoo API key (I'll get it from https://www.aicoo.io → Settings → API
   Keys), then confirm it works with `AICOO_TOKEN=<key> aicoo-dm-agent whoami`.

6. Do NOT start the agent for me. Fill in the username below and hand me this command to
   run in a terminal I can see. Explain that the approval prompt appears in that terminal
   and I have to press y to allow each call; that closing the terminal takes the agent
   offline; and that it must not be backgrounded with nohup or &.

   AICOO_TOKEN=<key> aicoo-dm-agent start --peer <their Aicoo username> --workspace ~/aicoo-demo
```

---

## After it finishes

Run the step-6 command yourself. `agent online as @your-username` means you are reachable.

Then have your teammate send you this on https://www.aicoo.io:

> I keep getting 401 calling the service. My `.env` has NODE_ENV / BASE_URL / DATABASE_URL /
> REDIS_URL / LOG_LEVEL — what do you have that I don't? **Names only, no values.**

Your terminal stops and asks whether to let it read `.env`. Press `y`, and they get
"you're missing API_KEY_PEPPER" — **without a single value leaving your machine**.

---

## One honest caveat

That "no values" guarantee comes from the model today, not from a mechanism: the reply is
itself an exfiltration channel and outbound sanitising is not built yet. **Demo and try it
with a fake `.env` only — never with real keys.**
