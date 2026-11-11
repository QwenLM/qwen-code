# Managed 客户端文件系统注册（Client Files Relay）

[English](2026-11-10-managed-client-files-relay.md) | [简体中文](2026-11-10-managed-client-files-relay.zh-CN.md)

## 状态

已实现，2026-11-11（PR #16844）。relay、harness 本地 MCP 客户端、Web Shell
桥接与三进程联合集成测试均已交付，并在一次性 MySQL 上通过验证。调研基线：
分支 `x5`，提交 `488845a4a81`；下文「现状」结论均读自该树。交付的拓扑把
relay MCP 客户端放在 **harness**（`HostedClientFilesSession`），而非 worker——
见开放问题 1，worker 的 journal-grant 门控对临时注册排除了该路径。

## 问题

本地 daemon 允许 Web Shell 用户把自己机器上的一个目录注册进会话（「本地
文件」）：浏览器持有 File System Access 授权，在浏览器内跑一个 MCP server，
会话的 agent 像使用其它 MCP 工具一样使用它的工具。Managed（Hosted）会话没有
对等能力。Managed 用户只能操作 Workspace 存储里的文件；想让 agent 读写用户
自己电脑上的文件，只能先上传。

目标是对齐 daemon 体验：显式、可撤销、会话级作用域的客户端目录注册，工具
语义一致，同时保留 Managed 的全部安全边界（租户隔离、actor 授权、审批、
持久事件卫生、Harness 仅回环监听）。

这**不是**浏览器自动化或 CDP 功能。daemon 的客户端文件桥是 MCP-over-WebSocket，
不是 CDP；本文提出的 Managed 对等物是 MCP-over-relay，完全不需要 CDP，也
不需要 WebSocket。

## 现状

### Daemon 链路（参照行为）

1. 浏览器端：`packages/web-shell/client/local-files/` 实现了完整客户端——
   目录选择（`pick-directory.ts`）、句柄持久化（`directory-handle-store.ts`）、
   浏览器内 MCP server（`mcp-server.ts`）、桥客户端（`bridge-client.ts`、
   `useLocalFilesBridge.ts`）拨 daemon `/acp` WebSocket。侧栏入口是
   `LocalFilesControl.tsx`。
2. 注册：客户端发 `mcp_register { server, sessionId }`；daemon 在工具发现
   完成后回 `mcp_registered`。此后 JSON-RPC 以 `mcp_message` 帧双向流动；
   `mcp_unregister` 与 socket 关闭负责拆除。
3. daemon 端：`packages/cli/src/serve/acp-http/client-mcp-sender-registry.ts`
   维护进程级 `serverName → WS sender` 注册表，删除按所有权作用域（断连的
   连接只删除仍归自己所有的条目）；`createClientMcpServerProvider` 向
   `qwen --acp` 子进程添加 SDK 类型的 runtime MCP server。子进程的
   `SdkControlClientTransport` 把每条 JSON-RPC 经 `client_mcp/message`
   ext-method 回送到 WS。
4. 门控：serve 选项 `clientMcpOverWs`（`QWEN_SERVE_CLIENT_MCP_OVER_WS=1`）
   与下发的 `client_mcp_over_ws` capability feature；没有它 UI 不显示入口。

### Managed 缺口（已核实）

| 层                    | 现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted Harness        | `packages/cli/src/serve/hosted-harness-profile.ts` 拒绝 `clientMcpOverWs`（以及 `cdpTunnelOverWs`、shell、channels、browser origins）。这是有意边界；本设计不解除它。                                                                                                                                                                                                                                                                                                 |
| Java 控制面           | `packages/managed-agent-server` 全部代码没有 WebSocket。浏览器↔Java、Java↔Runtime 只有 HTTP/SSE。                                                                                                                                                                                                                                                                                                                                                                   |
| Managed Web Shell     | `LocalFilesControl` 按 daemon capability `client_mcp_over_ws` 门控，Managed provider 不下发该 feature；入口不渲染。                                                                                                                                                                                                                                                                                                                                                   |
| Managed MCP（可复用） | Hosted 会话已能跑 MCP server：`HostedMcpSession`（`hosted-mcp-session.ts`）驱动持久 `mcp_configuration` journal 记录，经 Broker 分发 `mcp-configure` / `mcp-discover` / `mcp-invoke` / `mcp-release`；worker 侧 `ManagedMcpRuntime`（`managed-mcp-runtime.ts`）支持 `stdio`、`streamable-http`、`sse`，定义含 `url` + `headers`。定义按会话从 extension manifest 安装（`managed-extension-manifests.ts`、`managed-context-worker.ts`、`installSessionDefinitions`）。 |
| Java 事件流           | `ManagedEventStreamService` 是**持久的、journal 支撑的** SSE 回放流（sequence id、回放地板、`agent.session.resync_required`、周期性读授权复查）。它不是临时推送通道。`ManagedSideQueryController` 提供了独立临时 `SseEmitter` 流的先例。                                                                                                                                                                                                                              |
| 路由准入              | 每条挂载路由都需要 `contracts/src/main/resources/openapi/managed-agent-public-api.openapi.json` 里的 OpenAPI operation 加 `SurfaceRegistry` 条目（`ManagedAgentApiContractTest`、`SurfaceRegistryGateTest`）。新配置属性需要 `configuration-descriptions.json` 描述。                                                                                                                                                                                                 |

