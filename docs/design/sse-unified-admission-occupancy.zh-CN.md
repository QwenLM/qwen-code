# daemon 各流表面的统一 SSE 准入与占用核算

[English](sse-unified-admission-occupancy.md) | [简体中文](sse-unified-admission-occupancy.zh-CN.md)

- 状态：已实现并验证（同 PR；见验证计划与
  `.qwen/e2e-tests/sse-unified-admission-occupancy.md` 的 E2E 结果）
- 日期：2026-11-17
- Issue：#17554（#17502 的后续，#17502 已合入 `f992bcdd2374`）
- 本设计范围：#17554 的后续项 1 与 2。后续项 3（Web Shell 状态行）与后续项 4
  （#17502 评审延后的测试钉）以堆叠 PR 交付，不在本设计范围内。

## 问题陈述

#17502 让 REST SSE 连接群不能再静默吃光整个 HTTP listener：准入 cap
（`--max-sse-connections`，默认有效 listener cap 的 80%）、默认开启的
writer-stall 回收、真正释放槽位的 RST 强制关闭、TCP keepalive、以及
`limits.maxSseConnections` / `connectedClientsMax` 可观测。如该 PR 的
Risk & Scope 所述，cap、回收器与占用计数**仅覆盖
`GET /session/:id/events`**。

其余每个长连接流表面仍各占一个 listener 槽位，且不进 `activeSseCount`：

| 表面                          | 路由 / 类                                                                                                                                 | 既有约束                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Agent 会话事件                | `GET /workspaces/:workspace/agent/session-events`（`routes/session-agents.ts`）                                                           | 无按 listener 约束          |
| 会话生成                      | `POST /session/:id/generate`（`routes/session.ts`）                                                                                       | 生成器生命周期              |
| 工作区生成                    | `POST /workspace/generate`（`workspace-generation.ts`）                                                                                   | 生成器生命周期              |
| Artifact library / 旁路提问流 | `ArtifactLibraryStream`（`server/artifact-library-stream.ts`，被 artifact-library 读路由与 `btw-stream.ts` 的 `streamBtwSnapshots` 使用） | 请求并发度                  |
| Hosted-harness 事件           | `hosted-harness` profile 的 `GET /session/:id/events`（`hosted-harness-session.ts`）                                                      | 无按 listener 约束          |
| ACP SSE                       | `GET /acp` 与 `GET /workspaces/:workspace/acp`（`acp-http/sse-stream.ts`）                                                                | ACP 连接 cap（每 mount 64） |
| ACP WebSocket                 | 同路径的 WS upgrade（`acp-http/index.ts`）                                                                                                | ACP 连接 cap（每 mount 64） |

由此有两个缺口：

1. **占用不可见、不受 cap 约束。** per-session EventBus 订阅上限（64）与
   每 mount 的 ACP 连接 cap（64）继续约束这些表面，但它们对 SSE 占用计数与
   准入 cap 不可见。多工作区 mount 下仅 ACP 就能超过 cap 预留的 listener
   余量；生成流或 agent 事件流群同样可以。REST 事件流之外的饱和既不可观测，
   也不会被显式拒绝。
2. **没有按 listener 的余量保证。** local-control 与 remote-access listener
   保留各自的 64 socket `maxConnections` 预算。应用层 SSE cap 是 daemon 全局
   而非按 listener 的，LAN listener 仍可能在 64 条流时饱和，把配对/健康入口
   在 accept 时刻打挂——正是 #17502 为主 listener 修掉的故障形态。

## 目标

- 上表所有表面共享同一占用核算。按表面 / 按 listener 的分解位于
  `/daemon/status`（`runtime.transport.streamOccupancy`）；deep health
  携带聚合对（`connectedClients` / `connectedClientsMax`）与到达 listener
  自身的对（`listenerConnectedClients` / `listenerConnectedClientsMax`），
  而非完整分解。
- 既有 `--max-sse-connections` 准入 cap 约束**所有**这些表面，拒绝形态与
  REST 流相同：显式 `503 + Retry-After: 5`
  （`sse_connection_limit_exceeded`）（ACP WebSocket upgrade 在升级前
  得到无 body 的 503）。
- 按 listener 的准入钳制，使配对 listener 获得与主 listener 相同的 80%
  余量保证。
