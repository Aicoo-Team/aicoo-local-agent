# c2c / dm-agent 本周记录 (demo 数据)

- 2026-08-03: 决定并行验证「聊天轨」方案 —— 传输借用 Aicoo DM 管线,
  发明只留在 owner 审批门和本地 runtime 控制层。
- MVP 语义: 收到消息 -> 需要工具则挂起 -> owner 批准 -> 拿到结果 -> 回复。
- 三面硬墙: 只有 Read/Glob/Grep;路径 realpath 圈在 workspace;其余工具启动时禁用。
- 防回环: 回复以 senderType=agent 入库,客户端只处理 senderType=human。
