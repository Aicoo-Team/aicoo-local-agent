# 一段话装好本地 agent

> 真正该用的版本在产品里:**Integrations → Connect your agent → Local agent**,
> 那里会当场发一把 key 并直接写进提示词。这一页是同一段提示词、key 留空的版本,
> 用来阅读和改措辞。

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
   如果它报 OAuth 相关错误,不要自己反复重试。先帮我判断需不需要代理:跑
   `curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages`,
   如果是 403,说明网络层被拦,那么登录和第 5 步启动**都**要带
   `HTTPS_PROXY=http://127.0.0.1:<我的代理端口> HTTP_PROXY=同上`。只在登录时加不够。
   然后把 `claude /login` 这条命令原样给我,让我自己在终端跑。

3. `npm i -g @aicoo/dm-agent@latest`,然后问我要 Aicoo API key
   (我去 https://www.aicoo.io → Settings → API Keys 拿),
   用 `AICOO_TOKEN=<我的key> aicoo-dm-agent whoami` 确认命令和 key 都没问题。

4. 先确认对方真能找到我——没连上之前他根本打不开我的 agent,agent 会在线但一句
   也收不到。问我要对方的 Aicoo **用户名**(是用户名,不是邮箱),然后:

   `AICOO_TOKEN=<我的key> aicoo-dm-agent connect --peer <对方的Aicoo用户名>`

   如果显示请求已发出,告诉我要对方先去 https://www.aicoo.io 接受。

5. 问我要共享这台机器上的**哪个目录**。不要自己建,也不要猜——应该是一个本来就
   有东西可问的目录。然后放到后台起,它自己写日志,不需要我盯着任何窗口:

   AICOO_TOKEN=<我的key> nohup aicoo-dm-agent start --peer <对方的Aicoo用户名> --workspace <我指定的目录> --state-dir ~/.aicoo-dm-agent/<对方的Aicoo用户名> --approve-timeout 900 > /dev/null 2>&1 &

   起完读一下 ~/.aicoo-dm-agent/<对方的Aicoo用户名>/agent.log,告诉我有没有出现
   `api.anthropic.com reachable` 和 `agent online`。没起来的话日志里写了原因,
   照原话告诉我,不要绕过去。要停就 `kill <pid>`,pid 在同目录的 agent.lock 里。

6. 然后**替我盯着这个日志**——这才是整套设置的意义,我不该自己去翻日志:

   tail -n 0 -F ~/.aicoo-dm-agent/<对方的Aicoo用户名>/agent.log | grep -E --line-buffered "inbound #|inbound guest #|\[approval\] PENDING|^ +path: |^ +asked by: |reply sent|giving up|FATAL:"

   - 有人问了什么,直接告诉我。
   - 出现审批时,把工具、确切的路径或命令、以及**那行有没有写 OUTSIDE 我共享的目录**
     摆给我看,然后停下来等我。
   - 我答了之后你再跑:
     `aicoo-dm-agent approve <id> --allow`(或 `--deny`)`--state-dir ~/.aicoo-dm-agent/<对方的Aicoo用户名>`
   - **绝对不要替我做决定,也不要猜我会说什么。**我不答的话它十五分钟后自己拒绝,
     那是安全的结果;猜不是。

7. 最后告诉我该跟对方说什么:让他在 Aicoo 里打开**我的 agent**,不是普通私信,
   然后问那个目录相关的问题。回复只能写进 agent 那条线,发普通私信他会一直等不到。
   我的云端 agent 也会在同一条线里回,来自这台机器的那条带 🖥️ 标记。
```

---

## 跑完之后

你自己在终端里跑第 5 步那条命令,看到 `agent online as @你的用户名` 就通了。

然后让对方在 https://www.aicoo.io 给你发:

> 我调服务一直 401。我这边 .env 里有 NODE_ENV / BASE_URL / DATABASE_URL / REDIS_URL /
> LOG_LEVEL,你那边还多了什么我没有的?**只要变量名,不要值。**

你的终端会停下来问你要不要让它读 `.env`。按 `y`,对方会收到「你少了 SERVICE_API_TOKEN」
——**而值一个都没说出去**。

---

## 一个诚实提醒

"不吐值"现在有机制托底了,但要知道它的边界在哪。回复离开这台机器之前,`redact.js`
会把共享目录里 env 形态文件中赋的值收集起来——变量名看着敏感的(`*TOKEN`、`*KEY`、
`*SECRET` 等),或者值本身是带账号密码的 URL——再加上你自己的 Aicoo key,
然后把回复里任何**原样出现**的地方换成 `[redacted: value from .env]`。
所以逐字引用会被拦住,无论它是从哪条路进来的,包括声明命令打出来的堆栈。

拦不住的是模型**改写过**的值:拼出来、base64、一个字符一个字符地描述。
精确匹配对这些没有办法,回复本身仍然是一条通道。
**演示和试用一律用假值的 `.env`,别拿真密钥试。**
