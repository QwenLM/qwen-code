# Configuration Reference (English)

## Overview

Single-page reference for every knob that affects the `qwen serve` daemon and its adapters: env vars, CLI flags, and `settings.json` keys. Cross-cutting documentation; the individual feature docs link here.

## CLI flags (`qwen serve`)

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--hostname <host>` | string | `127.0.0.1` | Listener bind. Loopback values: `127.0.0.1`, `localhost`, `::1`, `[::1]`. Non-loopback requires a bearer token at boot. Typo guard rejects `host:port` form (use `--port`). |
| `--port <n>` | integer | `4170` | Listener port. `0` = ephemeral. |
| `--token <s>` | string | (env) | Bearer token; overrides `QWEN_SERVER_TOKEN`. Trimmed at boot. |
| `--require-auth` | flag | off | Extends bearer to loopback + `/health`. Refuses to boot without a token. |
| `--workspace <dir>` | absolute path | `process.cwd()` | Bound workspace. Must be absolute and exist as a directory; canonicalized once at boot. |
| `--max-sessions <n>` | integer | `20` (`DEFAULT_MAX_SESSIONS`) | Cap on live sessions. `0` / `Infinity` = unlimited; `NaN`/negative throws. |
| `--max-connections <n>` | integer | (server default) | `server.maxConnections` on the HTTP listener. |
| `--event-ring-size <n>` | integer | `8000` (`DEFAULT_RING_SIZE`) | Per-session SSE replay ring; soft-capped at `1_000_000` (`MAX_EVENT_RING_SIZE`). |
| `--mcp-client-budget <n>` | positive integer | (unset) | Sets `WorkspaceMcpBudget.clientBudget`. Forwarded to ACP child via `childEnvOverrides`. |
| `--mcp-budget-mode <m>` | `off` / `warn` / `enforce` | (unset) | Sets `WorkspaceMcpBudget.mode`. `enforce` requires `--mcp-client-budget`. |
| (no flag) | — | — | The `QWEN_SERVE_NO_MCP_POOL=1` env var disables the pool entirely. |

## Environment variables

### Read by `runQwenServe` / Express middleware

| Env | Purpose |
|---|---|
| `QWEN_SERVER_TOKEN` | Bearer token; trimmed at boot. |
| `QWEN_SERVE_DEBUG` | `1` / `true` / `on` / `yes` (case-insensitive) enables verbose stderr logging (see [`19-observability.md`](./19-observability.md)). |
| `QWEN_SERVE_NO_MCP_POOL` | `1` disables the workspace MCP transport pool (per-session `McpClientManager` takes over; capabilities envelope drops `mcp_workspace_pool` and `mcp_pool_restart` tags). |

### Forwarded to the ACP child via `BridgeOptions.childEnvOverrides`

`runQwenServe` constructs these per-handle so two embedded daemons in the same process don't race on `process.env`:

| Env | Purpose |
|---|---|
| `QWEN_SERVE_MCP_CLIENT_BUDGET` | Positive integer string; ACP child's `readBudgetFromEnv()` consumes it. |
| `QWEN_SERVE_MCP_BUDGET_MODE` | `off` / `warn` / `enforce`. |

### Read by SDK / adapters

| Env | Purpose |
|---|---|
| `QWEN_DAEMON_URL` | Daemon base URL (CLI TUI adapter, channels, IDE companion). |
| `QWEN_DAEMON_TOKEN` | Bearer token. |
| `QWEN_DAEMON_WORKSPACE` | Override `cwd` on `POST /session`. |

## `settings.json` keys

The daemon loads `settings.json` once at boot (`runQwenServe.ts:496+`) via `loadSettings(boundWorkspace)`. Corruption falls back to defaults (try/catch wraps the load).

| Key | Type | Effect |
|---|---|---|
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | Sets `BridgeOptions.permissionPolicy`. Active value surfaces in `/capabilities`'s `policy.permission`. **Boot-validated** by `validatePolicyConfig()` against `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`; an unknown literal throws `InvalidPolicyConfigError` (boot fails loudly). |
| `policy.consensusQuorum` | positive integer | N for the `consensus` mediator policy. **Default:** `floor(M/2) + 1` of `votersAtIssue.size` (unanimity for M=2; supermajority for larger even M). Setting this under a non-`consensus` strategy is silently ignored — a stderr warning fires at boot. Non-positive-integer values throw `InvalidPolicyConfigError`. See [`04-permission-mediation.md`](./04-permission-mediation.md). |
| `context.fileName` | string | Overrides `getCurrentGeminiMdFilename()`; used by `BridgeOptions.contextFilename`. |
| `tools.disabled` | string[] | Tool names disabled on next ACP child spawn. Normalized through `normalizeDisabledToolList()` (`packages/cli/src/config/normalizeDisabledTools.ts`): non-array → `[]`; non-string entries skipped; whitespace trimmed; empty-after-trim dropped; duplicates de-duped (first-occurrence order preserved). Boot path and `restartMcpServer` settings refresh both call this helper so `ToolRegistry.has(name)` exact-match stays consistent. **Not** case-folded — Stage 1 tool names are case-sensitive throughout the registry. `POST /workspace/tools/:name/enable` and `tool_toggled` event mutate this. |
| `tools.approvalMode` | `'default' \| 'auto' \| ...` | Default approval mode for sessions. `POST /session/:id/approval-mode` (with `persist: true`) writes here. |

## `ServeOptions` (programmatic embed)

`packages/cli/src/serve/types.ts:37-155` exposes the typed options object that `runQwenServe` and `createServeApp` accept. Mirrors the CLI flags above, plus:

| Field | Effect |
|---|---|
| `eventRingSize` | Overrides the default per-session ring size. |
| `mcpPoolActive` | Programmatic on/off (inferred from `QWEN_SERVE_NO_MCP_POOL` by default). |

## `BridgeOptions` (programmatic bridge embed)

`packages/acp-bridge/src/bridgeOptions.ts:88-323`. See [`03-acp-bridge.md`](./03-acp-bridge.md) for the full table. Highlights:

| Field | Effect |
|---|---|
| `boundWorkspace` | Required canonical workspace. |
| `sessionScope` | `'single'` (default) vs `'per-client'`. |
| `initializeTimeoutMs`, `maxSessions`, `eventRingSize`, `permissionResponseTimeoutMs`, `maxPendingPermissionsPerSession` | Bounded resource caps. |
| `channelFactory` | Pluggable ACP child factory; default `defaultSpawnChannelFactory`. |
| `fileSystem` | `BridgeFileSystem` adapter (see [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)). |
| `permissionPolicy`, `permissionConsensusQuorum`, `permissionAudit` | Mediator wiring. |
| `statusProvider` | Daemon-host preflight cells. |
| `childEnvOverrides` | Per-handle env additions / scrubs for the ACP child. |
| `contextFilename` | Overrides `getCurrentGeminiMdFilename()`. |

## Defaults that matter

| Constant | File | Value | Significance |
|---|---|---|---|
| `DEFAULT_MAX_SESSIONS` | `bridge.ts` | `20` | Per-daemon cap before `SessionLimitExceededError`. |
| `MAX_EVENT_RING_SIZE` | `bridge.ts` | `1_000_000` | Soft upper bound on `BridgeOptions.eventRingSize` (typo defense). |
| `DEFAULT_RING_SIZE` | `eventBus.ts:76` | `8000` | Per-session SSE replay ring depth. |
| `DEFAULT_MAX_QUEUED` | `eventBus.ts:63` | `256` | Per-subscriber backlog cap. |
| `DEFAULT_MAX_SUBSCRIBERS` | `eventBus.ts:97` | `64` | Per-bus subscriber cap. |
| `WARN_THRESHOLD_RATIO` | `eventBus.ts:85` | `0.75` | `slow_client_warning` trigger. |
| `WARN_RESET_RATIO` | `eventBus.ts:87` | `0.375` | Hysteresis re-arm. |
| `DEFAULT_INIT_TIMEOUT_MS` | `bridge.ts` | `10_000` | ACP `initialize` handshake timeout. |
| `MCP_RESTART_TIMEOUT_MS` | `bridge.ts` | `300_000` | Bridge race deadline for `/workspace/mcp/:server/restart`. |
| `DEFAULT_PERMISSION_TIMEOUT_MS` | `bridge.ts` | `5 * 60_000` | Per-permission wallclock. |
| `DEFAULT_MAX_PENDING_PER_SESSION` | `bridge.ts` | `64` | Mirrors `DEFAULT_MAX_SUBSCRIBERS`. |
| `MAX_RESOLVED_PERMISSION_RECORDS` | `permissionMediator.ts:77` | `512` | FIFO of recently-resolved permissions. |
| `KILL_HARD_DEADLINE_MS` | `bridge.ts` | `10_000` | Per-channel graceful close window. |
| `SHUTDOWN_FORCE_CLOSE_MS` | `runQwenServe.ts` | `5_000` | HTTP server force-close timer. |
| `MAX_READ_BYTES` | `fs/policy.ts:33` | `256 * 1024` | Read cap. |
| `MAX_WRITE_BYTES` | `fs/policy.ts:42` | `5 * 1024 * 1024` | Write cap. |
| `MAX_DISPLAY_NAME_LENGTH` | `bridge.ts:298` | `256` | Session displayName cap. |

## Cross-references

- Auth knobs: [`12-auth-security.md`](./12-auth-security.md).
- Capabilities and protocol versions: [`11-capabilities-versioning.md`](./11-capabilities-versioning.md).
- Event ring / backpressure tuning: [`10-event-bus.md`](./10-event-bus.md).
- MCP pool / budget: [`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) and [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md).
- Permission policies: [`04-permission-mediation.md`](./04-permission-mediation.md).
- User-facing operator guide: [`../../users/qwen-serve.md`](../../users/qwen-serve.md).

