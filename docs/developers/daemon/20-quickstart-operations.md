# 快速上手与运维手册

本篇集中讲「**怎么把 `qwen serve` 跑起来 + 怎么验证它真的能工作 + 内部从 `qwen serve` 到 listening server 的调用链长什么样**」。架构 / 组件 / wire 协议看其他 19 篇专题文档。

## 1. 最短路径

```bash
qwen serve
```

输出：

```
qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge, workspace=/your/cwd)
qwen serve: bound to workspace "/your/cwd"
qwen serve: bearer auth disabled (loopback default). Set QWEN_SERVER_TOKEN to enable.
```

浏览器开 `http://127.0.0.1:4170/demo` 就能看到调试控制台（聊天 UI + 事件流 + workspace 检视）。loopback dev 默认下 `/demo` 注册在 `bearerAuth` **之前**（`packages/cli/src/serve/server.ts` 的 loopback 路由分支），无需 token。

## 2. 启动姿势速查

```bash
# 1. 本地 dev 默认（loopback 无 token）
qwen serve

# 2. 指定工作区 + ephemeral 端口
qwen serve --workspace /path/to/repo --port 0

# 3. 加固 loopback dev（loopback 上也强制 bearer）
QWEN_SERVER_TOKEN=$(openssl rand -hex 32) qwen serve --require-auth

# 4. 暴露给 LAN（非 loopback 必须配 token）
QWEN_SERVER_TOKEN=$(openssl rand -hex 32) \
  qwen serve --hostname 0.0.0.0 --port 4170

# 5. 调多 session + 大重放环
qwen serve --max-sessions 0 --event-ring-size 32000

# 6. 多客户端协作 + 严格预算
QWEN_SERVER_TOKEN=secret \
  qwen serve --require-auth \
             --mcp-client-budget 10 \
             --mcp-budget-mode enforce

# 7. settings.json 配 consensus 策略后启动
# settings.json:  { "policy": { "permissionStrategy": "consensus", "consensusQuorum": 2 } }
qwen serve

# 8. 排查问题用
QWEN_SERVE_DEBUG=1 qwen serve

# 9. 关闭 F2 池（fallback per-session）
QWEN_SERVE_NO_MCP_POOL=1 qwen serve

# 10. browser webui 跨域访问
QWEN_SERVER_TOKEN=secret \
  qwen serve --allow-origin 'http://localhost:3000'

# 11. prompt 超时限制 + SSE 空闲超时
qwen serve --prompt-deadline-ms 300000 --writer-idle-timeout-ms 600000

# 12. ACP child 空闲保活（避免反复冷启动）
qwen serve --channel-idle-timeout-ms 60000

# 13. 打开 HTTP rate limit
QWEN_SERVE_RATE_LIMIT=1 qwen serve
```

加固 loopback 的姿势（3）下 `/demo` 会移到 `bearerAuth` 之后，浏览器开就要带 token 头才能用了 —— 通常配脚本或 curl 而不是浏览器。

## 3. 全部启动参数

CLI 定义在 **`packages/cli/src/commands/serve.ts`**：

