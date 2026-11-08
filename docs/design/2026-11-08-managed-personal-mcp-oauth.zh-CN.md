# Managed 个人 HTTP MCP OAuth

[English](2026-11-08-managed-personal-mcp-oauth.md) | [简体中文](2026-11-08-managed-personal-mcp-oauth.zh-CN.md)

## 状态与依赖

本实现于 2026-11-08 从 `4736349cbe5d60f39251a148ef17df5f764a03bb` 拆出，依赖 PR #16500 的归档/表单安装，与 Runtime Skill 发现相互独立。授权存储、协议、执行身份和 token 交付一起保留。默认关闭的实现和定向测试不构成部署隔离或真实 provider 验收。

复用[英文安装设计](2026-11-07-managed-skills-mcp-self-service.md)和[中文安装设计](2026-11-07-managed-skills-mcp-self-service.zh-CN.md)。本 PR 不增加 Runtime 候选/快照接口、Git/npm 来源获取或新的隔离平台。

## 个人授权模型

用户登录第三方 provider，授权 Managed 以本人身份访问 HTTP MCP resource。grant 属于 actor，不属于 Workspace 服务 settings。不导入 daemon token，不支持个人 stdio 凭据。Session 历史及结果继续沿用 Workspace 阅读权限，授权 UI 必须明确说明可见范围。

一个 Session 的个人绑定属于同一执行 actor。其他有权限的成员可以阅读历史、取消工作或显式移除个人绑定，但不能通过 prompt、审批或执行恢复借用该 actor 的凭据。在建立身份委托协议前，child、channel、automation 和无人值守 wake 拒绝继承个人绑定。

## 存储与版本化配置

在共享 V1 schema 基线及全部 schema/projection/CSI 消费者中增加加密 `ma_mcp_credential` 和到期后失效的一次性 `ma_mcp_oauth_attempt`。grant 绑定 tenant、Workspace、actor、server、provider、resource、scopes、generation 及撤销状态。attempt 绑定发起 actor/server、state/浏览器 nonce 摘要、加密 PKCE verifier/code、到期时间和交换状态。复用 `SecretProtector`；重建可丢弃开发数据库，不增加 V2 migration。

包仅携带非秘密 OAuth 声明。OAuth 包明确要求 schema/compiler 版本 2，普通包仍为版本 1。Session apply 使用 `selectionVersion: 2` 与 `mcpAuthBindings`，effective bundle 通过 format version 2 记录执行 actor。绑定引用不进入共享归档或 Workspace settings。旧 apply 不能静默删除个人绑定。

包/settings pin 改变后，必须对替代 server 显式验证个人绑定。不盲目沿用 grant，也不静默丢弃权威配置中的已撤销绑定。移除授权时应用新的 v2 配置 revision，保留无关 pins。AgentDefinition/新 Session 的包选择不能初始化个人 OAuth；先创建 Session，再显式安装并授权。

## 浏览器授权

采用部署方预注册的 provider/client 配置、固定 redirect URI、PKCE S256 和 resource/scope 校验。本版不支持动态 client 注册。在 `/v1/agents/sessions/{sessionId}/mcp-oauth` 下提供经过认证的 query/start/status/complete/revoke，并同步 WebShell/SDK 契约。

1. 已认证用户携带浏览器 nonce 发起 attempt，最多十分钟到期。
2. 打开 provider 授权页面。
3. 固定 `/oauth/mcp/callback` 校验 state/issuer，暂存加密 code，不依赖 provider 重定向携带 tenant 或 actor 请求头。
4. 原页面使用当前宿主认证身份和浏览器 nonce 完成 attempt。
5. 校验 actor/attempt 归属，单次交换 code，返回非秘密凭据引用。
6. 通过正常 Session 配置 apply 显式绑定该引用。

同一 attempt 的 pending 状态轮询期间，在内存保留已校验的 provider 链接，使弹窗被阻止或关闭后仍有显式恢复入口。不同 attempt 或终态不继承该链接。

callback 页面和日志不包含 code/token。保留 no-store、no-referrer 和严格 CSP 响应头。provider metadata、token endpoint 及重定向遵循部署网络策略；内网目标必须显式允许。预检地址校验不等于连接时 DNS 固定，DNS rebinding/网络强制约束仍需部署证据。

## 执行与 token 边界

在持久化配置提交屏障内确立执行 actor。重新检查命令准入、实际队列分发、审批/恢复和 token 发放，包括启用绑定前已排队的命令。SQL actor 检查留在既有已加锁准入 helper 内，不改变锁顺序。

