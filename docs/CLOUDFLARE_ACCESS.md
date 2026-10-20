# Cloudflare 自定义域名与后台 Access

目标是让玩家站点保持公开，只对同一域名下的 `/admin`、`/admin/api/*` 和 `/admin/ws` 增加 Cloudflare Access。应用内管理员口令与 HttpOnly 会话继续保留，形成两层认证。

## 当前阻塞

截至 2026-08-09，当前 Cloudflare 账户没有 Active Zone，因此不能创建 Worker Custom Domain，也不能为该域名创建路径级 Access Application。不要直接保护 `apvsap.jiawwo11.workers.dev` 的整个 Worker 名称，否则玩家入口也会被要求登录。

## 域名加入账户后

1. 在 Cloudflare 添加或转入一个域名，等待 Zone 状态变为 Active。
2. 选择一个玩家站点主机名，例如 `play.example.com`，把它作为 Worker Custom Domain 绑定到 `apvsap`。
3. 在 Zero Trust 中创建 Self-hosted Access Application，只覆盖该主机名的管理路径：`/admin*`。
4. 创建 Allow policy，只允许管理员邮箱、身份组或一次性 PIN；不要建立绕过全部访客的策略。
5. 检查 `/` 可以匿名访问，`/admin` 会先经过 Access，再进入应用口令登录；验证 `/admin/api/*` 与 `/admin/ws` 同样被覆盖。
6. 最后从未登录浏览器和管理员浏览器各测试一次，避免误锁玩家入口或遗漏 WebSocket。

## Wrangler 配置模板

拿到真实域名后，向 `wrangler.jsonc` 顶层加入以下配置并部署；不要保留示例域名：

```json
"routes": [
  { "pattern": "play.example.com", "custom_domain": true }
]
```

Access 策略属于 Cloudflare Zero Trust，不存放在仓库或 Worker Secret 中。创建完成后记录实际主机名、身份提供商、允许组和应急管理员，不记录个人登录令牌。