| 参数                               | 类型                           | 默认                               | 必填条件                                | 作用                                                                                                                                                 |
| ---------------------------------- | ------------------------------ | ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                       | number                         | `4170`                             | —                                       | TCP 端口；`0` = OS 分配 ephemeral                                                                                                                    |
| `--hostname <host>`                | string                         | `127.0.0.1`                        | 非 loopback 必须配 token                | bind 地址。loopback 集合：`127.0.0.1` `localhost` `::1` `[::1]`。`[::1]` 风格自动剥括号；`host:port` 写法直接报错让你改 `--port`                     |
| `--token <s>`                      | string                         | env / 无                           | 非 loopback 必填；`--require-auth` 必填 | bearer token；trim 一次。**会出现在 `/proc/<pid>/cmdline`，推荐改用 `QWEN_SERVER_TOKEN`**（boot 时 stderr 也会提示）                                 |
| `--max-sessions <n>`               | number                         | `20`                               | —                                       | 活动 session 上限，超额 spawn 返回 503；`0` = 不限。`NaN` / 负值 throws                                                                              |
| `--workspace <dir>`                | string                         | `process.cwd()`                    | —                                       | 绑定工作区。**必须绝对路径、必须存在、必须是目录**。boot 时 `canonicalizeWorkspace` 一次。`POST /session` 带不一致 `cwd` 时 `400 workspace_mismatch` |
| `--max-connections <n>`            | number                         | `256`                              | —                                       | 监听级 `server.maxConnections`。`0` / `Infinity` 不限。NaN/负值 boot 失败（防 fail-OPEN）                                                            |
| `--require-auth`                   | boolean                        | `false`                            | 必须配 token                            | bearer 扩展到 loopback **以及** `/health`。无 token 启动直接拒                                                                                       |
| `--event-ring-size <n>`            | number                         | `8000`                             | —                                       | per-session SSE 重放环深度。软上限 `MAX_EVENT_RING_SIZE = 1_000_000`；越界 boot 抛                                                                   |
| `--http-bridge`                    | boolean                        | `true`                             | —                                       | Stage 1 桥模式（一个 `qwen --acp` 子进程多路复用）。Stage 2 进程内模式还没实现，传 `--no-http-bridge` 会回退并打 stderr                              |
| `--mcp-client-budget <n>`          | number                         | 无                                 | `mcp-budget-mode=enforce` 时必填        | 工作区 MCP client 上限。必须正整数                                                                                                                   |
| `--mcp-budget-mode <m>`            | `'enforce' \| 'warn' \| 'off'` | budget 设了默认 `warn`，否则 `off` | `enforce` 必须配 `--mcp-client-budget`  | `enforce` 拒；`warn` 仅在 75% 报警；`off` 纯观测                                                                                                     |
| `--allow-origin <pattern>`         | string（可多次）               | 无                                 | —                                       | CORS 允许列表，替代默认 Origin 拒绝。`*` 必须配 token                                                                                                |
| `--allow-private-auth-base-url`    | boolean                        | `false`                            | —                                       | 允许安装 localhost / private-network auth provider baseUrl；仅本地可信开发场景使用                                                                   |
| `--prompt-deadline-ms <n>`         | number                         | 无                                 | —                                       | prompt 服务端 wallclock 上限（ms），超时 abort                                                                                                       |
| `--writer-idle-timeout-ms <n>`     | number                         | 无                                 | —                                       | per-SSE-connection 空闲超时（ms）                                                                                                                    |
| `--channel-idle-timeout-ms <n>`    | number                         | `0`                                | —                                       | 最后 session 关闭后保活 ACP child（ms），`0` = 立即回收                                                                                              |
| `--session-reap-interval-ms <n>`   | number                         | `60000`                            | —                                       | session reaper 扫描间隔；`0` = 禁用                                                                                                                  |
| `--session-idle-timeout-ms <n>`    | number                         | `1800000`                          | —                                       | disconnected session idle 回收时间；`0` = 禁用                                                                                                       |
| `--rate-limit` / `--no-rate-limit` | boolean                        | env / off                          | —                                       | 开启或关闭 per-tier HTTP rate limit                                                                                                                  |
| `--rate-limit-prompt <n>`          | number                         | `10`                               | `--rate-limit`                          | 每窗口 prompt 请求上限                                                                                                                               |
| `--rate-limit-mutation <n>`        | number                         | `30`                               | `--rate-limit`                          | 每窗口 mutation 请求上限                                                                                                                             |
| `--rate-limit-read <n>`            | number                         | `120`                              | `--rate-limit`                          | 每窗口 read 请求上限                                                                                                                                 |
| `--rate-limit-window-ms <n>`       | number                         | `60000`                            | `--rate-limit`                          | rate limit 窗口长度，必须 `>= 1000`                                                                                                                  |

