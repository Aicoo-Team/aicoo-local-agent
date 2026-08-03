# dm-agent 近期路线 (demo 数据)

1. MVP: H2A 单向 — 人 DM 对方本地 agent,审批后回答。 <- 现在
2. 回复落回同一线程 (需要服务端小改: API-key 写 direct 会话)。
3. active-device lease: 一人多机时只有一台应答。
4. --a2a 模式: senderType=agent 互通 + 深度上限。
5. SSE 推送替代轮询 (服务端已有事件层可借)。
