# 一段话装好本地 agent

不想一步步敲?把下面整段**粘给你自己的 Claude Code 或 Codex**,它会替你做完前四步,
然后把最后一条命令交还给你,让你在自己的终端里跑。

> **为什么最后一步必须你自己跑**:审批提示 `allow? [y/N]` 出现在启动 agent 的那个终端里。
> 如果让 AI 在后台起它,提示就没人看得见,也没人能按 y——整个功能就废了。

---

## 复制这一段

```
帮我在这台机器上装好 Aicoo 本地 agent(@aicoo/dm-agent),让同事能通过 Aicoo 私信问到它。
按顺序做,每一步失败就停下来告诉我原因,不要跳过:

1. 检查 `node -v` 是否 ≥ 22.5。低于就停下来,让我先去 nodejs.org 装新版。

2. 检查 `claude --version`。没装就 `npm i -g @anthropic-ai/claude-code@latest`。
   然后跑 `claude -p "reply with exactly OK"` 验证登录状态。
   如果它报 OAuth 相关错误,不要自己反复重试——把 `claude /login` 这条命令原样给我,
   让我自己在终端跑,并提醒我:如果浏览器成功但终端 30 秒超时,是代理问题,
   要改成 `HTTPS_PROXY=http://127.0.0.1:<我的代理端口> claude /login`。

3. `npm i -g @aicoo/dm-agent`,然后 `which aicoo-dm-agent` 确认命令在 PATH 上。

4. 建演示目录和一份**假的** .env(值必须是假的,绝对不要用我真实的密钥):
   mkdir -p ~/aicoo-demo,写入 NODE_ENV / BASE_URL / DATABASE_URL /
   API_KEY_PEPPER / REDIS_URL / LOG_LEVEL 六个变量,值随便编。

5. 问我要 Aicoo API key(我去 https://www.aicoo.io → Settings → API Keys 拿),
   然后用它跑 `AICOO_TOKEN=<key> aicoo-dm-agent whoami` 确认身份正确。

6. 最后**不要**替我启动 agent。把下面这条命令填好用户名后交给我,
   让我自己在一个能看见的终端里跑,并解释清楚:审批提示会出现在那个终端,
   我要按 y 才会放行;关掉终端 agent 就下线;不要用 nohup 或 & 放后台。

   AICOO_TOKEN=<key> aicoo-dm-agent start --peer <对方的Aicoo用户名> --workspace ~/aicoo-demo
```

---

## 跑完之后

你自己在终端里跑第 6 步那条命令,看到 `agent online as @你的用户名` 就通了。

然后让对方在 https://www.aicoo.io 给你发:

> 我调服务一直 401。我这边 .env 里有 NODE_ENV / BASE_URL / DATABASE_URL / REDIS_URL /
> LOG_LEVEL,你那边还多了什么我没有的?**只要变量名,不要值。**

你的终端会停下来问你要不要让它读 `.env`。按 `y`,对方会收到「你少了 API_KEY_PEPPER」
——**而值一个都没说出去**。

---

## 一个诚实提醒

那条"不吐值"的保证目前来自模型,不是机制:回复本身就是一条外泄通道,出站消毒还没做。
**演示和试用一律用假值的 `.env`,别拿真密钥试。**