Managed HTTP adapter 对每个 Streamable HTTP 或 SSE 请求获取当前 access token。交付绑定 Session、精确 server/配置 revision、credential generation 和当前 Runtime lease/owner，并在发放前后检查。refresh token 留在控制面。Runtime 不打开交互登录，授权不可用时明确失败。

采用数据库 refresh lease/CAS，不在访问 provider 的网络调用期间保持长事务。迟到结果不能覆盖已撤销 generation。code 交换或轮换 refresh 的结果未知时要求重新授权，不盲目重试。能证明工具请求尚未发送的拒绝可正常 settle；发送后效果未知仍保持未知。认证恢复不重放结果不明的 MCP 工具调用。

撤销立即阻止后续发放，并尝试撤销 provider grant、退役连接。已发出的 bearer token/开放 stream 仍受 provider 到期/撤销机制约束。显式移除前保持 active 配置为权威；关闭新授权及 token 发放时保留查询、撤销及修复操作。

## 能力与部署门禁

只有配套协议和实现齐备时才声明 `managed-mcp-oauth/1`。配置默认关闭的 `qwen.managed-agent.mcp-oauth`、固定 callback、私有 Runtime token proxy，以及明确允许且通过验收的隔离 tool profiles。池成员能力必须一致。

在部署配置中设置独立的 `qwen.managed-agent.mcp-oauth` bean：

| 属性                           | 类型与默认值     | 含义                                                        |
| ------------------------------ | ---------------- | ----------------------------------------------------------- |
| `enabled`                      | boolean，`false` | 仅在完成验收后允许新个人授权及 token 发放                   |
| `callback-uri`                 | string，未设置   | 以 `/oauth/mcp/callback` 结尾的固定外部 URI                 |
| `runtime-token-proxy-base-url` | string，未设置   | 私有 Broker token 交付 origin，使用 HTTPS 或允许的回环 HTTP |
| `isolated-tool-profiles`       | string 列表，空  | 独立验收过的执行 profile 的明确 allowlist                   |
| `providers`                    | YAML map，空     | 按公开 provider ID 索引的预注册 provider                    |

provider 条目声明 `issuer`、`resource-uri`、`resource-metadata-uri`、`authorization-metadata-uri`、`authorization-endpoint`、`token-endpoint`、`client-id` 和 `scopes`。metadata 必须匹配配置的 issuer/resource/endpoints，并声明 S256。如果声明 token endpoint 支持的认证方式，其中必须包含所配置的 client 认证方式。`revocation-endpoint` 和 `client-secret` 可选；有 secret 时使用 `client_secret_post`，public client 使用 `none`。`allow-private-network` 与 `allow-insecure-loopback` 默认 false，必须由部署方显式决定。client secret 留在部署配置，不进入包或浏览器 journal。

现有生成配置参考仅处理 `ManagedAgentProperties`；这些独立 bean 的设置在此处及服务端 README 中说明。本次拆分不扩大 Maven metadata processor 的来源选择范围，也不声称已用新编译的 metadata 验证。

只有证明其他 actor 的执行进程无法读取持有 token 的 Hosted 进程、其服务身份或交付通道后，才能启用。目录隔离、owner fencing、cgroup 或同 UID 隔离本身均不构成证明。不支持的 profile 明确拒绝，本 PR 不建设新的隔离平台。

## 验证与评审承接

与新合入 Session 资源诊断的兼容仍不完整：当前持久化资源读取器仅接受 v1 effective bundle，v2 个人绑定配置会显示 `configCoverage: partial`，原因为 `invalid_resource`。完整 v2 资源诊断属于后续范围，本次交付不声称已通过该项验收。

运行受影响的编译器/协议、Hosted 选择/恢复、HTTP token、WebShell 授权/安装测试及 TypeScript build/typecheck。验证 callback 重放、浏览器 nonce、跨 actor prompt/审批/恢复、旧客户端写入、存续连接上的 token 变化、刷新/撤销竞态、worker 替换和未知工具结果。公共 API/SurfaceRegistry 门禁、真实 MySQL、可控 OAuth provider 和真实进程/隔离验收需要匹配 head 的 CI/部署证据。拆分继续共用已耗尽的本地 Java 预算。

保留原 #16500 的评审链接和延期事项。承接事项包括 pin 改变后的绑定复用策略、遗留 refresh lease 需要显式重新授权、已撤销绑定需要显式移除、完整错误响应文档，以及 provider/网络验收。移动代码不解决这些讨论，也不代表完整审查已收敛。日志和指标只记录 operation/阶段/结果标识，不记录 grant、code 或 token。