- wire 变更全部 additive；既有字段保留原名。REST 流的拒绝正文、日志行、
  计数时机保留，**但排除本设计明确文档化的变更**：additive 的 `scope`
  （listener 范围另加 `listener`）拒绝字段、新的配对 listener 钳制
  （到达配对 listener 的 REST 流在该 listener 的 51 流钳制处被拒；聚合
  cap 更低时则在聚合 cap 处被拒）、
  `connectedClients` 从仅 REST 改义为聚合，以及拒绝正文的 `active`
  （连同 `activeSseCount` 日志字段）：daemon 范围拒绝现在上报
  `active` = `streamOccupancy.total`，listener 范围拒绝上报该 listener
  自身计数——不再是基线实现记录并返回的仅 REST 计数。

## 非目标

- 把 writer-stall 回收器扩展到 `GET /session/:id/events` 之外。cap 现在约束
  每个表面的总占用；其他表面的回收器覆盖是另一件事（它们生命周期各异：
  生成流随生成器结束、ACP 有 idle TTL、agent 事件有心跳）。
- Web Shell `DaemonStatusDialog` 行（后续项 3，堆叠 PR）。
- #17502 评审延后的测试钉与测试整洁（后续项 4，堆叠 PR）。
- #17554 未列出的其他 WebSocket 表面（`/cdp` 隧道、voice、MCP app sandbox、
  extra WS 路由）。它们保留各自的门；占用计数明确声明其表面集合。
- 改动 `run-qwen-serve.ts` 的 drain/shutdown 等待语义。

## 方案

### 共享占用模块

新模块 `packages/cli/src/serve/sse-occupancy.ts` 持有全部流占用状态
（模块级，与今天 `activeSseCount` 的位置一致）：

- 表面：`restEvents`、`agentEvents`、`generation`（两条生成路由）、
  `artifactLibrary`（artifact-library 读流与旁路提问快照）、`hostedEvents`、
  `acpSse`、`acpWs`。
- 计数器：按表面、按 listener kind（`primary`、`local-control`、
  `remote-access`）、以及总数。listener kind 经既有
  `listenerIdentityOf(req)` 标记解析（合成请求回退 `primary`，与 auth 门
  完全一致）。
- `getSseOccupancy()` 返回新快照 `{ total, bySurface, byListener }`，供
  status/health 表面读取。
- `checkSseAdmission({ surface, req, res, caps, daemonLog?, logContext? })`
  是准入门：准入返回 `true`；饱和时自行发送 503 拒绝并返回 `false`。先查
  聚合 cap，再查到达 listener 的 cap。不做预约（与 #17502 相同的已文档化
  超调窗口：并发握手可超出 cap 至多在飞准入数；listener cap 仍是硬兜底）。
- `countSseStream(surface, req, res?)` 递增计数并返回幂等的 `release()`。
  传入 `res` 时同时挂 `res.once('close', release)`，使槽位在每条收尾路径上
  释放，无需把 release 调用穿进每个表面各自的清理逻辑。

REST 路由保留早检查/晚计数顺序：门在订阅握手之前运行（负载 shedding），
计数在今天 `activeSseCount++` 的位置取，`finalize` 调显式 release。其他
表面在各自的提交点（200 头 / WS upgrade 之前）检查并计数，依赖 close
挂钩释放。

### cap 推导

`daemon-status.ts` 在既有 `sseMaxConnections` 助手旁新增：

- `PAIRING_LISTENER_MAX_CONNECTIONS = 64` —— local-control 与 remote-access
  listener 共享的 socket 预算。`local-control/service.ts` 与
  `remote-access.ts` 把各自的私有 `64` 字面量改为引用该常量，预算与推导
  钳制不会漂移。
- `resolveSseAdmissionCaps({ maxConnections, maxSseConnections })` 返回
  `{ aggregate, byListener }`：
  - `aggregate = sseMaxConnections(...) ?? undefined` —— 既有助手不变
    （显式覆盖向下取整/钳制；`0`/`Infinity` 与禁用的 listener cap 推导为
    不限）。
  - `byListener.primary = aggregate` —— 聚合值已被钳制到主 listener 的
    80% 余量上限。
  - `byListener['local-control'] = byListener['remote-access'] =`
    `aggregate === undefined ? undefined : max(1, floor(64 × 0.8))`，启用时
    为 51。操作者禁用 cap 时按 listener 钳制一并禁用——与主 listener 的
    opt-out 语义对齐。