---

# 配置参考 (中文)

## 概览

把所有会影响 `qwen serve` daemon 与适配器的旋钮（env、CLI 参数、`settings.json` 键）汇总到一页。跨切面参考，单 feature 文档链接到此。

## CLI 参数（`qwen serve`）

| 参数 | 类型 | 默认 | 效果 |
|---|---|---|---|
| `--hostname <host>` | string | `127.0.0.1` | 监听绑定。loopback 值：`127.0.0.1`、`localhost`、`::1`、`[::1]`。非 loopback 要求 boot 时有 bearer token。错配兜底 `host:port` 形（用 `--port`） |
| `--port <n>` | int | `4170` | 监听端口；`0` = ephemeral |
| `--token <s>` | string | （env） | Bearer token，覆盖 `QWEN_SERVER_TOKEN`，boot 时 trim |
| `--require-auth` | flag | off | bearer 扩展到 loopback + `/health`，无 token 拒启动 |
| `--workspace <dir>` | 绝对路径 | `process.cwd()` | 绑定 workspace。必须绝对且为目录；boot 时 canonicalize 一次 |
| `--max-sessions <n>` | int | `20`（`DEFAULT_MAX_SESSIONS`） | 活动 session 上限。`0` / `Infinity` = 不限；`NaN`/负值抛错 |
| `--max-connections <n>` | int | （server 默认） | HTTP 监听器的 `server.maxConnections` |
| `--event-ring-size <n>` | int | `8000`（`DEFAULT_RING_SIZE`） | per-session SSE 重放环；软上限 `1_000_000` |
| `--mcp-client-budget <n>` | 正整数 | （未设） | 设 `WorkspaceMcpBudget.clientBudget`，通过 `childEnvOverrides` 传 ACP child |
| `--mcp-budget-mode <m>` | `off`/`warn`/`enforce` | （未设） | 设 `WorkspaceMcpBudget.mode`；`enforce` 需 `--mcp-client-budget` |
| （无 flag） | — | — | env `QWEN_SERVE_NO_MCP_POOL=1` 完全禁池 |