relay 继承的 worker 现有限额（`managed-mcp-runtime.ts`）：
`MAX_INFLIGHT = 32`、`MAX_RESULT_BYTES = 60 KiB`、
`MAX_MANIFEST_BYTES = 1 MiB`、连接超时 `25 s`、单请求超时上限 `600 s`、
catalog 单类上限 `16 KiB`。

## 目标

- Managed Web Shell 用户能把一个客户端目录注册进一个 Session，agent 可使用
  其文件工具，工具面与 daemon `local-files` server 暴露的一致。
- 注册显式（用户手势 + 目录选择器）、可撤销（断开按钮、关标签页、撤销授权）、
  作用域为单个 Session 与单个 actor。
- 对客户端文件的写操作走 Hosted 审批路径。
- 不新增 WebSocket 基础设施、不引入 CDP、不改 Hosted Harness profile 禁令。
  relay 绑定元数据与凭据绝不持久化客户端文件内容；有界 TTL 队列仅在受大小
  限制的 JSON-RPC 体（可能含文件内容）结算或过期前暂存。工具参数与结果遵循
  会话常规持久工具结果策略（决策 6）。

## 非目标

- 驱动用户真实浏览器（CDP 隧道、chrome-extension relay）——独立设计空间，
  明确排除。
- 在同一通道上跑 desktop relay（`desktop-node-repl`）。
- 后台同步、把客户端文件上传/复制进 Workspace 存储、或让注册跨标签页关闭
  存活。
- 单次注册多个目录；Firefox/Safari 支持（File System Access API 可用性是
  daemon 已按 `unsupported-browser` 报告的同一阻断项）。
- 为任何其它功能解除 Hosted Harness 的 WebSocket 禁令。

## 方案

**Java 中介的 MCP relay**。runtime 继续说 Streamable HTTP MCP（已实现）；
浏览器继续跑现有 `local-files` MCP server（传输无关的 JSON-RPC 处理器）；
Java 用临时 SSE 下行 + POST 上行把两者接起来。

```
浏览器（Managed Web Shell）
  local-files MCP server（File System Access 授权，不变）
    ▲ SSE：JSON-RPC 请求            │ POST：JSON-RPC 响应
Java 控制面 — Client Files Relay
  会话级绑定、请求队列、授权复查、限额
    ▲ Streamable HTTP MCP（会话 relay token）
Hosted Harness — HostedClientFilesSession（harness 本地）
  临时会话客户端：transport=streamable-http，
  url=relay 内部端点，headers={relay token}
```

### 注册流程

1. 用户在 Managed Web Shell 侧栏点「连接本地文件」，选择目录（复用现有
   选择器与句柄存储）。
2. 客户端调新的 WebShell 路由 `client-files/register`，带 Session id。Java
   校验 actor 对该 Session 所属 Workspace 的执行授权，创建绑定
   `(tenant, workspace, session, actor, connection generation)`，签发短时效
   会话 relay token。
3. Java 指示该 Session 的 harness（内部、服务鉴权的 `client-files` 路由）连接
   一个**临时** harness 本地 MCP 客户端（`HostedClientFilesSession`）：
   `transport: 'streamable-http'`，`url` = relay 内部 MCP 端点，`headers` =
   relay token。harness 跑 configure/discover 握手；`tools/list` 经 relay 到
   浏览器再返回。worker 不变（开放问题 1）。
4. Java 以发现的工具数确认注册；UI 显示已连接状态，对齐 `LocalFilesControl`
   的阶段模型。
5. Turn 中的工具调用走 harness 本地 invoke → relay → 浏览器 → relay →
   harness，受下文限额约束。写工具在 invoke 分发前要求 Hosted 审批。