## 4. 环境变量

| Env                                 | 等效参数 / 作用                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_SERVER_TOKEN`                 | 等价 `--token`；`--token` 优先。boot 时 trim 一次（防 `cat token.txt` 留尾换行）                                                |
| `QWEN_SERVE_DEBUG`                  | `1` / `true` / `on` / `yes`（不区分大小写）开 stderr 详细日志                                                                   |
| `QWEN_SERVE_NO_MCP_POOL`            | `1` 完全禁工作区 MCP 池（回到 per-session `McpClientManager`，capabilities 不再广播 `mcp_workspace_pool` / `mcp_pool_restart`） |
| `QWEN_SERVE_MCP_CLIENT_BUDGET`      | 等价 `--mcp-client-budget`，daemon 通过 `BridgeOptions.childEnvOverrides` 透传给 ACP 子进程                                     |
| `QWEN_SERVE_MCP_BUDGET_MODE`        | 等价 `--mcp-budget-mode`，同样透传                                                                                              |
| `QWEN_SERVE_PROMPT_DEADLINE_MS`     | env fallback for `--prompt-deadline-ms`                                                                                         |
| `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` | env fallback for `--writer-idle-timeout-ms`                                                                                     |
| `QWEN_SERVE_MCP_POOL_TRANSPORTS`    | ACP child 读取，逗号分隔池化 transport allowlist；默认 `stdio,websocket`                                                        |
| `QWEN_SERVE_MCP_POOL_DRAIN_MS`      | ACP child 读取，池 entry idle drain 延迟；默认 `30000`，限制在 `1000..600000` ms                                                |
| `QWEN_SERVE_RATE_LIMIT`             | `1` / `true` 开启 rate limit；CLI flag 优先                                                                                     |
| `QWEN_SERVE_RATE_LIMIT_PROMPT`      | env fallback for `--rate-limit-prompt`                                                                                          |
| `QWEN_SERVE_RATE_LIMIT_MUTATION`    | env fallback for `--rate-limit-mutation`                                                                                        |
| `QWEN_SERVE_RATE_LIMIT_READ`        | env fallback for `--rate-limit-read`                                                                                            |
| `QWEN_SERVE_RATE_LIMIT_WINDOW_MS`   | env fallback for `--rate-limit-window-ms`                                                                                       |

per-handle env override 是刻意的 —— 同进程跑两个 daemon 不会在 `process.env` 上 race（`defaultSpawnChannelFactory` 在 spawn 时刻快照 env）。

## 5. `settings.json` 也会被读

boot 时一次性 `loadSettings(boundWorkspace)`：

| 键                          | 类型                                                               | 行为                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.permissionStrategy` | `'first-responder' \| 'designated' \| 'consensus' \| 'local-only'` | 设 `BridgeOptions.permissionPolicy`。**boot 时 `validatePolicyConfig` 校验**，未知值抛 `InvalidPolicyConfigError`（boot 显式失败，而不是回退默认） |
| `policy.consensusQuorum`    | 正整数                                                             | consensus 策略的 N。默认 `floor(M/2)+1`。非 `consensus` 策略下设了会被静默忽略 + boot 打 stderr 警告                                               |
| `context.fileName`          | string                                                             | 覆盖 `getCurrentGeminiMdFilename()`，影响 `POST /workspace/init` 写哪个文件                                                                        |
| `tools.disabled`            | string[]                                                           | 经 `normalizeDisabledToolList()` 归一化（trim、丢空、去重）后影响下次 ACP child spawn                                                              |
| `tools.approvalMode`        | string                                                             | session 默认 approval mode                                                                                                                         |
| `telemetry`                 | object                                                             | OTel 配置：`enabled`、`otlpEndpoint`、`otlpProtocol`、per-signal endpoint 等（详见 [`17-configuration.md`](./17-configuration.md)）                |

