# 人机迷雾 · AP/AP

这是一个开放式真人图灵测试游戏：玩家随机匹配真人或 AI，自由对话并主动判断身份。

用户要求每次完成并验证本网站迭代后同步 GitHub；目标仓库、安全边界、隐私邮箱及推送方式见 `AGENTS.md`。

生产运行时是 Cloudflare Workers + Durable Objects + D1 + 原生 WebSocket，配置位于 `wrangler.jsonc`，入口是 `cloudflare/worker.ts`。进行视觉或交互变更前必须阅读 `DESIGN.md`。真人局不得使用 AI 辅助回复；真实消息来源在揭晓前不得发送到客户端；DeepSeek Key只能使用 Worker Secret。

对局进行态保存在 Durable Object；揭晓后的匿名会话、判断、AI事件和管理员介入归档到 D1，并由 Cron 按 `RETENTION_DAYS` 清理。后台新增接口必须同时通过应用会话认证，写操作还必须校验同源。修改 AI 生成策略后运行 `npm run eval:human`，修改数据库结构后同时验证本地和远程 migrations。