### 拆除与失败

- 断开按钮、关标签页或 SSE 掉线 → Java 标记绑定关闭，指示 Runtime 丢弃临时
  定义及其 catalog，并以结构化 `client_files_offline` 错误失败所有排队请求。
  工具调用绝不回退到 Workspace 文件。
- Harness 重启或 worker 替换按设计丢失临时定义；UI 呈现「重新连接」，用户以
  新手势重新注册。对一个没有浏览器就不可能存在的 server，不做持久恢复。
- 撤销授权在现有读授权复查间隔内停止投递；relay 在请求入队时与浏览器取走
  请求时各复查一次 actor 授权。

### 临时态，而非持久态

现有 `mcp_configuration` journal 机制假设 server 定义可重连，并在操作无法
落定时驱动恢复（`recovery_blocked`、`HostedMcpRecoveryRequiredError`）。
浏览器托管的 server 在服务端不可重连：目录授权绑定手势，随标签页消亡。把它
持久化为 configuration，会让用户每次关标签页都留下搁浅的恢复状态。

决定：client-files 注册是**临时会话状态**。不创建 `mcp_configuration` 行、
不创建 extension 记录、不产生携带文件内容的公共事件。harness 仅在内存保存
定义与 catalog（`HostedClientFilesSession`）；控制面保存绑定元数据（id、
generation、时间戳——token 绝不明文、目录路径绝不保存），外加一个有界 TTL
队列，其行仅在受大小限制的 JSON-RPC 体（可能含文件内容）结算或过期前暂存，
随后由保留期清扫删除。临时 catalog 汇入 `HostedWorkspaceToolTurn`，与
`HostedMcpSession.tools()` 并列，不加宽持久 MCP 路径。

### 多节点路由

浏览器的 SSE 连接与 Runtime 的 MCP 连接可能落在不同控制面实例上。绑定元数据
存 SQL；待处理 JSON-RPC 请求存按 `(tenant, session, generation)` 键控的有界、
带 TTL 的 SQL 队列；持有浏览器 SSE 订阅的实例消费队列，响应 POST 经同一行
在任意实例上解除等待者。这沿用 `SessionEventHub` 现有的 DB 对账风格，不引入
粘性路由或消息中间件。队列深度、payload 大小、TTL 为部署配置，取保守默认；
溢出失败该请求，绝不让 Turn 无限阻塞。

注册是同步 dispatch：`register` 先创建绑定，随后阻塞等待 Harness 经队列完成
`initialize`/`tools/list`。因此浏览器必须并发执行注册与消费——发起
`register`，轮询 `status` 至绑定 active，打开 SSE 下行，再 await
`register`。先 await `register` 再消费会死锁；stream 路由也拒绝未知绑定，
且 SSE 响应头只在首个事件时提交（空队列永不提交响应头）。已由三进程联合
IT（切片 4）实证。

### 路由所有权分类

按仓库的路由所有权规则：

- `client-files/*` WebShell 路由：**选定会话、actor 作用域**（要求该 Session
  所属 Workspace 的执行授权；绝非租户全局）。
- 内部 relay MCP 端点与 runtime 注册路由：**live-session-owner 作用域**，
  服务鉴权、Hosted 专用、带版本、不经浏览器/公共路由暴露。未知、draining、
  已移除的 Session 状态一律 fail-closed；绝不回退到 primary runtime。

## 设计决策与理由

1. **relay 优先于 WS 对等。** WS relay 能复刻 daemon 线格式（`mcp_*` 帧），
   但需要净新增 Java WS 基础设施、Hosted Harness profile 豁免、以及
   Kubernetes mTLS 代理的 WS upgrade 支持。HTTP/SSE relay 复用三个现成权威：
   worker 的 Streamable HTTP MCP 客户端、Java 的 `SseEmitter` 先例、浏览器
   传输无关的 MCP server。只有当后续设计确需同一反向通道承载 desktop relay
   或 CDP 时才选 WS 对等；若发生，显式记录该触发条件。
2. **独立临时通道，不用持久事件流。** `ManagedEventStreamService` 持久化并
   回放每一帧；把文件内容请求推过去，等于把客户端文件字节写进会话 journal
   与投影。relay 用自己的 SSE 路由，不写 journal，沿用
   `ManagedSideQueryController` 先例。