准入时两项检查都生效：daemon 全局总数达到聚合 cap，**或**到达 listener
的占用达到该 listener 的钳制，流即被拒绝。默认值下（聚合 204、配对 51）
主 listener 为短请求保留 ≥52 槽位，每个配对 listener 在 64 中保留 ≥13；
在无并发在飞握手（上文无预约窗口）时，合并连接群不超过 204。配置的聚合
cap 低于 51 时对所有 listener（含配对）先生效。

### 拒绝形态

共享门对聚合拒绝精确复现 REST 拒绝：

- `503`、`Retry-After: 5`。
- 正文：`{ error: "Daemon SSE connection limit reached (<active>/<limit>). Retry after the Retry-After interval.", code: "sse_connection_limit_exceeded", limit, active, scope }`，
  聚合 cap 的 `scope` 为 `"daemon"`。listener 范围的拒绝使用该 listener 的
  `active`/`limit`，并追加 `scope: "listener"` 与 `listener` kind。
  `scope`/`listener` 是 additive 字段；既有客户端按 `code` 分支。
  `active` 是生效上限所管辖人群的占用：daemon 范围拒绝为 daemon 总数，
  listener 范围拒绝为到达 listener 自身计数——即使被拒的是 REST 流，
  也绝不是仅 REST 计数。
- `daemonLog.warn('SSE connection limit reached', { surface, listener, scope, activeSseCount, limit, ...logContext })`；
  stderr 兜底保留今天逐字节相同的行
  `qwen serve: SSE connection limit reached (active=<n>, limit=<n>); rejecting new SSE client with 503`。
  REST 路由照旧在 `logContext` 传 `sessionId`。

ACP WS upgrade（无 Express 响应）的拒绝镜像既有 drain 拒绝在裸 socket 上
的写法：`HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n` 后
destroy，经既有 upgrade-rejection 日志行记录 cap 细节
（`sse-connection-limit scope=<scope> active=<n> limit=<n>`）。

### 表面接线

| 表面                   | 门位置                                                                                                | 计数 / 释放                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `restEvents`           | 既有早检查替换为共享门                                                                                | 既有晚计数点，带 `res` close 挂钩/destroyed 兜底；`finalize` 显式 release（幂等） |
| `agentEvents`          | runtime/session-id 校验后、200 头前                                                                   | close 挂钩释放                                                                    |
| `generation`（会话）   | bridge 能力检查后、200 头前                                                                           | close 挂钩释放                                                                    |
| `generation`（工作区） | 同上                                                                                                  | close 挂钩释放                                                                    |
| `artifactLibrary`      | 读路由在 `new ArtifactLibraryStream(res)` 之前；BTW 流先判终态 409/410，门紧接 `btwStreams.open` 之前 | close 挂钩释放                                                                    |
| `hostedEvents`         | identity/epoch/cursor 校验后、头前                                                                    | close 挂钩释放                                                                    |
| `acpSse`               | `handleAcpGet` 连接校验与会话归属 403 之后（饱和时鉴权保留终态码）、两个流分支之前                    | close 挂钩释放                                                                    |
| `acpWs`                | ACP 路径 `wss.handleUpgrade` 之前（extra WS 路由保留各自的门）；拒绝写在裸 socket 上                  | upgrade 回调内计数，既有 `ws.on('close')` 内释放                                  |

caps 由 `createServeApp`（`resolveSseAdmissionCaps(opts)`）经各路由注册器
deps 下发。每个 deps 项均可选：省略 caps 的直嵌与单元夹具保持今天的不限
行为。

### 上报

- `runtime.transport.restSseActive` —— 不变（仅 REST 事件表面）。
- `runtime.transport.streamOccupancy` —— additive：来自
  `getSseOccupancy()` 的 `{ total, bySurface, byListener }`。包含
  `acpWs`：该计数度量的是 listener 槽位占用，不是 SSE 帧。
- `limits.maxSseConnections` —— 不变（聚合 cap）。
- `limits.maxSseConnectionsPerListener` —— additive：
  `{ primary, 'local-control', 'remote-access' }`，各为 `number | null`
  （`null` = 不限），来自同一 resolver。
