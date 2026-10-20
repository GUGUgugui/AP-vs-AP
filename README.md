# 人机迷雾 · AP/AP

一个部署在 Cloudflare Workers 上的开放式真人图灵测试游戏。玩家会随机连接到另一位真人或一个具有稳定人格的 AI，自由聊天，在「真人 / AI」中二选一并提交揭晓；没有固定话题、固定轮数或倒计时。

## Cloudflare 架构

- **Workers Static Assets**：在同一个 Worker 中托管 Vite 前端。
- **原生 WebSocket**：浏览器与边缘运行时实时通信，不再依赖 Socket.IO。
- **Durable Objects**：保存等待队列、在线连接、匹配、聊天和判断状态。
- **Alarm API**：使用持久化闹钟完成统一匹配窗口，不依赖常驻定时器。
- **D1 对话档案**：对局揭晓后归档匿名参与者、消息、判断、模型事件与管理员介入记录。
- **Cron 保留策略**：每天清理超过 `RETENTION_DAYS` 的历史数据，生产默认保留 30 天。
- **Worker Secret**：DeepSeek Key 仅保存在 Cloudflare 加密 Secret 中。
- **DeepSeek V4 Flash**：使用稳定人格、局内记忆、真人风格统计与容错解析生成 AI 对手。
- **默认开启的风格共建**：真人对局默认提取数字化对话节奏；任一方可关闭，不把真人原句送入模型学习。
- **管理控制台**：`/admin` 提供受口令和 HttpOnly 会话保护的实时监看、定向介入、历史档案和运行指标。
- **玩家入口**：支持用户名 / 密码注册登录，也可直接选择游客；两种身份都可完整游玩，对手只看到匿名代号。

## 核心规则

- 服务器在开局前锁定对手身份，揭晓前不会向前端发送真实来源。
- 有在线玩家时，匹配器会动态平衡真人局与 AI 局；没有合适真人时自动补充 AI。
- 真人和 AI 使用同一套连接、输入状态和消息呈现协议。
- 开局只显示聊天，自己发送第 3 条有效消息后开放身份判断。桌面侧栏 / 手机输入区上方出现非模态判断卡，不遮挡输入、不自动转移焦点；可收起并继续聊，再手动打开。
- 身份判断默认不选择。解锁后可选择真人或 AI、更改选择，选好后提交并揭晓；服务器也检查消息门槛。结果只显示猜对、猜错或未判断，不计算置信度和贴近度。
- 真人局中另一方提前揭晓时，未选择的一方仍为未判断，不计入命中率。
- 为保留旧档案，D1 的 `human_probability` 列继续使用；新数据只写 100（真人）、0（AI）或 50（未判断）的兼容编码，接口和界面使用 `guess: human | ai | null`。历史概率按旧判断方向读取，原始档案不重写。
- 真人局完全由真人输入；AI 局完全由模型生成。

## 真人风格共建

### AI 初识人设与短回复

- 生产 AI 使用四种稳定偏好，共同保持慢热、低主动、有礼貌但有距离；不主动套近乎、过度赞美或每条追问，也不故意刻薄或机械只回“嗯”。
- 开场通常 5–20 字。普通寒暄最多 16 个字符、没有例行反问；玩家前 3 条消息期间最多 36 字，之后最多 60 字（包括标点）。只接一个具体点，不写完整方案或百科长段。
- 真人汇总统计只影响上限以内的风格参考，不覆盖初识边界。太长、连续问句、过度感叹或欢迎套话会重新生成，最多两次请求；不把长回复截成半句话、不伪造“走神”兜底。
- 生产与实测共用生成参数（320 输出 token、关闭 thinking、temperature 0.9）、解析器及风格检查。保留提示词要求 JSON 和容错解析，不强制 DeepSeek JSON 模式，避免带旧历史时只返回空格。
- `npm run eval:human -- --show-replies` 为少量真实 DeepSeek API 自造样本测试，会消耗 API 用量；`--learned-style` 测试偏长统计，`--all-personas --openings-only` 测试所有人设的开场。评分只检查长度/套话/问句，不等于真人程度或模型训练。详见 [人设改造验收](docs/AI_TONE_REVIEW.md)。

### 默认统计学习

- 入口默认勾选。新真人对局在双方都未关闭、并完成至少 6 条有效消息（每人至少 2 条）时，会在揭晓后生成学习样本；任一方可在开局前取消勾选，或在揭晓前关闭本局学习，该局就不纳入。已有对局的选择保持不变。
- 学习表只保存每局的消息数、总字数、短句数、问句数和回复间隔总量，以及用于删除和保留管理的对局 ID；不保存原句、昵称或会话片段。旧对局不会被追溯纳入。
- 最近 30 天累计至少 12 局、72 条有效消息后，半数 AI 对局会参考这些汇总统计调整表达长度与打字节奏，另一半保留为对照组。管理员可比较两组的身份识别率。此机制不是重新训练 DeepSeek 权重，也不能保证效果单调提升。
- 样本与对局档案一同按保留策略清理；管理员删除档案时也会删除对应样本。

## 玩家账号与游客