## 环境变量

### `runQwenServe` / Express 中间件读

| Env | 作用 |
|---|---|
| `QWEN_SERVER_TOKEN` | Bearer token，boot 时 trim |
| `QWEN_SERVE_DEBUG` | `1` / `true` / `on` / `yes`（不区分大小写）开启详细 stderr（见 [`19-observability.md`](./19-observability.md)） |
| `QWEN_SERVE_NO_MCP_POOL` | `1` 禁 workspace MCP transport 池（回到 per-session `McpClientManager`；capabilities 不再广播 `mcp_workspace_pool` / `mcp_pool_restart`） |

### 通过 `BridgeOptions.childEnvOverrides` 转发给 ACP child

`runQwenServe` per-handle 构造，防止同进程两个 daemon 在 `process.env` 上 race：

| Env | 作用 |
|---|---|
| `QWEN_SERVE_MCP_CLIENT_BUDGET` | 正整数字符串；ACP child 的 `readBudgetFromEnv()` 消费 |
| `QWEN_SERVE_MCP_BUDGET_MODE` | `off` / `warn` / `enforce` |

### SDK / 适配器读

| Env | 作用 |
|---|---|
| `QWEN_DAEMON_URL` | daemon base URL（CLI TUI 适配器、channels、IDE companion） |
| `QWEN_DAEMON_TOKEN` | Bearer token |
| `QWEN_DAEMON_WORKSPACE` | 覆盖 `POST /session` 的 `cwd` |