- `GET /health?deep=1`：`connectedClients` 由仅 REST 计数扩展为
  `streamOccupancy.total`，使占用/cap 对共享同一口径——探针必须能对着
  拒绝它的那个 cap 看到 ACP/生成流的饱和。`connectedClients` 由 #17502
  引入、当时口径仅 REST；本设计有意扩展并文档化该变化。
  `connectedClientsMax` 仍为聚合 cap。additive 的
  `listenerConnectedClients` / `listenerConnectedClientsMax` 上报到达
  listener 的管辖对：边界为聚合 cap 与该 listener 钳制（经门禁所用的同一
  `caps.byListener`；主 listener 即聚合值，配对 listener 为 51；`null` =
  不设限）中更紧者——门禁先判聚合，更低的聚合 cap 对所有 listener 先生效；
  分子为该边界所管辖的人群——聚合 cap 生效时为 daemon 总数，钳制生效时
  为该 listener 自身流数——因此已在拒绝的 listener 上这对读数不会被误读
  为尚有余量（评审 R1-6）。
- 每个 HTTP 饱和拒绝调用 `markAccessLogError` 记录
  `sse_connection_limit_exceeded`，使访问日志归因该分支（`{error, code}`
  约定）；ACP WS 拒绝在 upgrade 前写裸 socket，本就没有访问日志行
  （评审 R1-7）。
- `run-qwen-serve.ts` bootstrap status 在既有 `maxSseConnections` 旁新增
  `maxSseConnectionsPerListener`。
- SDK 镜像（`sdk-typescript/src/daemon/types.ts`）：additive optional 的
  `limits.maxSseConnectionsPerListener` 与
  `runtime.transport.streamOccupancy`，record 键放宽为 string（SDK 按约定
  把 daemon 联合类型放宽为 string）。

### 文档

同 PR 更新所有出现「仅 REST 事件」范围主张的位置：
`docs/users/qwen-serve.md`（flag 表、威胁模型范围注记）、
`docs/developers/daemon/17-configuration.md`、
`docs/developers/daemon/20-quickstart-operations.md`、
`docs/developers/qwen-serve-protocol.md`（status 与 deep-health 示例）、公开的
`ServeOptions.maxSseConnections` JSDoc 与 `--max-sse-connections`
`--help` 文案，以及两篇早期设计记录（`daemon-global-deep-health.md`、
`daemon-idle-detection-api.md`——更新行 + 取代注记）。回收器仅 REST 的
范围按原样保留文档化。

## 设计决策与理由

1. **一个聚合计数器 + 按表面/按 listener 分解**，而非按表面 cap。issue
   要求饱和在各处可观测、有界；单一准入预算 + 分解让操作者旋钮
   （`--max-sse-connections`）保持单一，并与既有助手一致。按表面 cap 会在
   没有明确需求的情况下成倍增加配置。
2. **ACP WS 计数且受门约束。** WS 连接与 SSE 流一样钉住一个 listener
   槽位；把它留在聚合之外等于经另一表面留下同样的耗尽漏洞。每 mount 的
   ACP 连接 cap（64）保留为协议级约束；聚合是 listener 级约束。门放在
   `handleUpgrade` 之前，被拒客户端看到的是 HTTP 503，而不是先升级成功
   再被关闭。
3. **`connectedClients` 扩展为聚合。** 与 cap 配对的计数必须共享 cap 的
   口径；否则 ACP 流群在 cap 满时读起来占用为零。该字段只有一天历史
   （#17502），其消费者把它与 `connectedClientsMax` 配对读取。
4. **每个 HTTP 表面都用 close 挂钩释放。** HTTP 响应的每条收尾路径都以
   `'close'` 结束；挂一次即可避免把 release 调用穿进每个表面不同的清理
   （生成 `finally`、artifact `onClose`、hosted `stop`、ACP
   `SseStream.close`）。REST 路由同时保留显式 `finalize` release（幂等，
   双路径安全）：显式 release 保持其计数时机，close 挂钩 / destroyed 守卫
   则兜底异步订阅握手窗口内的客户端 abort——该窗口的 `'close'` 可能先于
   路由自己的 finalize 监听器注册触发，没有兜底时这次 abort 会永久泄漏一个
   共享槽位（评审发现；有回归测试钉住）。