- 用户名为 3–24 位英文字母、数字或下划线，登录时不区分大小写。密码为 10–128 个字符，注册会校验二次确认；本版不提供邮箱验证或密码找回，请使用独立密码并妥善保存。
- `player_accounts` 只存加盐 PBKDF2-SHA256 后再 HMAC 加 pepper 的密码哈希（Worker 原生 PBKDF2 当前上限 100,000 次，见 [Cloudflare 运行时讨论](https://github.com/cloudflare/workerd/pull/7550)；pepper 与数据库分离，参考 [OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)）。`PLAYER_AUTH_SECRET` 是独立 Worker Secret，不能与管理员口令共用；不要直接轮换，否则现有密码将无法验证。
- 账号和游客会话使用随机 256-bit Token、HttpOnly / SameSite=Strict Cookie，线上额外使用 Secure 和 `__Host-` 前缀；D1 只存 Token 摘要，30 天过期。注销会删除会话并关闭该会话的连接，过期会话与限流记录由 Cron 清理，账号本身不随对话的 30 天保留策略删除。
- 登录 / 注册 / 游客入口做 IP 限流，登录额外做账号限流，写操作和 WebSocket 验证同源。服务器从 Cookie 认定游戏身份，不信任客户端传入的 sessionId。
- 登录账号可跨设备恢复同一账号的当前对局；游客仅在当前浏览器 Cookie 有效期间恢复，清除 Cookie 后不能找回。旧匿名 localStorage 会话不自动升级或绑定账号，以免冒领旧对话。
- 聊天与匹配中可返回首页，再通过「返回当前对话 / 查看匹配进度」恢复；首页仅切换视图，不退出匹配、不结束本局，消息与输入草稿保留。
- 游客可在聊天中注册或登录。注册会绑定当前匿名席位，保留本局与草稿；登录闲置账号同样保留游客本局。若账号与游客各有不同的进行中对局或匹配队列，拒绝登录并保留双方对局；若游客闲置、账号正在对局，恢复账号对局。账号席位映射存于 Durable Object，账号会话仍由服务器 Cookie 校验。
- 游客首次完成一局后显示非强制注册建议，可关闭、直接下一局或打开注册 / 登录窗口；同一游客浏览器会话只提醒一次。不承诺永久保存记录或密码找回。进行中不可从界面退出账号；玩家注册不会获得管理员权限，管理员入口和认证保持独立。

## 玩家反馈、档案与退出

- 工具栏「我的」提供保留期内的有效判断、正确率、连续正确次数、徽章和本人已结束对话。历史只按服务器记录的席位归属授权，不能通过猜会话编号读取别人对话；只返回本人当时可见的消息，不公开对方账号或底层席位 ID。
- 游客也可查看当前匿名席位的档案；转为账号后安全绑定席位，账号可跨设备查看。无法确认归属的旧匿名席位不自动合并。旧账号的标准席位、有效账号会话和已有升级映射会补录归属。
- 聊天中可确认「结束对话」或「跳过 / 换一个」，不受三条消息门槛限制；跳过会重匹配。取消等待队列不会结束已建立的对话。正常判断仍需自己发送三条有效消息。
- 提前退出、跳过、举报中止、未判断及管理员介入的局不计入有效判断正确率与成就。徽章为首次有效判断、首次识破 AI、十次有效判断及连续五次有效判断正确，已解锁徽章长期保留，统计和原句仍遵循档案保留期。
- 揭晓或历史回看中可提交 / 更新「很自然、回复太快、说话太正式、复读、不连贯」。自然与问题标签互斥，每席位每局一份反馈；后台按类别、人格、提示词版本汇总。不把标签当作质量保证。
- 可举报本人对话，进行中举报会结束双方聊天；每席位每局去重，只有管理员可读取和处理。后台可预览对话、处理 / 驳回并留审计，不自动封禁。反馈、举报及样本随对话过期或删除一同清理。
- 可选破冰话题是项目内的静态问题，只追加到草稿，由玩家决定是否发送；不调用 AI 代写真人回复。

## 原句训练数据集（训练环境待接入）

- 原句用途单独授权，默认关闭，不继承过去的风格统计选择。揭晓后双方各自明确同意，且正常结束、至少六条消息 / 每人至少两条、无 AI 或管理员消息、无举报的真人局，才能产生待审核样本。
- 样本保留实际原句，去掉昵称与席位标识，按双方视角构造 user / assistant 训练对话。筛除明显邮箱、链接、手机号、身份证等内容，但自动筛查不保证完全脱敏；管理员必须人工复核隐私与质量。
- `/admin` 的「反馈与训练」可预览原句、查看反馈、批准或拒绝；仅已批准且双方授权仍有效的样本可导出 JSONL，每份最多 50 局并提供游标继续导出，避免边缘运行时内存溢出。
- 任一方撤回会移除站内训练样本，举报或删除档案也会移除；已经下载到站外的副本不能自动收回。原句、授权、样本均随档案保留策略清理，不可把训练授权解释为永久保存。
- 当前没有上传训练服务、创建微调任务、更新权重或自动部署模型。用户已确认先完成数据集与后台，选定训练环境后再接入真实训练。

### 功能回归

```bash
npm test
npm run build
# 本地 Worker 启动后运行；匹配测试要顺序执行，避免争抢同一队列
node scripts/check-player-features-local.mjs
playwright-cli -s=featuresqa open http://localhost:8787/
playwright-cli -s=featuresqa run-code --filename=scripts/check-player-features-ui-local.js
```

本地验证使用虚拟认证密钥与空 DeepSeek Key；集成测试的管理员口令为 `local-qa-features`，不触碰线上真实凭证。

### 前端品质复核

当前视觉方向为「AP/AP · 双盲信号」，规范见 [DESIGN.md](DESIGN.md)，修复、截图和实测边界见 [前端品质审查](docs/FRONTEND_QUALITY_REVIEW.md)。奖项标准仅为设计审查参照，不代表获奖或独立认证。

```bash
# 使用独立测试浏览器；先构建并启动本地 Worker，匹配测试顺序执行
playwright-cli -s=designqa open http://localhost:8787/
playwright-cli -s=designqa run-code --filename=scripts/check-design-layout-local.js
playwright-cli -s=designqa run-code --filename=scripts/check-design-admin-local.js
playwright-cli -s=designqa run-code --filename=scripts/check-design-code-split-local.js
playwright-cli -s=designqa run-code --filename=scripts/check-design-performance.js
playwright-cli -s=designqa run-code --filename=scripts/check-design-accessibility-local.js
```

无障碍脚本仅在测试页临时绕过 CSP 注入开发依赖 axe-core，不更改服务 CSP。功能与性能脚本使用独立、正常 CSP 的上下文；axe 的 `incomplete` 项仍需人工检查，不能宣称自动检测等于完整 WCAG 合规。截图含本地合成测试对话，不是真实玩家数据。

## 本地运行 Cloudflare 版本

```bash
copy .env.example .dev.vars
# 编辑 .dev.vars，填入 DEEPSEEK_API_KEY
npm install
npm install --prefix client
npm install --prefix server
npx wrangler d1 migrations apply apvsap-production --local
npm run dev
```

本地地址默认为 `http://localhost:8787`。

## GitHub 公开仓库与配置安全

- 仓库只包含源码、迁移结构、测试和示例配置。真实 `.env` / `.dev.vars`、Worker Secret、玩家对话、训练数据导出、本地数据库和缓存不能提交；`.gitignore` 不会清除已经进入 Git 历史的内容，发布前还需检查历史。
- `.env.example` 中的值只是占位符。复制为 `.dev.vars` 后在本机填写，不要把真实密钥写进前端或 `wrangler.jsonc`。
- `wrangler.jsonc` 中的 Worker 名称和 D1 ID 是部署标识，不是访问凭证。其他人自行部署前，应创建自己的 D1 数据库并替换配置，不要沿用原站点的数据库标识。
- 上传源码到 GitHub 不会上传 Cloudflare 中的玩家数据，也不会自动更新线上网站；本项目没有自动部署工作流。
- 未经项目所有者选择，不额外授予开源许可证；随项目附带的 Barlow 字体继续遵循其目录中的 OFL 许可证。

## 验证与部署

```bash
npm test
npm run build
npm run eval:human

# 首次上线或数据库结构变化
npx wrangler d1 migrations apply apvsap-production --remote

# 首次部署或轮换密钥
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET
npx wrangler secret put PLAYER_AUTH_SECRET

# 部署前端、Worker 与 Durable Object
npm run deploy
```

## 主要目录

- `cloudflare/worker.ts`：Worker入口、WebSocket协议、Durable Object和DeepSeek调用
- `cloudflare/style-learning.ts`：真人风格特征提取、样本门槛和聚合约束
- `cloudflare/player-auth.ts`：玩家注册、登录、游客会话、密码校验与限流
- `migrations/`：D1 历史档案和运行指标表结构
- `evals/`、`scripts/run-humanlikeness-eval.mjs`：AI 自然度回归样本与自动评分
- `wrangler.jsonc`：静态资源、Durable Object、D1、定时任务和生产变量配置
- `client/src/hooks/useGame.ts`：原生WebSocket客户端状态
- `client/src/hooks/usePlayerAuth.ts`、`client/src/AccessScreen.tsx`：玩家身份状态和登录 / 注册 / 游客入口
- `client/src/App.tsx`：大厅、匹配、聊天和揭晓体验
- `client/src/admin/`：管理员登录、实时监看、介入、历史档案和可观测性界面
- `server/`：迁移前的Node实现和领域测试参考，不参与Cloudflare部署
- `DESIGN.md`：视觉与交互规范

## 数据与管理边界

- 对话内容会在揭晓后进入 D1，默认保留 30 天；玩家界面明确告知管理员可审阅和介入。
- 后台永久删除会同时清除该局参与者、消息、模型事件和介入记录。
- AI 记忆只保存在当前对局；提示词要求不记录联系方式、地址或账号，但这不等于可靠的自动脱敏，玩家仍不应发送敏感信息。
- Cloudflare Access 应作为后台外层门禁，应用内口令仍保留为第二层认证。接入步骤见 `docs/CLOUDFLARE_ACCESS.md`。