## `settings.json` 键

daemon boot 时读一次（`runQwenServe.ts:496+`）：`loadSettings(boundWorkspace)`。损坏 try/catch 回退默认。

| 键 | 类型 | 效果 |
|---|---|---|
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | 设 `BridgeOptions.permissionPolicy`；激活值出现在 `/capabilities` 的 `policy.permission`。**boot 校验**通过 `validatePolicyConfig()`，对照 `SERVE_CAPABILITY_REGISTRY.permission_mediation.modes`；未知字面量抛 `InvalidPolicyConfigError`，boot 显式失败 |
| `policy.consensusQuorum` | 正整数 | `consensus` 策略的 N。**默认**：`votersAtIssue.size` 的 `floor(M/2) + 1`（M=2 一致同意；更大偶数 M 超过半数）。非 `consensus` 策略下设它会被静默忽略，boot 会打 stderr 警告。非正整数抛 `InvalidPolicyConfigError`。详见 [`04-permission-mediation.md`](./04-permission-mediation.md) |
| `context.fileName` | string | 覆盖 `getCurrentGeminiMdFilename()`；走 `BridgeOptions.contextFilename` |
| `tools.disabled` | string[] | 下次 ACP child spawn 时被禁的 tool；通过 `normalizeDisabledToolList()`（`packages/cli/src/config/normalizeDisabledTools.ts`）归一化：非数组 → `[]`；非字符串项跳过；trim 空白；trim 后空串丢弃；去重（保留首次出现顺序）。boot 路径与 `restartMcpServer` settings 刷新都过这函数，`ToolRegistry.has(name)` 精确匹配才一致。**不**做大小写折叠 —— Stage 1 工具名在 registry 全程大小写敏感。`POST /workspace/tools/:name/enable` 与 `tool_toggled` 事件改这里 |
| `tools.approvalMode` | `'default' \| 'auto' \| ...` | session 默认 approval mode；`POST /session/:id/approval-mode`（带 `persist: true`）写这里 |

## `ServeOptions`（程序化嵌入）

`packages/cli/src/serve/types.ts:37-155` 的 typed options 对象，`runQwenServe` 和 `createServeApp` 都接受。镜像上面 CLI 参数，外加：

| 字段 | 效果 |
|---|---|
| `eventRingSize` | 覆盖默认 per-session 环大小 |
| `mcpPoolActive` | 程序化开关（默认从 `QWEN_SERVE_NO_MCP_POOL` 推断） |

## `BridgeOptions`（程序化 bridge 嵌入）

`packages/acp-bridge/src/bridgeOptions.ts:88-323`，完整表见 [`03-acp-bridge.md`](./03-acp-bridge.md)。要点：