settings 读 I/O 失败（损坏 JSON 等）回退默认；`InvalidPolicyConfigError` 例外 —— 配错就直接 boot 失败。

## 6. boot 拒启动场景（fail-loud）

`runQwenServe.ts` 故意在这些场景直接抛错而不是 fallback：

| 场景                                                                   | 错误信息开头                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 非 loopback 没 token                                                   | `Refusing to bind … without a bearer token`                                                      |
| `--require-auth` 没 token                                              | `Refusing to start with --require-auth set but no bearer token`                                  |
| `--workspace` 不存在 / 不是目录 / 不绝对                               | `Invalid --workspace ...`                                                                        |
| `--workspace` 没权限 stat                                              | `Invalid --workspace ...: permission denied`                                                     |
| `--mcp-client-budget` 非正整数                                         | `Must be a positive integer`                                                                     |
| `--mcp-budget-mode=enforce` 无 budget                                  | `requires a positive mcpClientBudget`                                                            |
| `--hostname` 写成 `localhost:4170`                                     | `looks like a "host:port" combination. Use --port`                                               |
| `--hostname [::1]:8080`                                                | `Invalid --hostname … brackets indicate an IPv6 literal but the value isn't a clean [addr] form` |
| `--max-connections` NaN / 负值                                         | `Must be >= 0`                                                                                   |
| `--event-ring-size > 1_000_000`                                        | bridge 构造时抛                                                                                  |
| `--allow-origin '*'` 没 token                                          | `Refusing --allow-origin '*' without a bearer token`                                             |
| `--prompt-deadline-ms` / `--writer-idle-timeout-ms` 非正整数           | `Must be a positive integer`                                                                     |
| `policy.permissionStrategy` 未知值 / `policy.consensusQuorum` 非正整数 | `InvalidPolicyConfigError`                                                                       |

## 7. 跑起来之后的 curl 验证清单

```bash
# 1. liveness
curl http://127.0.0.1:4170/health
# → {"status":"ok"}

# 1.1 deep health
curl -s 'http://127.0.0.1:4170/health?deep=1' | jq

# 2. capabilities（看广播了哪些 feature tag）
curl -s http://127.0.0.1:4170/capabilities | jq

# 3. preflight 看是否就绪
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# 4. env 快照（机密只报存在性）
curl -s http://127.0.0.1:4170/workspace/env | jq

# 5. MCP 池 / 预算快照
curl -s http://127.0.0.1:4170/workspace/mcp | jq

# 6. 创建 session
curl -s -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Client-Id: curl-debug' \
  -d '{}' | jq

# 7. tail SSE（替换 <sid>）
curl -N \
  -H 'Accept: text/event-stream' \
  -H 'X-Qwen-Client-Id: curl-debug' \
  'http://127.0.0.1:4170/session/<sid>/events?lastEventId=0'

# 8. demo 页（浏览器）
open http://127.0.0.1:4170/demo
```

带 token 的姿势：所有请求加 `-H "Authorization: Bearer $QWEN_SERVER_TOKEN"`。

## 8. demo 页能不能用

**能。** 实现在 `packages/cli/src/serve/demo.ts` 的 `getDemoHtml(port)` —— 自包含 HTML，无外部依赖。

| 启动姿势                       | `/demo` 注册位置                                                      | 浏览器直接打                           |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------------------- |
| loopback + 无 `--require-auth` | `server.ts` 的 loopback pre-auth route 分支，在 `bearerAuth` **之前** | ✓ 不要 token                           |
| loopback + `--require-auth`    | `server.ts` 的 post-auth route 分支，在 `bearerAuth` **之后**         | ✗ 浏览器很难带 Auth 头，用 curl 或 SDK |
| 非 loopback bind               | `server.ts` 的 post-auth route 分支，在 `bearerAuth` **之后**         | ✗ 同上                                 |

CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`；加 `X-Frame-Options: DENY` 防被嵌入 iframe。所以页面只能 fetch `'self'`（同 daemon），不能拉外部脚本 / 样式。

## 9. 从 `qwen serve` 到 listening server 的调用链

```
qwen serve
   │
   ▼ (process)
packages/cli/index.ts              main()
   │
   ▼
gemini.tsx                         main() — parseArguments()
   │
   ▼ (yargs 装配)
config/config.ts                   import { serveCommand } ...
config/config.ts                   .command(serveCommand)
config/config.ts                   await yargsInstance.parse()
   │
   ▼ (handler 触发)
commands/serve.ts                  handler(argv) — boot pre-checks
commands/serve.ts                  const { runQwenServe } = await import('../serve/index.js')   # lazy load
commands/serve.ts                  await runQwenServe({...})
   │
   ▼
serve/runQwenServe.ts              runQwenServe(opts, deps)
   │  ├─ trim token
   │  ├─ hostname 错配兜底
   │  ├─ auth 预检
   │  ├─ workspace 校验 + canonicalize
   │  ├─ MCP budget 校验 + childEnvOverrides
   │  ├─ loadSettings + validatePolicyConfig
   │  ├─ PermissionAuditRing + publisher
   │  ├─ resolveBridgeFsFactory
   │  └─ createHttpAcpBridge({...})
   │
   ▼
serve/runQwenServe.ts              const app = createServeApp(opts, () => actualPort, {...})
   │
   ▼
serve/server.ts                    createServeApp() — 构造 Express app（**不监听**）
   │  ├─ 中间件链（Host allowlist / CORS / bearerAuth / mutation gate / rate limit）
   │  ├─ 路由挂载（health / demo / capabilities / workspace / session / SSE / ACP HTTP）
   │  └─ return app
   │
   ▼
serve/runQwenServe.ts              server = app.listen(port, hostname, cb)
   │  ├─ server.maxConnections = cap
   │  ├─ actualPort = server.address().port
   │  ├─ 写 "qwen serve listening on ..."
   │  ├─ 注册 SIGINT / SIGTERM (onSignal)
   │  └─ resolve(handle: RunHandle)
   │
   ▼
commands/serve.ts                  await blockForever()    // 永久阻塞，等信号
```

关键事实：

- **`createServeApp` 只构造，不监听。** 它返回的是 `express()` 实例加挂好中间件 + 路由，调用方自己 `app.listen()`。`server.test.ts` 的 ~25 个 case 就是这样用，所以工厂特意不持有生命周期。
- **`() => actualPort` 是惰性闭包。** `actualPort` 在 `app.listen` 回调里才赋值，`hostAllowlist` 中间件查询时按需读，所以 ephemeral 端口（`--port 0`）也能正确闸 `Host` 头。
- **`await blockForever()` 不是 bug**：yargs `parse()` 如果 resolve，CLI 顶层会 fall-through 进交互式 TUI 入口（gemini.tsx）。SIGINT / SIGTERM 在 `runQwenServe` 里走 `onSignal` 路径，是唯一退出方式。

## 10. HTTP 路由分散在哪些文件

主装配在 `server.ts` 的 `createServeApp()`，对四个模块化路由文件做外挂：

| 路由                                                                                                               | 文件                                                  | 挂载点 / 入口                        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| `/health`、`/demo`、`/capabilities`、所有 session 路由、device-flow、permission 投票、SSE、单服务器 MCP restart 等 | `packages/cli/src/serve/server.ts`                    | `createServeApp()` 内直接注册        |
| `/workspace/memory`（GET/POST）                                                                                    | `packages/cli/src/serve/workspaceMemory.ts`           | `mountWorkspaceMemoryRoutes()`       |
| `/workspace/agents` 全套 CRUD                                                                                      | `packages/cli/src/serve/workspaceAgents.ts`           | `mountWorkspaceAgentsRoutes()`       |
| `GET /file`、`/file/bytes`、`/list`、`/glob`、`/stat`                                                              | `packages/cli/src/serve/routes/workspaceFileRead.ts`  | `registerWorkspaceFileReadRoutes()`  |
| `POST /file/write`、`/file/edit`                                                                                   | `packages/cli/src/serve/routes/workspaceFileWrite.ts` | `registerWorkspaceFileWriteRoutes()` |

完整路由 + wire 协议看 [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)；架构看 [`01-architecture.md`](./01-architecture.md)。

## 11. 优雅退出 vs 强退

- **第一次 SIGINT / SIGTERM** → 走 `runQwenServe` 的 `onSignal` → 两阶段 graceful：
  1. `bridge.shutdown()`：每个 channel 等 `KILL_HARD_DEADLINE_MS`（10s），然后 `channel.kill()`。
  2. `server.close()`：等飞行中请求收尾，5s `SHUTDOWN_FORCE_CLOSE_MS` 到点 `closeAllConnections()`，再 2s 二次 deadline。
- **第二次 SIGINT / SIGTERM** 在退出中再来 → `bridge.killAllSync()` 同步 SIGKILL 所有 ACP child + `process.exit(1)`（防孤儿）。

`runQwenServe` 返回的 `RunHandle.close()` 是程序化等价物，给嵌入方 / 测试用。

## 12. 嵌入式调用（绕过 CLI）

```ts
import { runQwenServe } from '@qwen-code/qwen-code/serve';