3. **临时注册，不走 extension 安装。** MCP self-service（2026-11-07 设计，
   PR #16500）安装的是持久、digest 钉住的 extension MCP server。客户端目录
   授权哪条都不是；把它建模成 extension 会持久化带凭据的定义，并暗示不可能
   成立的恢复语义。
4. **离线语义 fail-closed。** daemon 注册表已给出按所有权拆除的教训；
   Managed relay 增加结构化离线错误，并禁止任何回退到 Workspace 存储，过期
   工具调用绝不能静默读写错误的文件系统。
5. **不声称也无法做服务端路径校验。** 客户端路径的信任边界是浏览器的
   File System Access 授权；服务端看不到授权之外的路径，也无法复验。设计
   明说这一点，而不是暗示一个做不到的包含性检查。服务端强制集中在身份、
   授权、限额与审批。
6. **工具结果遵循常规持久策略（2026-11-10，已批准）。** hosted MCP 执行路径
   把工具参数与结果发布为持久资源，受会话的租户隔离与读授权保护。
   client-files 工具走同一路径。原先「所有文件内容不进持久存储」的目标收窄
   为 relay 状态：并行的「结果绝不持久化」路径仍有漏洞——模型的回答文本本身
   入 journal 且可能引用文件内容——并会破坏恢复与回放。审批无需新接线：
   MCP 工具名从不预批准，`hostedApprovalAsks` 与按服务器/工具名匹配的权限
   规则在非 yolo 模式下已治理每一次 client-files 调用。

## 约束

- 所有 relay payload 有界：请求与响应体 ≤ 60 KiB（对齐 `MAX_RESULT_BYTES`），
  每会话在途 ≤ 32（`MAX_INFLIGHT`），排队请求 TTL ≤ worker 连接/请求超时，
  队列深度可配且默认保守。超限或过期请求以结构化错误失败。
- relay token 会话作用域、短时效、重新注册时轮换；绝不写入 journal、公共
  事件、日志或 metrics；绑定元数据若持久化它，必须用现有凭据加密密钥加密。
- 内部 relay 端点只能从 Runtime 的网络位置到达（local profile 为回环；池化
  部署为私有服务网络），绝不经浏览器面向的路由暴露。
- 注册要求 actor 当前对该 Session 所属 Workspace 的执行授权；只读 actor 不能
  注册。授权复查节奏复用 `events.read-grant-recheck-interval` 语义。
- 新配置属性（队列深度、TTL、启用开关——默认 OFF）需要
  `ManagedAgentProperties` 绑定、元数据与 `configuration-descriptions.json`
  描述。
- Hosted Harness profile 禁令、OpenAPI 单一事实源、SurfaceRegistry 门禁是
  不变的权威；每条新路由经它们准入。

## 风险

- **时延放大。** 每次工具调用增加 harness→Java HTTP、Java→浏览器 SSE、
  浏览器→Java POST 三跳。文件操作可容忍；限额与超时保证慢浏览器不会把 Turn
  拖过现有请求超时。
- **浏览器死亡时的队列堆积。** TTL + 深度上限 + 结构化离线错误兜底；故障
  测试必须证明浏览器在调用中途消失时 Turn 仍（带错误地）完成。
- **跨节点竞态。** 注册、拆除、响应投递跨实例竞争；generation 列栅栏过期
  连接，按所有权删除沿用 daemon 注册表规则。
- **审批绕过。** 若 MCP invoke 今天不走 Hosted 审批路径，runtime 切片必须
  在启用功能前接好写工具审批；这是阻断性验收标准，不是后续项。
- **向通用反向通道的范围蔓延。** relay 刻意单一用途（每 Session 一个 MCP
  server，仅文件工具）。泛化它是独立设计。

## 验证计划

- TypeScript 单测：relay 传输适配器（请求/响应配对、重连、离线错误）、
  `HostedClientFilesSession` 临时定义安装/丢弃、工具 turn 的 catalog 汇入与
  摘除、fail-closed 路径。每个守卫做变异钉：删掉离线错误、授权复查或所有权
  栅栏，必须让指名用例变红。
- Java 测试：每条新路由的 OpenAPI 契约 + SurfaceRegistry 条目；准入测试
  （匿名、跨租户、只读 actor、未知会话、draining 会话）；队列 TTL/溢出；
  token 卫生（任何持久行与下发事件不含 token 或目录路径；队列体受 TTL 约束，
  结算后删除）。
- 集成：扩展 `Hosted*IT` 家族，加 client-files relay 夹具——浏览器夹具 ↔
  Java ↔ 真实 harness——覆盖注册 → 发现 → 读 → 经审批的写 → 断开 → 结构化
  失败，以及 harness 重启后重新注册、流中途撤销授权。