5. **REST 保留早检查/晚计数。** 把计数挪到订阅握手之前会改变已文档化的
   超调窗口与 429/404 路径的计数行为；既有顺序被测试钉住，保持不变。
6. **cap 助手住在 `daemon-status.ts`。** status 表面已从那里 import
   `sseMaxConnections`；resolver 放在旁边使 `sse-occupancy.ts` 保持偏叶子
   模块，避免 status↔occupancy 循环导入。占用快照经注入 getter 到达
   status，与 `getRestSseActive` 同一模式。
7. **模块级计数器。** 与今天 `activeSseCount` 的位置一致。同进程多直嵌
   共享计数（既有行为）；测试断言前后差值。

## 约束与风险

- **无预约窗口。** 与 #17502 相同，并发准入可超出 cap 至多在飞握手数；
  listener 的 `maxConnections` 仍是硬兜底。cap 的职责是阻止渐进累积，
  这正是其既定目标。
- **饱和下的 ACP 重连。** 被 503 拒绝的 ACP SSE 重连不会被
  `EventSource` 式客户端重试（5xx 是终态）。这是预期的负载 shedding
  行为——与 REST 流既有契约相同——停滞连接群排空后槽位即释放。SDK 重连
  循环应在 503 时退避。
- **直嵌间共享计数。** 同进程多个 `createServeApp` 实例共享占用
  （`activeSseCount` 的既有行为）。本设计不引入按 app 隔离。
- **Hosted-harness profile。** 其事件 handler 现在共享聚合 cap；每实例跑
  很多流的 hosted 部署会看到同样的 204 默认值。操作者可用既有 flag 调高
  或禁用。
- **回收器覆盖不变。** 非 REST 表面的停滞 writer 仍持有槽位直到客户端
  断开或该表面自身生命周期结束；cap 约束此类槽位同时存在的数量。shutdown
  是兜底：listener close 强制关闭剩余连接——主 listener 在 close 超时后、
  配对 listener 立即——含 `closeAllConnections()` 单独触及不到的已升级
  socket——并释放其槽位（槽位释放由主 listener 的 shutdown 测试与配对
  listener 的 disable 测试钉住；local-control 服务级测试钉住 `disable()`
  在不回应 close 的已升级对端上 settle；remote-access listener 共享同一
  跟踪销毁释放路径；embed 已在 closing 的 force-close 路径以不回应 close
  的已升级对端钉住）。daemon drain 对配对 teardown 采用 fire-and-forget：
  两个服务的 close() 均销毁跟踪幸存者，故即使面对不回应 close 的配对对端
  dispose 也会 promptly settle；进程退出是任何活过 drain 的 socket 的最终
  兜底。

## 受影响文件

- 新增：`packages/cli/src/serve/sse-occupancy.ts`（+ 同目录单元测试）。
- `packages/cli/src/serve/daemon-status.ts` —— 配对常量、resolver、status
  字段、注入的占用 getter。
- `packages/cli/src/serve/routes/sse-events.ts` —— 计数/门委托共享模块；
  行为保留。
- `packages/cli/src/serve/routes/session-agents.ts`、
  `packages/cli/src/serve/workspace-generation.ts`、
  `packages/cli/src/serve/routes/session.ts`（生成、artifact-library、
  `streamBtwSnapshots` 调用点）、
  `packages/cli/src/serve/hosted-harness-session.ts`、
  `packages/cli/src/serve/acp-http/index.ts` —— 门 + 计数。
- `packages/cli/src/serve/btw-stream.ts` —— 把 `BtwStreamRequests.precheck`
  从 `open` 拆出，使路由能在准入门之前判定终态 409/410；`open` 复跑
  （评审 R1-5）。
- `packages/cli/src/serve/server.ts` —— 一次性解析 caps、经 deps 下发、
  接 status/health getter。
- `packages/cli/src/serve/routes/daemon-status.ts` —— 向 status 响应构建器
  注入占用 getter。
- `packages/cli/src/serve/routes/health.ts` —— `connectedClients` 口径与
  到达 listener 的占用/管辖边界对。
- `packages/cli/src/serve/local-control/service.ts`、
  `packages/cli/src/serve/remote-access.ts` —— 共享配对预算常量；两者均
  跟踪已接受 socket 并在 close 时销毁幸存者，使不回应 close 的已升级对端
  不能挂死 disable()/drain。
