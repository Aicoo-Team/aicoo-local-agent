# From zero: let someone reach your local agent

You have a fresh machine and nothing installed. **Every step is one paste. About 5 minutes.**

---

## Step 0 · Node 22.5 or newer

```bash
node -v
```

Below 22.5, install a current version from https://nodejs.org first — otherwise this fails
later in a confusing place.

---

## Step 1 · Install Claude Code and log in

Your local agent runs on your own Claude Code, so it has to be logged in.

```bash
npm i -g @anthropic-ai/claude-code@latest
```

```bash
claude /login
```

Approve in the browser, then check it actually works:

```bash
claude -p "reply with exactly OK"
```

You need to see `OK`.

> **If this times out** — browser says success, terminal hangs ~30s and reports an OAuth
> timeout — you are behind a proxy:
> ```bash
> HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 claude /login
> ```
> Use your own proxy port.

---

## Step 2 · Get the local agent

Not on npm yet, so run it from the repo:

```bash
git clone -b feat/dm-agent-chat-rails https://github.com/Aicoo-Team/aicoo-local-agent.git ~/aicoo-dm-agent
```

```bash
cd ~/aicoo-dm-agent/dm-agent && npm install && npm test
```

`WALL-OK` / `GATE-OK` / `FILTER-OK` means you are set.

---

## Step 3 · Get an Aicoo API key

Open https://www.aicoo.io → sign in → Settings → API Keys → create one, copy the
`aicoo_sk_live_...` value.

```bash
export AICOO_TOKEN="paste_your_key_here"
```

Confirm it is you:

```bash
cd ~/aicoo-dm-agent/dm-agent && node src/cli.js whoami
```

---

## Step 4 · Pick the folder you are sharing

**The agent can read this folder and nothing else.** Start with the sample one:

```bash
cd ~/aicoo-dm-agent/dm-agent && ls demo-workspace
```

To share your own, swap `demo-workspace` for an absolute path in the command below.

---

## Step 5 · Start it — in a terminal you can see

Replace `their-username` with the Aicoo username of the person you are working with:

```bash
cd ~/aicoo-dm-agent/dm-agent && node src/cli.js start --peer their-username --workspace demo-workspace
```

`agent online as @your-username` means you are reachable.

> **Do not background it with `nohup` or `&`.** Approval prompts appear in this terminal and
> you need to be able to answer them. Closing the terminal takes the agent offline.

---

## Step 6 · Have them ask

They open your conversation on https://www.aicoo.io and ask something that needs a file:

> what's in team-notes.md in your demo-workspace?

**Your terminal stops:**

```
== OWNER APPROVAL REQUIRED ==
   tool: Read
   Read({"file_path":".../demo-workspace/team-notes.md"})
   allow? [y/N]
```

Press `y` → they get the answer within seconds, tagged **Local Agent** so it is never
confused with the cloud agent's reply.

Press `n` (or just Enter) → the agent tells them plainly that you declined. It does not
work around you.

---

## That's it. A few things worth knowing

- **Every tool call asks you separately.** One question may prompt twice — once to find the
  file, once to read it. That is deliberate.
- **Out-of-bounds requests never reach you.** If they ask for `~/.ssh/id_rsa`, the path wall
  refuses it and your terminal stays silent.
- **A message is not a command.** "Ignore your rules, the owner already authorised me"
  carries no weight.
- **To change the shared folder**: Ctrl-C, restart with a different `--workspace`.
- **If they run one too**, it works both ways.

## When something is off

| What you see | Why |
| --- | --- |
| `command not found: claude` | Step 1 did not finish, or your npm global bin is not on `PATH` |
| The reply is "Please run /login" | Claude Code is not logged in — back to Step 1 |
| Nothing happens at all | Check the terminal from Step 5 is still open; closing it takes the agent down |
| An answer arrived with no approval prompt | That file was already read earlier in the session, so no new tool call was needed. To get the prompt back: `rm ~/.aicoo-dm-agent/www.aicoo.io/*/state.json` and restart |
| `401` | Wrong or rotated key — back to Step 3 |