- `.qwen/e2e-tests/` 下的 E2E 测试计划：真实浏览器（Chromium）驱动 Managed
  Web Shell 打一次性控制面；先 dry-run 基线。不可用的联合门禁如实记录。
- 仓库门禁：`npm run build && npm run typecheck`、受影响包测试、按
  `packages/managed-agent-server/AGENTS.md` 的 Java 验证、本文档对的格式与
  引用检查。

## 验收标准

1. 启用功能的 Managed Session 能注册客户端目录、发现其工具、读文件、经审批
   写文件；未注册的同一 Session 不暴露任何客户端文件工具。
2. 关标签页摘除工具，在途调用以 `client_files_offline` 失败；任何调用绝不
   以 Workspace 存储为回退。
3. 撤销 actor 授权在复查间隔内停止请求投递；只读 actor 不能注册。
4. relay 绑定元数据与凭据不持久化客户端文件内容；有界 TTL 队列仅在受大小
   限制的 JSON-RPC 体（可能含文件内容）结算或过期前暂存，随后删除。持久
   事件、Items、投影、日志、metrics 中不出现 relay token 或目录路径。
   client-files 工具参数与结果遵循会话常规持久工具结果策略（决策 6），与
   Workspace 工具结果受同样的租户隔离与读授权保护。
5. Harness 重启不留下搁浅恢复状态；UI 提供重连，新手势重新注册成功。
6. 所有新路由通过 OpenAPI 契约与 SurfaceRegistry 门禁；功能开关默认 OFF，
   关闭部署的行为与今天逐字节一致。

## 交付切片

1. **Java relay**：绑定存储、队列、WebShell 路由、内部 MCP 端点、契约/准入
   测试。可用脚本化 MCP 客户端与脚本化浏览器对端独立验证。
2. **Runtime 临时注册**：定义安装/丢弃、catalog 汇入、审批接线、worker 故障
   测试。
3. **Web Shell**：managed relay 传输、Managed 本地文件入口与阶段、provider
   capability、会话摘要 capability 门控、UI 测试。
4. **联合验收**：集成夹具、真实浏览器 E2E、故障门禁、双语文档刷新。

每个切片带自己的验证落地；靠前的切片不对用户启用功能。

## 开放问题

1. 临时 server 汇入 `HostedWorkspaceToolTurn` 的确切内存 catalog 路径
   （runtime 切片实现前必须点名每个消费者）。2026-11-10 已解决（实现中修订）：
   relay MCP 客户端放在 **harness** 而非 worker。worker 的 MCP 控制准入绑定
   journal grant（`parseOperationGrant`、domain 与 workspace-generation
   校验）；临时注册没有 journal 行，无法在不破坏不变量的前提下签发这些
   grant。relay 客户端是纯 Streamable HTTP 客户端，无本地进程、无 Workspace
   文件访问，因此作为 `HostedClientFilesSession` 与会话权威同处 harness，
   工具轮把它的 catalog 与 `HostedMcpSession.tools()` 并列汇入。worker 不变。
2. hosted MCP invoke 今天是否已走审批路径；若没有，不加宽其它 MCP server
   行为的最小接线是什么。2026-11-10 已解决：已走。MCP 名从不预批准，
   `hostedApprovalAsks` 在所有非 yolo 模式下询问，`permissionDecision` 按
   服务器/工具名匹配。无需新接线。
3. 多节点部署用 SQL 队列还是粘性路由替代——提案选 SQL 队列；只有拿到实测
   证据才重议。
4. 默认策略下读工具是否也要求审批，还是像其它读工具一样跟随 Session 审批
   模式。2026-11-10 已解决：与其它 MCP 工具完全一样跟随 Session 审批模式；
   读工具同样不预批准。
5. File System Access 权限跨页面刷新的持久化（`needs-gesture` 阶段）——原样
   复用 daemon 句柄存储行为，但需确认 Managed provider 的存储分区。
6. Managed 入口如何在不改 boot 载荷的前提下得知部署开关。2026-11-10 已解决：
   会话摘要携带 `clientFiles` capability（`WebShellSessionCapabilities`），
   取值为部署开关 AND harness 支持 AND 可见 ACTIVE 会话（绑定 Workspace 的
   会话还要求当前执行授权），沿用 side-query capability 的模式。Web Shell
   把它投影进摘要镜像类型并据此门控头部入口；provider 仍无条件下发传输。
   boot 载荷不变。