| 字段 | 效果 |
|---|---|
| `boundWorkspace` | 必填 canonical workspace |
| `sessionScope` | `'single'`（默认）vs `'per-client'` |
| `initializeTimeoutMs`、`maxSessions`、`eventRingSize`、`permissionResponseTimeoutMs`、`maxPendingPermissionsPerSession` | 有界资源 caps |
| `channelFactory` | 可插拔 ACP child 工厂，默认 `defaultSpawnChannelFactory` |
| `fileSystem` | `BridgeFileSystem` adapter（见 [`07-workspace-filesystem.md`](./07-workspace-filesystem.md)） |
| `permissionPolicy`、`permissionConsensusQuorum`、`permissionAudit` | mediator 接线 |
| `statusProvider` | daemon-host preflight cells |
| `childEnvOverrides` | per-handle env 增量 / scrub |
| `contextFilename` | 覆盖 `getCurrentGeminiMdFilename()` |

## 重要默认

| 常量 | 文件 | 值 | 意义 |
|---|---|---|---|
| `DEFAULT_MAX_SESSIONS` | `bridge.ts` | `20` | 每 daemon 抛 `SessionLimitExceededError` 前的上限 |
| `MAX_EVENT_RING_SIZE` | `bridge.ts` | `1_000_000` | `BridgeOptions.eventRingSize` 软上限（错字防御） |
| `DEFAULT_RING_SIZE` | `eventBus.ts:76` | `8000` | per-session SSE 重放环深度 |
| `DEFAULT_MAX_QUEUED` | `eventBus.ts:63` | `256` | per-subscriber 队列上限 |
| `DEFAULT_MAX_SUBSCRIBERS` | `eventBus.ts:97` | `64` | per-bus 订阅者上限 |
| `WARN_THRESHOLD_RATIO` | `eventBus.ts:85` | `0.75` | `slow_client_warning` 触发 |
| `WARN_RESET_RATIO` | `eventBus.ts:87` | `0.375` | 滞回 re-arm |
| `DEFAULT_INIT_TIMEOUT_MS` | `bridge.ts` | `10_000` | ACP `initialize` 握手超时 |
| `MCP_RESTART_TIMEOUT_MS` | `bridge.ts` | `300_000` | `/workspace/mcp/:server/restart` 的 bridge race deadline |
| `DEFAULT_PERMISSION_TIMEOUT_MS` | `bridge.ts` | `5 * 60_000` | 每权限请求 wallclock |
| `DEFAULT_MAX_PENDING_PER_SESSION` | `bridge.ts` | `64` | 对齐 `DEFAULT_MAX_SUBSCRIBERS` |
| `MAX_RESOLVED_PERMISSION_RECORDS` | `permissionMediator.ts:77` | `512` | 近期已 resolved 权限的 FIFO |
| `KILL_HARD_DEADLINE_MS` | `bridge.ts` | `10_000` | per-channel graceful 关闭窗口 |
| `SHUTDOWN_FORCE_CLOSE_MS` | `runQwenServe.ts` | `5_000` | HTTP server 强关定时器 |
| `MAX_READ_BYTES` | `fs/policy.ts:33` | `256 * 1024` | 读上限 |
| `MAX_WRITE_BYTES` | `fs/policy.ts:42` | `5 * 1024 * 1024` | 写上限 |
| `MAX_DISPLAY_NAME_LENGTH` | `bridge.ts:298` | `256` | session displayName 上限 |

## 交叉参考

- Auth 旋钮：[`12-auth-security.md`](./12-auth-security.md)。
- 能力和协议版本：[`11-capabilities-versioning.md`](./11-capabilities-versioning.md)。
- 事件环 / 反压调优：[`10-event-bus.md`](./10-event-bus.md)。
- MCP 池 / 预算：[`05-mcp-transport-pool.md`](./05-mcp-transport-pool.md) 与 [`06-mcp-budget-guardrails.md`](./06-mcp-budget-guardrails.md)。
- 权限策略：[`04-permission-mediation.md`](./04-permission-mediation.md)。
- 用户运维指南：[`../../users/qwen-serve.md`](../../users/qwen-serve.md)。
