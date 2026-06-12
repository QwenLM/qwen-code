# 配置参考

## 概览

把所有会影响 `qwen serve` daemon 与适配器的旋钮（env、CLI 参数、`settings.json` 键）汇总到一页。跨切面参考，单 feature 文档链接到此。

## CLI 参数（`qwen serve`）

| 参数                               | 类型                   | 默认                               | 效果                                                                                                                                             |
| ---------------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--hostname <host>`                | string                 | `127.0.0.1`                        | 监听绑定。loopback 值：`127.0.0.1`、`localhost`、`::1`、`[::1]`。非 loopback 要求 boot 时有 bearer token。错配兜底 `host:port` 形（用 `--port`） |
| `--port <n>`                       | number                 | `4170`                             | 监听端口；`0` = ephemeral                                                                                                                        |
| `--token <s>`                      | string                 | （env）                            | Bearer token，覆盖 `QWEN_SERVER_TOKEN`，boot 时 trim；会出现在进程命令行，部署时优先用 env                                                       |
| `--require-auth`                   | boolean                | `false`                            | bearer 扩展到 loopback + `/health`，无 token 拒启动                                                                                              |
| `--workspace <dir>`                | 绝对路径               | `process.cwd()`                    | 绑定 workspace。必须绝对且为目录；boot 时 canonicalize 一次                                                                                      |
| `--max-sessions <n>`               | number                 | `20`                               | 活动 session 上限。`0` / `Infinity` = 不限；`NaN`/负值抛错                                                                                       |
| `--max-connections <n>`            | number                 | `256`                              | HTTP 监听器的 `server.maxConnections`；`0` / `Infinity` = 不限                                                                                   |
| `--event-ring-size <n>`            | number                 | `8000`                             | per-session SSE 重放环；软上限 `1_000_000`                                                                                                       |
| `--http-bridge`                    | boolean                | `true`                             | Stage 1 桥模式；`--no-http-bridge` 仍会 fallback 到 http-bridge 并打 stderr                                                                      |
| `--mcp-client-budget <n>`          | 正整数                 | （未设）                           | 设 `WorkspaceMcpBudget.clientBudget`，通过 `childEnvOverrides` 传 ACP child                                                                      |
| `--mcp-budget-mode <m>`            | `off`/`warn`/`enforce` | budget 设了默认 `warn`，否则 `off` | 设 `WorkspaceMcpBudget.mode`；`enforce` 需 `--mcp-client-budget`                                                                                 |
| `--allow-origin <pattern>`         | string（可多次）       | （未设）                           | 跨域允许列表，替代默认的 CORS 拒绝策略。`*` 允许任何来源但需 token                                                                               |
| `--allow-private-auth-base-url`    | boolean                | `false`                            | 允许 `/workspace/auth/provider` 安装 localhost / private-network baseUrl；仅本地可信开发场景使用                                                 |
| `--prompt-deadline-ms <n>`         | 正整数                 | （未设）                           | prompt 的服务端 wallclock 上限（ms）。超时 abort 并返错                                                                                          |
| `--writer-idle-timeout-ms <n>`     | 正整数                 | （未设）                           | per-SSE-connection 空闲超时（ms）。无事件发送超过此时间则关闭 SSE 连接                                                                           |
| `--channel-idle-timeout-ms <n>`    | 非负整数               | `0`                                | 最后一个 session 关闭后保持 ACP child 存活的时间（ms）。`0` = 立即回收                                                                           |
| `--session-reap-interval-ms <n>`   | 非负整数               | `60000`                            | session reaper 扫描间隔；`0` = 禁用                                                                                                              |
| `--session-idle-timeout-ms <n>`    | 非负整数               | `1800000`                          | disconnected session 的 idle 回收时间；`0` = 禁用                                                                                                |
| `--rate-limit` / `--no-rate-limit` | boolean                | env / off                          | 启用 per-tier HTTP rate limit；prompt / mutation / read 三档                                                                                     |
| `--rate-limit-prompt <n>`          | 正整数                 | `10`                               | 每窗口 prompt 请求上限；需开启 `--rate-limit`                                                                                                    |
| `--rate-limit-mutation <n>`        | 正整数                 | `30`                               | 每窗口 mutation 请求上限；需开启 `--rate-limit`                                                                                                  |
| `--rate-limit-read <n>`            | 正整数                 | `120`                              | 每窗口 read 请求上限；需开启 `--rate-limit`                                                                                                      |
| `--rate-limit-window-ms <n>`       | 整数 `>= 1000`         | `60000`                            | rate limit 窗口长度；需开启 `--rate-limit`                                                                                                       |
| （无 flag）                        | —                      | —                                  | env `QWEN_SERVE_NO_MCP_POOL=1` 完全禁池                                                                                                          |

## 环境变量

### `runQwenServe` / Express 中间件读

| Env                                 | 作用                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_SERVER_TOKEN`                 | Bearer token，boot 时 trim                                                                                                                |
| `QWEN_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes`（不区分大小写）开启详细 stderr（见 [`19-observability.md`](./19-observability.md)）                           |
| `QWEN_SERVE_NO_MCP_POOL`            | `1` 禁 workspace MCP transport 池（回到 per-session `McpClientManager`；capabilities 不再广播 `mcp_workspace_pool` / `mcp_pool_restart`） |
| `QWEN_SERVE_PROMPT_DEADLINE_MS`     | env fallback for `--prompt-deadline-ms`                                                                                                   |
| `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | env fallback for `--writer-idle-timeout-ms`                                                                                               |
| `QWEN_SERVE_RATE_LIMIT`             | `1` / `true` 开启 per-tier HTTP rate limit；CLI `--rate-limit` / `--no-rate-limit` 优先                                                   |
| `QWEN_SERVE_RATE_LIMIT_PROMPT`      | env fallback for `--rate-limit-prompt`                                                                                                    |
| `QWEN_SERVE_RATE_LIMIT_MUTATION`    | env fallback for `--rate-limit-mutation`                                                                                                  |
| `QWEN_SERVE_RATE_LIMIT_READ`        | env fallback for `--rate-limit-read`                                                                                                      |
| `QWEN_SERVE_RATE_LIMIT_WINDOW_MS`   | env fallback for `--rate-limit-window-ms`                                                                                                 |

### 通过 `BridgeOptions.childEnvOverrides` 转发给 ACP child

`runQwenServe` per-handle 构造，防止同进程两个 daemon 在 `process.env` 上 race：

| Env                              | 作用                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `QWEN_SERVE_MCP_CLIENT_BUDGET`   | 正整数字符串；ACP child 的 `readBudgetFromEnv()` 消费                                  |
| `QWEN_SERVE_MCP_BUDGET_MODE`     | `off` / `warn` / `enforce`                                                             |
| `QWEN_SERVE_MCP_POOL_TRANSPORTS` | comma-separated transport allowlist；默认池化 `stdio,websocket`，可显式包含 `http,sse` |
| `QWEN_SERVE_MCP_POOL_DRAIN_MS`   | 池 entry idle drain 延迟；默认 `30000`，限制在 `1000..600000` ms                       |

### SDK / 适配器读

| Env                     | 作用                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `QWEN_DAEMON_URL`       | daemon base URL（CLI TUI 适配器、channels、IDE companion） |
| `QWEN_DAEMON_TOKEN`     | Bearer token                                               |
| `QWEN_DAEMON_WORKSPACE` | 覆盖 `POST /session` 的 `cwd`                              |

## `settings.json` 键

daemon boot 时读一次（`runQwenServe` 里的 `loadSettings(boundWorkspace)`）。损坏 try/catch 回退默认。

| 键                          | 类型                                                               | 效果                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | 设 `BridgeOptions.permissionPolicy`；激活值出现在 `/capabilities` 的 `policy.permission`。**boot 校验**通过 `validatePolicyConfig()`，对照 `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`；未知字面量抛 `InvalidPolicyConfigError`，boot 显式失败                                                                                                                                                                                                    |
| `policy.consensusQuorum`    | 正整数                                                             | `consensus` 策略的 N。**默认**：`votersAtIssue.size` 的 `floor(M/2) + 1`（M=2 一致同意；更大偶数 M 超过半数）。非 `consensus` 策略下设它会被静默忽略，boot 会打 stderr 警告。非正整数抛 `InvalidPolicyConfigError`。详见 [`04-permission-mediation.md`](./04-permission-mediation.md)                                                                                                                                                                        |
| `context.fileName`          | string                                                             | 覆盖 `getCurrentGeminiMdFilename()`；走 `BridgeOptions.contextFilename`                                                                                                                                                                                                                                                                                                                                                                                      |
| `tools.disabled`            | string[]                                                           | 下次 ACP child spawn 时被禁的 tool；通过 `normalizeDisabledToolList()`（`packages/cli/src/config/normalizeDisabledTools.ts`）归一化：非数组 → `[]`；非字符串项跳过；trim 空白；trim 后空串丢弃；去重（保留首次出现顺序）。boot 路径与 `restartMcpServer` settings 刷新都过这函数，`ToolRegistry.has(name)` 精确匹配才一致。**不**做大小写折叠 —— Stage 1 工具名在 registry 全程大小写敏感。`POST /workspace/tools/:name/enable` 与 `tool_toggled` 事件改这里 |
| `tools.approvalMode`        | `'default' \| 'auto' \| ...`                                       | session 默认 approval mode；`POST /session/:id/approval-mode`（带 `persist: true`）写这里                                                                                                                                                                                                                                                                                                                                                                    |
| `telemetry`                 | object                                                             | OTel 配置段。子键包括 `enabled`、`otlpEndpoint`、`otlpProtocol`、`otlpTracesEndpoint`、`otlpLogsEndpoint`、`otlpMetricsEndpoint`、`target`、`outfile`、`includeSensitiveSpanAttributes`、`resourceAttributes`、`metrics.includeSessionId`。boot 时 `resolveTelemetrySettings()` 读并初始化 `initializeTelemetry()`                                                                                                                                           |

## `ServeOptions`（程序化嵌入）

`packages/cli/src/serve/types.ts` 的 typed options 对象，`runQwenServe` 和 `createServeApp` 都接受。镜像上面 CLI 参数，外加：

| 字段                      | 效果                                               |
| ------------------------- | -------------------------------------------------- |
| `eventRingSize`           | 覆盖默认 per-session 环大小                        |
| `mcpPoolActive`           | 程序化开关（默认从 `QWEN_SERVE_NO_MCP_POOL` 推断） |
| `allowOrigins`            | 跨域允许列表（`string[]`），对应 `--allow-origin`  |
| `allowPrivateAuthBaseUrl` | 允许安装 private / localhost auth provider baseUrl |
| `promptDeadlineMs`        | prompt wallclock 上限                              |
| `writerIdleTimeoutMs`     | SSE writer 空闲超时                                |
| `channelIdleTimeoutMs`    | ACP child 空闲保活时长                             |
| `sessionReapIntervalMs`   | session reaper 扫描间隔                            |
| `sessionIdleTimeoutMs`    | disconnected session idle 回收时间                 |
| `rateLimit*`              | per-tier HTTP rate limit 开关、阈值和窗口          |

## `BridgeOptions`（程序化 bridge 嵌入）

`packages/acp-bridge/src/bridgeOptions.ts`，完整表见 [`03-acp-bridge.md`](./03-acp-bridge.md)。要点：

| 字段                                                                                                                    | 效果                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `boundWorkspace`                                                                                                        | 必填 canonical workspace                                                                      |
| `sessionScope`                                                                                                          | `'single'`（默认）vs `'thread'`                                                               |
| `initializeTimeoutMs`、`maxSessions`、`eventRingSize`、`permissionResponseTimeoutMs`、`maxPendingPermissionsPerSession` | 有界资源 caps                                                                                 |
| `channelFactory`                                                                                                        | 可插拔 ACP child 工厂，默认 `defaultSpawnChannelFactory`                                      |
| `fileSystem`                                                                                                            | `BridgeFileSystem` adapter（见 [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)） |
| `permissionPolicy`、`permissionConsensusQuorum`、`permissionAudit`                                                      | mediator 接线                                                                                 |
| `statusProvider`                                                                                                        | daemon-host preflight cells                                                                   |
| `childEnvOverrides`                                                                                                     | per-handle env 增量 / scrub                                                                   |
| `contextFilename`                                                                                                       | 覆盖 `getCurrentGeminiMdFilename()`                                                           |
| `channelIdleTimeoutMs`                                                                                                  | 最后 session 关闭后保活 ACP child 的时长（ms），默认 `0`                                      |

## 重要默认

| 常量                              | 文件                    | 值                | 意义                                                     |
| --------------------------------- | ----------------------- | ----------------- | -------------------------------------------------------- |
| `DEFAULT_MAX_SESSIONS`            | `bridge.ts`             | `20`              | 每 daemon 抛 `SessionLimitExceededError` 前的上限        |
| `MAX_EVENT_RING_SIZE`             | `bridge.ts`             | `1_000_000`       | `BridgeOptions.eventRingSize` 软上限（错字防御）         |
| `DEFAULT_RING_SIZE`               | `eventBus.ts`           | `8000`            | per-session SSE 重放环深度                               |
| `DEFAULT_MAX_QUEUED`              | `eventBus.ts`           | `256`             | per-subscriber 队列上限                                  |
| `DEFAULT_MAX_SUBSCRIBERS`         | `eventBus.ts`           | `64`              | per-bus 订阅者上限                                       |
| `WARN_THRESHOLD_RATIO`            | `eventBus.ts`           | `0.75`            | `slow_client_warning` 触发                               |
| `WARN_RESET_RATIO`                | `eventBus.ts`           | `0.375`           | 滞回 re-arm                                              |
| `DEFAULT_INIT_TIMEOUT_MS`         | `bridge.ts`             | `10_000`          | ACP `initialize` 握手超时                                |
| `MCP_RESTART_TIMEOUT_MS`          | `bridge.ts`             | `300_000`         | `/workspace/mcp/:server/restart` 的 bridge race deadline |
| `DEFAULT_PERMISSION_TIMEOUT_MS`   | `bridge.ts`             | `5 * 60_000`      | 每权限请求 wallclock                                     |
| `DEFAULT_MAX_PENDING_PER_SESSION` | `bridge.ts`             | `64`              | 对齐 `DEFAULT_MAX_SUBSCRIBERS`                           |
| `MAX_RESOLVED_PERMISSION_RECORDS` | `permissionMediator.ts` | `512`             | 近期已 resolved 权限的 FIFO                              |
| `KILL_HARD_DEADLINE_MS`           | `bridge.ts`             | `10_000`          | per-channel graceful 关闭窗口                            |
| `SHUTDOWN_FORCE_CLOSE_MS`         | `runQwenServe.ts`       | `5_000`           | HTTP server 强关定时器                                   |
| `MAX_READ_BYTES`                  | `fs/policy.ts`          | `256 * 1024`      | 读上限                                                   |
| `MAX_WRITE_BYTES`                 | `fs/policy.ts`          | `5 * 1024 * 1024` | 写上限                                                   |
| `MAX_DISPLAY_NAME_LENGTH`         | `bridge.ts`             | `256`             | session displayName 上限                                 |

## 交叉参考

- Auth 旋钮：[`12-auth-security.md`](./12-auth-security.md)。
- 能力和协议版本：[`11-capabilities-versioning.md`](./11-capabilities-versioning.md)。
- 事件环 / 反压调优：[`10-event-bus.md`](./10-event-bus.md)。
- MCP 池 / 预算：[`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) 与 [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md)。
- 权限策略：[`04-permission-mediation.md`](./04-permission-mediation.md)。
- 用户运维指南：[`../../users/qwen-serve.md`](../../users/qwen-serve.md)。