- `packages/cli/src/serve/serve-app-lifecycle.ts` —— 从 'connection' 跟踪
  已接受 socket，并在 close 强制计时器销毁幸存者，触及
  closeAllConnections() 单独触及不到的已升级 socket。
- `packages/cli/src/serve/run-qwen-serve.ts` —— bootstrap status 字段。
- `packages/sdk-typescript/src/daemon/types.ts` —— additive 镜像。
- 上文所列文档；新行为测试（先红）放在同目录 `sse-occupancy` 测试文件，
  并在已有夹具的表面处补充表面级用例。

## 验证计划

1. **先红单元/行为测试**（改动前树上）：
   - 占用快照字段缺失 / 非 REST 表面计数器不动；
   - 饱和的非 REST 表面仍准入而非拒绝；
   - LAN listener 在其 socket 预算处饱和而无 listener 范围拒绝。
2. **实现后转绿**：每表面计数/释放配对（开流 →
   `bySurface`/`byListener`/`total` +1，关闭 → 回基线）、每表面聚合 503
   的精确 code/Retry-After、打了 local-control 标记的 listener 上的
   listener 范围 503 且主 listener 仍准入、全程 `/health` 可达、WS
   upgrade 前 503、status/deep-health 字段配对、禁用哨兵
   （`0`/`Infinity`/listener `0`）与显式覆盖经 resolver 的钳制。
3. **回归**：既有 SSE guard 套件、T2.9 回收器套件、
   `run-qwen-serve.test.ts`、ACP transport 套件、local-control/remote-access
   套件、SDK public-surface 测试；`npm run build && npm run typecheck`。
4. **E2E**（测试计划在 `.qwen/e2e-tests/`）：本地 bundle 起真实 daemon；
   经生成/agent 事件流与 ACP WS 打饱和；验证显式拒绝、余量探针、
   status/deep-health 配对、排空后槽位释放。先对全局 `qwen` CLI 做基线
   dry-run 记录缺口。

## 验收标准

- 表中每个表面开流期间递增共享占用，关闭时在每条收尾路径释放。
- 聚合 cap 处每个表面以
  `503 + Retry-After: 5 + sse_connection_limit_exceeded` 拒绝（WS：upgrade
  前裸 socket 503）；短请求持续可服务。
- 配对 listener 钳制处，到达该 listener 的流被 listener 范围正文拒绝，
  其他 listener 仍准入。
- `daemon/status` 上报 `streamOccupancy` 与
  `maxSseConnectionsPerListener`；deep health 的 `connectedClients` 等于
  `streamOccupancy.total` 并与 `connectedClientsMax` 配对，且到达 listener
  的 `listenerConnectedClients` / `listenerConnectedClientsMax` 对与管辖
  它的钳制一致。
- REST 流拒绝正文、日志行、计数时机保留，但排除文档化的 additive
  `scope`/`listener` 字段、配对 listener 钳制与 `connectedClients` 改义；
  全部 #17502 测试钉不改靶保持绿。
- 终态鉴权/结果在饱和时保留其状态码：他人 ACP session id 仍得 403，
  BTW 重复/过期请求仍得 409/410（门只决定资源准入）。
- 每个 HTTP 饱和拒绝在访问日志中以
  `code: sse_connection_limit_exceeded` 归因。
- 禁用哨兵与显式覆盖的行为与既有 `sseMaxConnections` 契约完全一致，
  按 listener 扩展。

## 开放问题 / 后续

- 后续项 3（Web Shell 行）与后续项 4（延后测试钉）以堆叠 PR 落在本改动
  之上。
- 已由 #17712 决议：回收器覆盖按决定保持仅 REST——非 REST 表面生命周期
  各异（生成器结束、ACP idle-TTL、心跳），逐表面 writer-stall 回收器是
  另一个设计；停滞不读对端的边界改为文档化（用户指南范围注记与上文
  约束）。`remote-access` 配对 listener 现在与 `local-control` 拥有相同
  的端到端准入钉（钳制、listener 范围拒绝、访问日志归因、deep-health
  对）；shutdown drain 覆盖已钉住 generation 与 ACP 表面（开着的流既不
  挂死 `handle.close()` 也不泄漏槽位，含永不回应关闭帧的已升级对端）；
  其余计数表面共享同一释放钩子，但尚无 shutdown 钉。