const handle = await runQwenServe({
  port: 0, // ephemeral
  hostname: '127.0.0.1',
  mode: 'http-bridge',
  maxSessions: 20,
  workspace: '/abs/path/to/repo',
});
console.log(`Daemon at ${handle.url}`);
// ... 用 handle.bridge 直接调或访问 handle.server
await handle.close(); // 程序化关
```

或者直接拿 Express app（自己 listen）：

```ts
import { createServeApp } from '@qwen-code/qwen-code/serve';

const app = createServeApp(
  {
    port: 0,
    hostname: '127.0.0.1',
    mode: 'http-bridge',
    maxSessions: 20,
  },
  () => 0,
  {
    /* deps: bridge, fsFactory, ... */
  },
);

const server = app.listen(0, '127.0.0.1', () => {
  console.log('listening on', server.address());
});
```

注意：直接调 `createServeApp` 时默认 `fsFactory.trusted = false`，agent 侧 ACP `writeTextFile` 会拒为 `untrusted_workspace`，且首次会打一次 stderr 警告。要么注入 `deps.fsFactory`（带显式 trust），要么注入 `deps.bridge`，要么接受这个 trust-gate-default 姿势。

## 13. 调试套路

详见 [`19-observability.md`](./19-observability.md) 的「调试套路」一节。最常用：

```bash
# 看 daemon 是否还活着
curl http://127.0.0.1:4170/health

# 看广播了哪些 capability
curl -s http://127.0.0.1:4170/capabilities | jq

# 看 daemon-host readiness
curl -s http://127.0.0.1:4170/workspace/preflight | jq

# tail SSE 看实时事件
curl -N -H 'Accept: text/event-stream' \
     'http://127.0.0.1:4170/session/<sid>/events?lastEventId=0'

# 详细日志
QWEN_SERVE_DEBUG=1 qwen serve
```

## 参考

- CLI 入口：`packages/cli/src/commands/serve.ts`
- bootstrap：`packages/cli/src/serve/runQwenServe.ts`
- Express 工厂：`packages/cli/src/serve/server.ts`
- 中间件：`packages/cli/src/serve/auth.ts`
- bridge 工厂：`packages/acp-bridge/src/bridge.ts`
- demo 页 HTML：`packages/cli/src/serve/demo.ts`
- 用户文档：[`../../users/qwen-serve.md`](../../users/qwen-serve.md)
- wire 协议：[`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)
