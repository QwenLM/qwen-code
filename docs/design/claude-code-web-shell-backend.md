# Claude Code 作为 Web Shell 可选 agent 后端

状态：设计草案 · 作者：wenshao · 日期：2026-09-03

配套实证：`.qwen/investigations/route-a-claude-acp-e2e-spike.md`（git-ignored，含全部原始 JSON 证据）

## 1. 问题与现状

Web Shell 今天只能驱动 Qwen Code 自己的 agent。daemon（`qwen serve`）为每个 workspace runtime
拉起一个 ACP 子进程，恒定是 `qwen --acp`（`packages/acp-bridge/src/spawnChannel.ts:446`）。
用户希望在 Web Shell 里也能管理 Claude Code 会话。

`docs/users/features/multi-agent-coordination.md:28` 目前把跨厂商 agent 协同划归 herdr，
并明确写着"Persistent independent PTY sessions, cross-vendor workers, and remote attach are
separate product concerns"。本设计提议改变这一边界：**通过 ACP 协议把 Claude Code 接成一等后端**，
而不是引入终端级外部依赖。

### 已经实测确认可行的部分

一次零源码改动的端到端 spike（用 `QWEN_CLI_ENTRY` 顶替 ACP 子进程入口）证明：

| 环节                                                                      | 结果                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude ACP adapter（`@agentclientprotocol/claude-agent-acp` v0.73.0）握手 | ✅ `protocolVersion: 1`，`authMethods: []`（本机已认证）                 |
| `POST /session` 建会话                                                    | ✅ 200（绕过 guard 后，见 §3.1）                                         |
| prompt → SSE 流式 → `turn_complete`                                       | ✅ 真 token 级流式，6.0s 一轮                                            |
| 工具调用事件                                                              | ✅ 带 `kind:"edit"`、`locations`、结构化 `diff`，现有 diff UI 可直接消费 |
| context 用量                                                              | ✅ Claude 原生通过 `usage_update` 事件上报 `{size, used}`                |
| 工具授权                                                                  | ✅ 标准 ACP `session/request_permission`，deny/allow A/B 双 PASS         |
| 12 条 workspace 级路由                                                    | ✅ 全 200（daemon 侧服务，不经子进程）                                   |

### 行为差距

| 差距                      | 现状                                                     | 期望                           |
| ------------------------- | -------------------------------------------------------- | ------------------------------ |
| guard 握手                | 外部 agent 无法 ack → `POST /session` 500 + 通道 SIGKILL | 未回显即视为不支持，关闭该特性 |
| 78 个 `qwen/*` ext method | 全部 `-32601`                                            | 按后端能力门控，不再发起       |
| 7 条 session 诊断路由     | HTTP **500**                                             | HTTP **501**，UI 隐藏对应入口  |
| 授权模式                  | 继承用户本机 Claude 设置（实测为 `auto` 静默放行）       | 由 qwen `approvalMode` 推导    |
| 能力位                    | `capabilities.features` 是 daemon 全局扁平数组           | 能表达"此后端不支持"           |
| 后端选择                  | 无任何字段，`sessionScope:'single'` 下会被静默丢弃       | 显式、可发现、不会被静默忽略   |

## 2. 决定性结构约束

daemon 的既有不变量是 **one bridge : one channelFactory : one live channel : N 复用 session**：

- `WorkspaceRuntime.bridge` 是单个 `readonly` 字段（`packages/cli/src/serve/workspace-registry.ts:47`），不是集合
- `channelInfo` 是单个变量（`bridge.ts:2981`）；`ensureChannel()` 是无参 get-or-create 单例（`bridge.ts:4362-4372`）
- `ChannelFactory` 签名只接受 `(workspaceCwd, childEnvOverrides?, signal?)`（`channel.ts:73-77`）—— **拿不到 session，也拿不到后端标识**
- `aliveChannels` 有硬编码上限告警：`if (aliveChannels.size > 2)`，注释明写 _"Threshold is 2 because that's the design ceiling"_（`bridge.ts:4646-4653`）
- 生产默认 `sessionScope: 'single'` 下，第二个建会话请求直接 attach 到 `defaultEntry`（`bridge.ts:9367-9369`），**任何后端选择都会被静默丢弃**，且 `BridgeSession` 无字段可让调用方察觉

反过来，**per-runtime 的 factory 差异化已经是 shipped 模式**：primary / secondary /
workspace-qualified 三个 bridge 各自构建独立 factory（`run-qwen-serve.ts:5103`、`:6022`、`:6682`），
分别传入 `:5576`、`:6145`、`:6827`。

## 3. 关键设计决策

### 决策 1：后端粒度 = per-runtime，但 workspace 身份需从 `cwd` 重新键为 `(cwd, backend)`

**产品要求（已确认）**：同一 workspace 内必须能混跑 Qwen 与 Claude 会话；Claude 在 UI 上呈现为
"同 workspace 下的附加 runtime"，而非独立 workspace 条目。

**为什么仍取 per-runtime 而非 per-session channel 选择**：per-runtime 的接缝已经存在且被三条生产
路径行使（primary / secondary / workspace-qualified，`run-qwen-serve.ts:5103`、`:6022`、`:6682`）。
每个 runtime 保持"一个 bridge : 一条 channel : N 复用 session"的既有不变量，因此
`channelInfo` 单例、`ensureChannel()`、`ChannelFactory` 签名、`aliveChannels` 的 design ceiling
**全都不需要动**。per-session channel 选择则要同时改这四处，风险与本特性不成比例。

混跑通过"同一 cwd 下两个 runtime，会话各属其一"实现 —— 对用户而言就是同一 workspace 内混跑。

**但这要求把 workspace 身份从 `cwd` 单键改为 `(cwd, backend)` 复合键**，这是本设计新增的、
之前未预见的核心改动。实测证据：

- `WorkspaceRegistry` 的 `byCwd` 是 `Map<string, WorkspaceEntry>`（`workspace-registry.ts:265`），
  以 cwd 单键索引，且**两条注册路径都硬性拒绝重复 cwd**：
  boot 路径 `:293-299` 与运行时 `add()` 路径 `:515-519` 均为
  `if (byCwd.has(runtime.workspaceCwd)) throw new Error('Duplicate workspace runtime cwd …')`
- `resolveWorkspaceCwd()`（`:507-514`）纯按 cwd 解析 runtime
- cwd 作为 workspace 标识**贯穿整个 HTTP 面**：`acpRouteTable.ts` 的
  `GET /workspace/:id/sessions` 把路径段直接当 `workspaceCwd`；e2e 亦以
  `/workspaces/${encodeURIComponent(workspaceCwd)}/` 为前缀

因此需要改动的面（均为 core，属 AGENTS.md 门禁区）：

| #   | 面                  | 改动                                                                                                                                                                            |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `WorkspaceRegistry` | `byCwd` 改复合键；`:293`、`:515` 的重复检查改为按 `(cwd, backend)`；约 9 处 `byCwd.get/has/set/delete` 调用点（`:396`、`:403`、`:476`、`:484`、`:511`、`:526`、`:557`、`:571`） |
| 2   | runtime 解析        | `resolveWorkspaceCwd`、`getManagedEntryByWorkspaceCwd` 及其消费者需接受 backend 维度                                                                                            |
| 3   | 路由层              | `resolveRuntimeForSessionCreation`（`session.ts:943`，当前只读 `body['cwd']`）、`requireSessionRuntime` 需要后端判别式                                                          |
| 4   | HTTP URL 面         | `/workspace/:cwd/...` 系列路由需要 backend 判别（query 参数或路径段），否则同 cwd 两 runtime 的请求无法区分                                                                     |
| 5   | capabilities        | `workspaces[]`（`routes/capabilities.ts:118-134`，已有 `kind` 字段）将出现两条同 cwd 条目                                                                                       |
| 6   | Web Shell           | 会话目录与侧边栏分组必须按 `workspaceId` 而非 cwd 聚合，否则同 cwd 两 runtime 会被并成一组                                                                                      |

**取舍说明**：这一改动把成本从"bridge 通道生命周期不变量"转移到"workspace 身份"。
两者都在 core，但 workspace 身份是**数据索引与路由判别**问题，可增量、可测试、失败模式是
显式的（重复注册 throw）；而 bridge 通道生命周期涉及 `aliveChannels` ceiling、
`inFlightChannelSpawn` 合并、`sessionScope:'single'` 下的 `defaultEntry` attach 等并发不变量，
失败模式是静默的（后端选择被丢弃且调用方无从察觉，`bridge.ts:9367-9369`）。
因此本设计选择承担前者。

### 决策 2：guard 握手改为回显式协商

`bridge.ts:4851-4859` 目前无条件要求子进程在 initialize 响应 `_meta` 回显
`qwen-code/external-tool-guard-ready: required-v1`，否则 throw。根因是
`run-qwen-serve.ts:4200` 无条件创建 handler、`:4210` 无条件下发私有 env、
`:5577/:6146/:6828` 三处恒定传入 `externalToolGuard`，使 `if (opts.externalToolGuard)` 永真。
注意这与 `--external-tool-guard-mode`（默认 `off`）无关 —— 该 flag 管的是外部 provider，管不到这条私有握手。

**改法**：对齐**同一文件里已有的正确范式**。`channelLiveness`（`bridge.ts:4885-4890`）和
`activeWork`（`bridge.ts:4860-4880`）都是回显式协商：子进程不回显 ⇒ 特性关闭，而非 throw。
guard 应同样处理，**但必须保留 `--external-tool-guard-mode=required` 的强语义**：
当运维显式要求外部 guarding 时，未 ack 仍应 fail closed（这是安全特性，不能降级为静默关闭）。

即：`required` 模式 → 保持 throw；默认（内建 policy）模式 → 未回显则关闭该通道的 guard。

### 决策 3：停止丢弃 `agentCapabilities`，作为后端能力的权威来源

`bridge.ts:4823-4846` 拿到 initialize 响应后，**只读 `_meta` 的三个键，`response.agentCapabilities` 从未被读取**
（`packages/acp-bridge/src` 内 `agentCapabilities` 仅在 `internal/testUtils.ts:175` 出现）。
`ChannelInfo` 也没有能力字段。

协议在握手时就已经给出了每后端能力信号，却被丢掉了。应把它记录到 `ChannelInfo`，
作为后续所有能力门控的**单一权威来源**，而不是靠"调用失败再降级"来探测。

Claude adapter 实测回显的能力：`loadSession: true`、`session_capabilities: {additionalDirectories,
close, delete, fork, list, resume, subagents}`、`promptCapabilities: {image, embeddedContext}`、
`mcpCapabilities: {http, sse}`。

### 决策 4：授权模式由 qwen `approvalMode` 推导，不继承 Claude 本机设置

实测：adapter 在 `acp-agent.js:5205-5206` 读 `~/.claude/settings.json` 的 `permissions.defaultMode`
作为初始模式；本机为 `auto`，导致 Write 工具**无询问直接落盘**。这不是协议缺陷
（强制切到 `default` 模式后 deny/allow A/B 双 PASS），但是**真实的产品风险**：
用户在 qwen 侧选的审批模式会静默失效。

**改法有现成 precedent**：`packages/qwen-live/src/adaptor/acp-adaptor.ts:214-222` 已经在做同一件事 ——
建会话后 `conn.setSessionMode({ sessionId, modeId: 'default' })`，注释写明
_"qwen-code's ACP sessions default to AUTO approval (silent allows) … Non-qwen agents answer -32601
and keep their own default"_。

`BridgeSpawnRequest` 已带 `approvalMode` 字段（`bridgeTypes.ts:155`），映射表小而清晰：

| qwen `approvalMode` | Claude `permissionMode`     |
| ------------------- | --------------------------- |
| 需要逐次确认        | `default`（UI 名 "Manual"） |
| 自动接受编辑        | `acceptEdits`               |
| 全自动              | `auto`                      |
| 只读/计划           | `plan`                      |

设定途径有二：`session/new` 的 `creationOpts.permissionMode`，或事后 `session/set_mode`（已实测可用）。
优先前者，避免"先以 auto 建会话再改模式"的窗口。

### 决策 5：`-32601` 的表达统一为 501

当前不一致：SDK 的 ACP transport 把 `-32601` 映射成 **404**
（`packages/sdk-typescript/src/daemon/acpTransportUtils.ts:72`，仅被 `AcpHttpTransport.ts:289` /
`AcpWsTransport.ts:251` 使用），而 Express REST 路径**完全没有数字 code 分支** ——
`error-response.ts:257-1030` 的 ~45 个 `instanceof` 分支一个都不匹配（ACP SDK 把 JSON-RPC 错误
作为普通对象而非 `Error` 子类转发，该文件 `:1032-1036` 的注释已说明这点），最终落到
`:1029-1030` 的兜底 `res.status(500)`。

完整链路（以 `/supported-commands` 为例）：`session.ts:4726` → `bridge.ts:12025` →
`bridge.ts:6470-6474`（`extMethod`，**无 try/catch**）→ Claude 回 `-32601` →
`session.ts:1893-1898` catch → `sendBridgeError` → 兜底 500。

**改法**：在 `sendBridgeError` 增加一个数字 code 分支，`-32601` → **501 Not Implemented**
（语义准确：后端不支持该方法），保留 body 里的 `code`/`data` 不变。
404 留给"会话不存在"（`SessionNotFoundError` 已有分支，`error-response.ts:574-578`）。

> **风险（见 §7 Q2）**：qwen 自己的子进程在版本偏移时也可能回 `-32601`。需确认改成 501 不会
> 让既有客户端把"版本不匹配"误读成"后端不支持"。

### 决策 6：能力门控而非错误降级

Web Shell 目前**完全没有** `-32601` / `methodNotFound` 感知（`packages/web-shell/client/**` 零命中）。
抽查的两个消费点是 GRACEFUL 的（`client/daemon/session/actions.ts:1935-1955` catch + `dispatchActionError`；
调用方 `client/App.tsx:9339-9348`、`client/components/ChatPane.tsx:1087-1101` 均有 `.catch(reportError)`），
但代价是 `/context` 会先回显命令、再弹 "Failed to load context usage" —— **不支持却报错，而不是隐藏入口**。

既有门控范式（`client/App.tsx:3518-3526`）：

```ts
const webTerminalAvailable =
  workspaceContextActive &&
  rightPanelItems.includes('terminal') &&
  connection.capabilities?.features.includes('web_terminal') === true;
```

问题在于 `features` 是 daemon 全局扁平数组，由 `serve-features.ts:127-176` 每请求重算，
但**所有输入都是 daemon/runtime 级，没有任何 session 级输入**（`CreateServeFeaturesDeps`
不接受 sessionId、bridge、channel 或 runtime 对象）。

**改法**：沿用决策 1 的 per-runtime 粒度 —— 能力位挂在 runtime 上，经
`capabilities.workspaces[]`（已有 `kind` 字段）下发，Web Shell 按 runtime 门控。
这样**不需要**新建 per-session 能力机制，也不改动既有门控 idiom。

## 4. 分层改动

| 层             | 改动                                               | 主要文件                                                                                             |
| -------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| acp-bridge     | guard 改回显式协商（保留 required 强语义）         | `src/bridge.ts:4851-4859`                                                                            |
| acp-bridge     | 记录 `agentCapabilities` 到 `ChannelInfo`          | `src/bridge.ts:4823-4846`、`ChannelInfo` 定义 `:916+`                                                |
| acp-bridge     | 新增 Claude channel factory                        | 新文件，参照 `src/spawnChannel.ts:434`                                                               |
| cli/serve      | **workspace 身份按 `(cwd, backend)` 重新键**       | `workspace-registry.ts:265`、`:293-299`、`:396-404`、`:476-527`、`:557-571`                          |
| cli/serve      | runtime 解析接受 backend 维度                      | `resolveWorkspaceCwd`、`getManagedEntryByWorkspaceCwd` 及消费者                                      |
| cli/serve      | 装配 Claude runtime（同 cwd 附加）                 | `run-qwen-serve.ts:5103/6022/6682` 附近                                                              |
| cli/serve      | 建会话路由的后端判别式                             | `session.ts:943` `resolveRuntimeForSessionCreation`、`session.ts:3102-3117`、`requireSessionRuntime` |
| cli/serve      | `/workspace/:cwd/...` 路由的 backend 判别（见 Q6） | `routes/*`、`acpRouteTable.ts`                                                                       |
| cli/serve      | `approvalMode → permissionMode` 映射               | 建会话路径，参照 `qwen-live/src/adaptor/acp-adaptor.ts:214`                                          |
| cli/serve      | `-32601` → 501                                     | `server/error-response.ts:257-1030`                                                                  |
| cli/serve      | 能力位按 runtime 下发                              | `capabilities.ts`、`routes/capabilities.ts:118-134`                                                  |
| sdk-typescript | 暴露 runtime 级能力；建会话支持后端选择            | `DaemonClient.ts:583-638`、`:2986-3008`                                                              |
| web-shell      | 会话分组按 `workspaceId` 而非 cwd（见 Q7，待核实） | `client/session-catalog/`、`sidebar/WorkspaceSection.tsx`                                            |
| web-shell      | 7 条诊断面按能力门控                               | `App.tsx`、`daemon/session/actions.ts`、相关面板组件                                                 |

需要门控的 7 条路由（实测全部 500）：`/session/:id/context`、`/context-usage`、
`/supported-commands`、`/tasks`、`/lsp`、`/hooks`、`/stats`。
其中 `/context-usage` 可改吃 `usage_update` 事件（Claude 原生上报），成本最低、收益最直接。

另有两个建会话 drop point 必须同时改，否则字段会被静默丢弃：
`POST /session` 的 `session.ts:3102-3117`（逐字段枚举，从不 spread body）
与 SDK 的 `DaemonClient.ts:2986-3008`（同样逐字段枚举）。
`safeBody`（`server/request-helpers.ts:118-129`）无 schema、无 allowlist，未知字段是**忽略**而非拒绝。

## 5. 范围边界

**在范围内**：Claude Code 单一外部后端；同一 workspace 内 Qwen 与 Claude 会话混跑
（经同 cwd 多 runtime 实现）；建会话/聊天/流式/授权/工具调用/diff/context 用量；
7 条诊断路由的门控；guard 协商化；`-32601` → 501；workspace 身份按 `(cwd, backend)` 重新键。

**明确不在范围内**：

- per-session 的 **channel** 选择（即单个 bridge 内同时持有多条不同后端的 channel）。
  混跑由多 runtime 达成，bridge 通道生命周期不变量不动 —— 见决策 1 的取舍说明
- 其他外部 agent（Codex / Gemini 等）。factory 与能力位应设计成可扩展，但本 PR 只接 Claude
- 会话持久化与恢复的跨后端语义（Claude 有 `loadSession`/`resume`/`fork`，但 qwen 侧的
  transcript 持久化是 `qwen/*` ext method，外部后端不具备）
- `qwen/control/*` 变更类 ext method 的任何替代实现（side task、fork、rewind、goal、memory、
  workflow 等）。这些面在 Claude 后端下应**隐藏**，不是降级实现
- 终端级集成（herdr 路线 B）

## 6. 兼容性

- guard 协商化对 qwen 子进程**行为不变**：它本来就回显 ack
- `-32601` → 501 是唯一可能影响既有客户端的改动，见 §7 Q2
- 新增能力位必须是**可选**的：老 SDK 看不到新 tag 时，行为与今天一致
- 不新增对 `@agentclientprotocol/claude-agent-acp` 的硬依赖：应像 `qwen-live/src/agent-detector.ts:67-72`
  那样按需 `npx -y` 解析，未安装 Claude 时该后端不可发现

## 7. 待确认问题

**已确认（2026-09-03）**

- ~~Q1 后端粒度~~ → **必须支持同一 workspace 内混跑**，实现方式取"同 cwd 下附加 runtime"，
  因此需要 workspace 身份重新键（见决策 1）。bridge 通道生命周期不变量不动。
- ~~Q3 UI 呈现~~ → **同 workspace 下的附加 runtime**，复用 `capabilities.workspaces[]` 的 `kind` 字段。

**仍需确认**

**Q2 —— 已核实**：qwen 自己的子进程**确实会**回 `-32601`。
`packages/cli/src/acp-integration/acpAgent.ts:13166-13167` 的 ext method 分发 default 分支即
`throw RequestError.methodNotFound(method)`，因此"新 daemon 调用旧 child 未实现的方法"这一版本偏移
场景会产生同一个 code。

但影响可控：

- `packages/cli/src/serve` 的测试中 `-32601` / `methodNotFound` **仅 2 处命中，且都在 ACP-HTTP/WS
  transport 层**（`acp-http/client-mcp-ws.test.ts:150`、`acp-http/transport.test.ts:3922`，后者断言的是
  JSON-RPC `frame.error.code` 而非 HTTP 状态）。**没有任何 REST 测试断言 500**，故 REST 侧改动的
  测试爆炸半径很小。
- 语义上 501 对版本偏移**同样更准确**（"该后端未实现此方法"），不比 500 差。

**遗留不一致**：SDK 的 ACP transport 仍把 `-32601` 映射成 404（`acpTransportUtils.ts:72`）。
若只改 REST 侧为 501，两条 transport 对同一失败仍不一致。需决定是**两侧统一到 501**，
还是接受这一差异。本设计倾向统一到 501，但需先确认 `acpTransportUtils.ts:72` 的 404 有无外部消费者
依赖（尚未核实）。

**Q6（决策 1 引出，阻塞级）**：workspace 身份重新键后，`/workspace/:cwd/...` 系列 HTTP 路由的
backend 判别放在**路径段**还是**query 参数**？路径段会改动 URL 形状（影响 SDK 路由表、e2e、
既有客户端兼容）；query 参数改动小但语义弱，且需要为"未指定时默认哪个 runtime"定义规则。
本设计倾向 query 参数 + 显式默认（未指定即 primary/Qwen），以保持向后兼容。

**Q7（决策 1 引出）—— 已核实，答案为"否"**：Web Shell 的会话目录**按 cwd 索引，不是 workspaceId**。
证据：`client/session-catalog/workspace-session-live-state.ts:33-34` 输入为 `workspaceCwds` /
`groupWorkspaceCwds`；`:78` 以 `[...new Set(workspaceCwds)].sort().join('\n')` 去重；
返回的 `ReadonlyMap<string, DaemonSessionGroupCatalog>` 的 key 即 cwd（`:103-104`
`[...current.keys()].every((cwd) => activeTargets.has(cwd) && groupTargets.has(cwd))`）；
客户端另有 `workspaceByCwd` 方法（见 `session-catalog-hooks.test.tsx:79,262`）。

**后果**：同 cwd 的两个 runtime 在 Web Shell 侧会**塌成一个条目**，Claude 会话与 Qwen 会话无法分列。
因此"同 cwd 附加 runtime"方案还必须把会话目录的索引键从 cwd 改为 workspaceId，
涉及 `workspace-session-live-state.ts`、`session-catalog-store.ts`、相关 hooks 与
`sidebar/WorkspaceSection.tsx`，以及 `workspaceByCwd` 这一客户端 API 的形状。
这使决策 1 的成本显著高于最初估计 —— 身份重新键在 **daemon 与前端两层都要做**。

**Q4**：`docs/users/features/multi-agent-coordination.md:28` 目前把跨厂商协同划给 herdr。
本设计改变该产品边界，需要同步更新该文档，并确认这一边界变更已被认可。

**Q5**：Claude adapter 有自己的 ext 命名空间（实测 `_meta.goal.controlMethod = "_session/goal"`），
与 qwen 的 `qwen/control/session/goal/*` 功能重叠但名字不同。是否要桥接？本设计倾向不桥接（超出范围）。

## 8. 备选形态：Claude Code 作为 SubAgent（路线 C）

§1–§7 描述的是"对等后端"形态（路线 A）。本节记录另一形态的实证评估，**最终形态待定**。

### 8.1 结论

**可行，且基础设施成本显著低于路线 A —— 但它不是配置改动，需要一个新的执行器实现。**

subagent 槽位在本仓库里**不是执行器抽象，而是配置抽象**：`SubagentConfig`
（`packages/core/src/subagents/types.ts:51-172`，字段为 `name`/`description`/`tools`/`disallowedTools`/
`approvalMode`/`systemPrompt`/`level`/`model`/`runConfig`/`permissionMode`/`maxTurns`/`mcpServers`/`hooks` 等）
是一束 prompt/model/tools 配置，交给唯一硬编码的 in-process 执行器
（`SubagentManager.createAgentHeadless` `subagent-manager.ts:824` → `AgentHeadless.create`
`agents/runtime/agent-headless.ts:174` → `new AgentCore` `:186`）。
**没有任何字段可以指认外部可执行文件或 ACP 端点**；`model?` 只能改 provider 路由（可指向 Anthropic），
仍是 Qwen 的 `ContentGenerator`，不是执行器选择器。

### 8.2 存在一个休眠的外部进程执行器接缝

`packages/core/src/agents/backends/`：

- `types.ts:47-58` `AgentSpawnConfig` **已带** `command: string`（注释原文 _"Command to execute
  (e.g., the CLI binary path)"_）、`args: string[]`、`cwd`、`env?`、`cols?`、`rows?`、`backend?.tmux`，
  以及可选的 `inProcess?: InProcessSpawnConfig`
- `types.ts:163` `interface Backend` 有 `spawnAgent(config: AgentSpawnConfig)`；实现有三个：
  `InProcessBackend`、`TmuxBackend`、`ITermBackend`
- **但 `detect.ts:37-45` 无条件返回 `InProcessBackend`**，注释原文 _"Currently only in-process mode is
  supported. Other backends (tmux, iterm2) are kept in the codebase but not wired up as entry points"_，
  其后约 40 行分发逻辑全部被注释掉
- `InProcessBackend.spawnAgent`（`:100-106`）在缺 `config.inProcess` 时**直接 throw**，故 `command`/`args`
  在唯一可达的 backend 上是死字段；`TmuxBackend.spawnAgent`（`:149`）会真的构建命令并开 pane，但不可达
- **且 `Backend` 根本不在普通 subagent 路径上** —— `createAgentHeadless` 直接调 `AgentHeadless.create`，
  只有 `TeamManager` 与 `ArenaManager` 消费 `Backend`

### 8.3 真正的集成契约：`AgentEventEmitter`

`packages/core/src/agents/agent-transcript.ts:455-458`：

```ts
export function attachJsonlTranscriptWriter(
  emitter: AgentEventEmitter,
  jsonlPath: string,
  options: AttachJsonlOptions,
): AttachJsonlTranscriptResult;
```

它 keyed 在 emitter 接口上，**不依赖 `AgentCore`**。调用侧（`tools/agent/agent.ts:3041-3061`）只需要
`result.subagent.getCore().getEventEmitter?.()`（带 `?? this.eventEmitter` 兜底）、`.execute(...)`、
`result.dispose`。

因此：**任何能产出 `AgentEventMap` 契约事件（`agents/runtime/agent-events.ts:35-71`）的东西，
就免费获得 JSONL transcript、`.stream` 实时 tail、virtual subagent session、以及 Web Shell 的
`SubagentDetail` 面板。**

### 8.4 路线 C 免费复用的既有机制（均已核实存在）

| 机制                                                                                      | 位置                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 嵌套权限桥：把 worker 的审批请求以**父 session id** 发给 daemon 中介，且 fail-closed      | `cli/src/acp-integration/session/SubAgentTracker.ts:210-297`（`:236-260` 明确用 `sessionId: this.ctx.sessionId`）、`Session.ts:11769-11788`                                                                                             |
| 执行器无关的 transcript writer                                                            | `core/src/agents/agent-transcript.ts:455`                                                                                                                                                                                               |
| virtual subagent session 合成（自有 sessionId、自有 EventBus、SSE、replay、load、cancel） | `cli/src/serve/virtual-subagent-sessions.ts`（id 合成 `:229`，轮询 250ms `:31`），5 条路由白名单（`routes/session.ts:3434/4616/4687/5579/5630`、`routes/sse-events.ts:345`）                                                            |
| Web Shell 面板：**完整** transcript + 每轮 artifacts + 文件 diff + Stop                   | `web-shell/client/components/artifacts/SubagentDetail.tsx:229-247`（唯一使用 `subagentTranscriptMode="full"` 的地方）、`ArtifactPanel.tsx:180/887`                                                                                      |
| 已能驱动任意外部 ACP agent（含 Claude Code）的客户端                                      | `qwen-live/src/adaptor/acp-adaptor.ts:138`、`qwen-live/src/agent-detector.ts:66-73`                                                                                                                                                     |
| 只读钉扎与 worktree 钉扎原语                                                              | `core/src/agents/team/TeamManager.ts:561-570`、`core/src/agents/worktree-pin.ts:29`                                                                                                                                                     |
| **agent 定义文件已逐字镜像 Claude Code 的 schema**                                        | `core/src/subagents/agent-frontmatter-schema.ts:10-13` 原文 _"Mirrors Claude Code 2.1.168's `.claude/agents/<name>.md` schema verbatim so a user can drop a Claude Code agent file into `.qwen/agents/` and have it parse identically"_ |

最后一条尤其重要：**项目已经在"定义层"刻意兼容 Claude Code**，把兼容延伸到"执行器层"是自然延续。

### 8.5 路线 C 必须新建的部分

1. **执行器接缝**：普通 subagent 路径上没有 `Backend`。要么把 `Backend` 接进 `createAgentHeadless`，
   要么在该处新增分派。注意 `AgentHeadless` **没有接口**，调用方用的是具体类。
2. **`packages/core` 内的 ACP 客户端能力**：`packages/core/package.json` **无 `@agentclientprotocol` 依赖**。
   全仓仅 4 处构造 `ClientSideConnection`（`acp-bridge/src/bridge.ts:4545`、
   `channels/base/src/AcpBridge.ts:176`、`vscode-ide-companion/src/services/acpConnection.ts:217`、
   `qwen-live/src/adaptor/acp-adaptor.ts:679`），**无一在 `packages/core`**。
   → 执行器应放在 `packages/cli`（已有该依赖），而非 core。
3. **ACP → `AgentEventEmitter` 翻译**。契约是 Qwen 形状的，映射并不干净：
   - `AgentToolResultEvent.responseParts` 是 `@google/genai` 的 `Part[]`（`agent-events.ts:135`）
   - `AgentRoundTextEvent.usageMetadata` 是 `GenerateContentResponseUsageMetadata`（`:99`）
   - `AgentApprovalRequestEvent.confirmationDetails` 是 Qwen 的 `ToolCallConfirmationDetails` 联合
     （`{type:'edit',fileName,fileDiff}` / `{type:'exec',command}` …，`:29-32`、`:186`），
     不是 ACP 的 `toolCall` + `options[]`
   - `SubAgentTracker.createToolCallHandler`（`:126-166`）会 `toolRegistry.getTool(event.name)` 取展示元数据；
     Claude 的工具不在 Qwen 的 `ToolRegistry` 里，但代码已优雅降级（`:139-143` catch 后用默认值），
     故是**保真度损失而非崩溃**
4. **权限方向是反的**。`SubAgentTracker` 做的是 Qwen-internal → ACP-out；路线 C 需要 ACP-in → Qwen-internal：
   收到 Claude 的 `session/request_permission`，合成 `AgentApprovalRequestEvent`，
   再由既有机制把它以父 session id 发出去。`qwen-live/src/adaptor/acp-adaptor.ts:813-861`
   `onRequestPermission` 已实现前半段（park resolver、`classifyOption`、校验所选 `optionId` 确曾被提供）。

### 8.6 硬约束（不可绕过）

- **权限请求必须挂在父 bridge session id 下**。`MultiClientPermissionMediator` 的 `emit` 与
  `votersForSession` 都经 `byId.get(sessionId)` 解析（`acp-bridge/src/bridge.ts:4127-4140`），
  而 virtual subagent id（`subagent.X.Y`）**不在 `byId` 里** → `emit` 静默 no-op、投票者集合为空。
  这正是 `SubAgentTracker` 用 `this.ctx.sessionId` 而非合成 id 的原因。
- **面板是"只读 + Stop"**。`SubagentDetail.tsx:232` 硬编码 `pendingApproval={null}`；SDK 只有
  `resolveSubagentSession` 与 `cancelSubagentSession`（`DaemonClient.ts:3228,3240`）；
  服务端也没有任何接受 virtual id 的 `prompt` 路由。
  → **能看、能停、能在父会话的权限 UI 里批准它的工具调用，但不能直接和它对话。**
- **模型侧天然是"把 Claude 当函数调"**：`core/src/agents/subagent-result.ts:139`
  `toModelVisibleSubagentResult` 只把一个摘要结果回灌父上下文。

### 8.7 Agent Team 不是更好的宿主 —— 反而更差

teammate 与普通 subagent **用同一个 in-process `AgentCore`**（`InProcessBackend.spawnAgent`
→ `new AgentCore` `:166` → `new AgentInteractive` `:181`），无独立进程/PTY/ACP 会话。

而且其审批链路在 daemon 拓扑下是断的：`TEAMMATE_APPROVAL_REQUEST` 全仓**只有一个生产监听者**
`cli/src/nonInteractiveCli.ts:1007`（stream-json headless 模式），
`cli/src/acp-integration/` 内 **零命中**，`web-shell/client/` 内**没有任何 teammate UI**
（`teammate|agentTeam|AgentView` 仅 1 处注释命中）。
`TeamManager.ts:2032-2038` 的 JSDoc 自己写明了后果：_"If nobody handles the event the tool will
remain blocked until the agent's stall timeout."_

另：`core/src/agents/team/leaderPermissionBridge.ts` 是**死代码** —— `registerLeader` 零生产调用者，
`tools/team-create.ts:158-163` 的注释明确说明了这点。

### 8.8 两条形态对比

| 维度                    | 路线 A（对等后端）                     | 路线 C（SubAgent）                                                         |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| workspace 身份重新键    | **必须**，且 daemon + 前端两层         | **完全不需要**                                                             |
| HTTP URL 面改动         | 必须加 backend 判别式                  | 无                                                                         |
| bridge 通道生命周期     | 不动（每 runtime 一条 channel）        | 不动                                                                       |
| guard 握手协商化        | 必须                                   | 不需要（Claude 不是 daemon 的 ACP 子进程）                                 |
| `-32601` → 501          | 必须                                   | 不需要（不经 `qwen/*` ext method）                                         |
| transcript / SSE / 面板 | 复用现有主会话链路                     | **复用 virtual subagent 全套，已建好**                                     |
| 权限审批                | 直接进 mediator                        | 经 `SubAgentTracker` 以父 session id 进 mediator，**已建好且 fail-closed** |
| 需要新建                | Claude factory + 身份重新键 + 能力门控 | ACP→`AgentEventEmitter` 翻译 + 执行器接缝                                  |
| 新增依赖位置            | `acp-bridge` / `cli/serve`             | `packages/cli`（core 无 ACP 依赖）                                         |
| 产品形态                | 可直接对话的一等会话，可与 Qwen 混跑   | **委派 + 观察 + 停止 + 在父会话批准**；不能直接对话                        |
| 与既有产品语言          | 新增"后端"概念                         | 契合既有 subagent / `/coordinate` / Arena 语言                             |

### 8.9 建议

**先做路线 C，再按需做路线 A**，理由：

1. 路线 C 避开了整个"身份重新键"成本（本设计中最大、最危险的一块，且横跨 daemon 与前端两层）
2. 路线 C 复用四套**已建成且已验证**的机制（transcript writer、virtual session、`SubagentDetail`、
   `SubAgentTracker` 权限桥），新建部分集中在一个明确的翻译层
3. 路线 C 的翻译层（ACP `session/update` → `AgentEventEmitter`、ACP-in → Qwen-internal 权限）
   **对路线 A 同样有用**，不是丢弃式投入
4. 项目已在定义层镜像 Claude Code schema，执行器层兼容是自然延续

**但必须先确认产品意图**：若"管理 claude code"意指**像对待 Qwen 会话一样直接对话、混跑、独立持久化**，
路线 C 不满足（面板无 composer、无 prompt 路由、模型侧只回摘要），仍需路线 A。
若意指**把 Claude 当作可观察、可停止、可审批的委派工人**，路线 C 足够且便宜得多。

> **待用户确认（阻塞级）**：选路线 A、路线 C，还是 C 先行 A 后续。

---

# 决策记录（2026-09-03）

**已选定路线 C（Claude Code 作为 SubAgent）。路线 A 暂缓**，§1–§7 保留作为将来若需要
"可直接对话的对等会话 + 同 workspace 混跑"时的评估依据 —— 其中 guard 协商化（决策 2）、
`agentCapabilities` 不再丢弃（决策 3）、`-32601` 表达统一（决策 5）三项**与形态无关**，
即使只做路线 C 也仍是独立成立的改进，可拆为单独的小 PR。

以下为路线 C 的实施设计。

## 9. 路线 C 实施设计

### 9.1 执行器接缝：引入 `SubagentExecutor` 接口

`SubagentManager.createAgentHeadless`（`packages/core/src/subagents/subagent-manager.ts:824`）
当前返回**具体类**：

```ts
): Promise<{ subagent: AgentHeadless; dispose: () => Promise<void> }>
```

`AgentHeadless` 无接口，调用方直接用具体类。改为返回一个 `AgentHeadless` 所满足的接口。

> **更正**：本节初版曾断言"接口面已被实测收窄到很小"，依据是全仓生产代码对 `getCore()` 仅 5 处使用。
> 该断言**错误** —— 它只统计了 `getCore()`，漏掉了调用方直接打在 `subagent` 上的其余成员。
> 完整枚举见下。

**完整生产调用面**（排除 `*.test.ts`；来源：`tools/agent/agent.ts`、
`agents/background-agent-resume.ts`、`agents/runtime/workflow-orchestrator.ts`）：

| 成员                                                | 是否可选链           | 位置                                                                                              |
| --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `execute(ctx, signal?, {resetStats?})`              | 否                   | `agent.ts:1922,2135,3495`、`background-agent-resume.ts:1263,1839`、`workflow-orchestrator.ts:732` |
| `getFinalText()`                                    | 否                   | `agent.ts:1890,2148,3218,3523`、`background-agent-resume.ts:1282,1808`                            |
| `getTerminateMode()`                                | 否                   | `agent.ts:2149,3522`、`background-agent-resume.ts:1280`、`workflow-orchestrator.ts:742`           |
| `getExecutionSummary()`                             | 否                   | `agent.ts:2155,3324,3376`、`background-agent-resume.ts:394`                                       |
| `executeExternalInputs(...)`                        | 否                   | `agent.ts:3488`、`background-agent-resume.ts:1256`                                                |
| `getCore()` → `getEventEmitter()`                   | 部分是               | `agent.ts:3061,3313`、`background-agent-resume.ts:1151`                                           |
| `getCore()` → `modelConfig.model`                   | 否                   | `agent.ts:3295`                                                                                   |
| `getCore()` → `runtimeView?.contentGeneratorConfig` | 可选链               | `agent.ts:3296`                                                                                   |
| `setExternalMessageProvider()`                      | **否**（2 处非可选） | `agent.ts:3365`、`background-agent-resume.ts:1104` 非可选；`agent.ts:3870,4014` 用 `?.`           |
| `setExternalMessageWaiter?.()`                      | **是**               | `agent.ts:3368,3871,4017`、`background-agent-resume.ts:1107`                                      |
| `setExternalMessageWaitPredicate?.()`               | **是**               | `agent.ts:3371,3874,4020`、`background-agent-resume.ts:1111`                                      |

即接口需 **7 个必选成员（含 `setExternalMessageProvider`）+ `getCore()` 的 3 个子成员**，
另有 2 个成员调用方**已用可选链**，可安全缺省。

> 实测校正：`setExternalMessageProvider` 初版被归为"已用可选链"，实际有 2 处非可选调用
> （编译期以 TS2722 暴露），故已改为必选。无 mid-turn 输入通道的执行器应接受并保留该
> provider 而不据以行动。

### 9.1.1 ACP 执行器必须合成的成员及其保真度

| 成员                                               | ACP 对应                                                                      | 保真度                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getFinalText()`                                   | 末条 `agent_message_chunk` 累积                                               | 良好                                                                                                                                                                                                                      |
| `getTerminateMode()`                               | prompt 响应的 `stopReason`（实测 `end_turn`）                                 | **有损**：需映射到 `AgentTerminateMode`（含 `MAX_TURNS`、`LOOP_DETECTED` 等无 ACP 对应的值）                                                                                                                              |
| `getExecutionSummary()`                            | 实测 `usage_update` 为 `{size, used}`                                         | **真实缺口**：那是上下文窗口用量，**不是每轮 input/output token**。而该摘要喂 `workflow-orchestrator` 的预算记账（`outputTokens`，见 `workflow-orchestrator.test.ts:70` 注释）。ACP 驱动的执行器很可能只能给出 0 或估算值 |
| `executeExternalInputs()`                          | adapter 私有扩展 `_session/steering`（实测 `_meta.steering.supported: true`） | **已调研，可映射**，见 §9.1.2                                                                                                                                                                                             |
| `getCore().modelConfig.model`                      | 无                                                                            | 需桩值（如 `'claude-code'`），仅作标签                                                                                                                                                                                    |
| `getCore().runtimeView?.contentGeneratorConfig`    | 无                                                                            | 调用方已是可选链，留 `undefined`                                                                                                                                                                                          |
| `setExternalMessageProvider()`                     | 无直接对应                                                                    | **必选成员**（2 处非可选调用）。可接受并保留 provider 而不据以行动；真正的 mid-turn 注入走 `executeExternalInputs` + steering                                                                                             |
| `setExternalMessageWaiter?()` / `WaitPredicate?()` | 无                                                                            | 调用方已用可选链，可缺省                                                                                                                                                                                                  |

**结论修正**：路线 C 的翻译层比初版估计**更大**，且 `getExecutionSummary` 的 token 语义缺口会
影响 workflow 预算记账。这不改变"路线 C 仍比路线 A 便宜"的结论（身份重新键依然是更贵的一块），
但**它不是一个小改动**，且需要为 token 统计缺口决定策略（报 0 / 估算 / 从 adapter `_meta` 取）。

> **Q11 —— 已解决**：`getExecutionSummary()` 的 token 字段在 ACP 后端下**报 0**，
> 并让"不可用"这件事显式化。依据如下。
>
> **约束**：`AgentStatsSummary`（`agent-statistics.ts:17-30`）**12 个字段全部必选，无一可选**，
> 故 `undefined` 不是可选项。
>
> **报 0 的真实后果**：`WorkflowBudgetImpl.recordSpent`（`workflow-budget.ts:143-146`）
> 对非正增量静默丢弃，故 `_spent` 永不前进 → `remaining()` 恒定 → 预算闸门
> （`workflow-orchestrator.ts:1807-1815` 与 `:1872-1882` 的
> `budget.remaining() <= 0 → throw WorkflowBudgetExceededError`）**永不触发**，
> `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` 静默失效。
>
> **但爆炸半径有限**：该闸门是 **opt-in** 的 —— 默认 `total === null` →
> `remaining() === Infinity`（`workflow-budget.ts:126-129`），对未设该环境变量的用户
> 本就是 no-op。且它是文档化的**软闸门**，已知 overshoot 界为
> `(concurrency_window − 1) × per_dispatch_tokens`。其他上界（每轮 agent 数上限
> `workflow-orchestrator.ts:1816-1823`、`max_turns` / `max_time_minutes`）
> **独立于 token 仍然生效**，故外部执行器并非完全无上界。
>
> **不采用"从 `usage_update` 推 delta"**：`used` 是**上下文窗口占用量（level）**，
> 而 `AgentStatistics.recordTokens`（`agent-statistics.ts:96-106`）是**累加器**。
> 把 gauge 喂进累加器会得到"快照之和"，可能超过上下文窗口本身；
> 且该增量含 input，语义上不是 `outputTokens`，会让闸门**过早触发** —— 比报 0 更糟。
>
> **必须同时做到的诚实性补偿**：当一个设了 token 预算的 workflow 分派给外部执行器时，
> 发一次性诊断，避免闸门"静默"失效（`recordSpent` 丢弃非正增量本是设计意图
> ——"some dispatches return `output_tokens: 0` on early failures"——
> 所以失效与"合法的廉价运行"不可区分，必须靠额外信号）。
>
> **可诚实提供的字段**：`totalDurationMs`（`execute()` 外围 wall-clock）、
> `totalToolCalls` / `successfulToolCalls` / `failedToolCalls` / `toolUsage`
> （由翻译后的 TOOL_CALL 事件计数；注意 `AgentCompletionStats.toolUses` 本就来自
> **emitter 的本地计数器**而非 summary，见 `agent.ts:3315-3320` 注释，故工具计数天然诚实）、
> `successRate`（派生）。`rounds` 仅在 ACP 暴露轮次边界时可给，否则 0。

### 9.1.2 `executeExternalInputs` 的映射：adapter 私有 `_session/steering`（已调研）

adapter 源码 `acp-agent.js:100-103` 定义 `const STEER_METHOD = "_session/steering"`，注释原文：
_"Named `_session/steering` per the agreed ACP steering wire protocol; advertised to clients via the
top-level `InitializeResponse._meta.steering.supported`."_ —— 而 spike 实测该 adapter 的
initialize 响应确实带 `_meta.steering.supported: true`。

**请求形状**（`acp-agent.js:1213` `async steer(params)`）：

```json
{
  "sessionId": "...",
  "prompt": [
    /* 与 session/prompt 相同的 ACP content blocks */
  ],
  "_meta": { "steering": { "idleBehavior": "promptRequired" } }
}
```

**三种响应**：

| outcome          | 触发条件                                                                 | 语义                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `injected`       | 有未 settle 的轮次在跑                                                   | 消息推入同一 streaming input，由 SDK 路由进在跑的轮次。优先级通常为 `now`（抢占当前生成，打断单次响应或插在多步轮次的工具调用之间）；**当正等待权限或 elicitation 时改用 `later`** —— 打断该 SDK 回调会取消 ACP 请求并可能搁浅 prompt（adapter 注释引用 IJAI-1191）。被抢占的循环会自己发一个 `result`，故轮次被标记 `Turn.steeredEchoes`，改为在 SDK `idle` 时 settle |
| `promptRequired` | 会话空闲 **且** 请求带了 `_meta.steering.idleBehavior: "promptRequired"` | adapter **不**调 `prompt()`、不推 SDK input、不改 `turnQueue`；内容留给宿主，由宿主用标准 `session/prompt` 提交                                                                                                                                                                                                                                                        |
| `startedNewTurn` | 会话空闲且未 opt-in                                                      | 旧兼容行为：adapter 自己 detach 调 `prompt()`                                                                                                                                                                                                                                                                                                                          |

被 steer 的消息其输出走 `session/update` 流，**不在本响应里**。

**映射方案**：`executeExternalInputs(inputs)` →

1. 把 `AgentExternalInput[]` 翻译成 ACP content blocks
2. 以 `_meta.steering.idleBehavior: "promptRequired"` 调 `_session/steering`（**保留宿主控制权**，
   避免 adapter 自行 detach 起一个新轮次而绕过我们的生命周期与统计）
3. `outcome === 'injected'` → 返回，输出经既有 `session/update` 翻译路径流出
4. `outcome === 'promptRequired'` → 回落到普通 `session/prompt`

**注意**：`_session/steering` 是 **adapter 私有扩展，非 ACP 标准**。因此该映射是
Claude-adapter 专属能力；换其他外部 agent 时 `executeExternalInputs` 应直接退化为普通
`session/prompt`（成员本身是必选的，但实现可以只是"prompt"）。是否走 steering 应由
initialize 响应的 `_meta.steering.supported` 决定 —— 这也正好印证决策 3
（§3 决策 3：不再丢弃 initialize 响应的能力信息）的必要性。

### 9.1.3 prompt 渲染归属（褶皱 1 —— 已调研，结论：抽取成本低）

**渲染现场**：`AgentCore.buildChatSystemPrompt`（`agent-core.ts:2623-2650`，**`private`**），
由 `AgentCore.createChat`（`:536`）在 `:587-591` 调用；`createChat` 的两个生产调用方是
`agent-headless.ts:299` 与 `agent-interactive.ts:126`。

**它只碰五样东西**（已逐行核实，**零可变状态**）：

1. `this.promptConfig.systemPrompt`（`readonly` 构造字段，`agent-core.ts:414`）
2. `context` 参数（`ContextState`）
3. `options?.interactive` 参数
4. `this.runtimeContext.getUserMemory()`（`:2646`）
5. `this.runtimeContext.getAutoMemoryPrompt()`（`:2647`）

**不碰** chat session、tool declarations、history、hooks、stats、event emitter、AsyncLocalStorage。
唯一障碍是 `private` 修饰符，以及函数体内硬编码的 non-interactive 后缀（`:2634-2640`）。

**两个原语已经导出**：`templateString`（`agent-headless.ts:100`，`${key}` 替换，
**缺 key 会 throw**，见 `:117-123`）与 `assembleSystemPrompt`
（`core/prompts.ts:614`，负责 `base + contextFiles + appendPrompt + gitStatus + autoMemory` 的层序）。
history 侧的 `getInitialChatHistory`（`core/environmentContext.ts:501`）**也已是接受 `Config` 的导出函数**。

**方案**：把 `buildChatSystemPrompt` 的函数体抽成一个导出的独立函数
（入参 `promptConfig` / `context` / `options` / `runtimeContext`），`AgentCore` 改为调用它。
这是**无行为变更的最小重构**，且让 ACP 执行器能拿到逐字节相同的已渲染 system prompt。

**`PromptConfig` 的三个字段**（`agent-types.ts:21-42`，均可选，`:540-556` 校验至少有一个，
且 `systemPrompt` 与 `renderedSystemPrompt` 互斥）：`systemPrompt?`（模板，走渲染）、
`renderedSystemPrompt?`（**逐字使用**，不再模板化/不加后缀/不注入 memory，见 `:584-586`）、
`initialMessages?`（设置后**完全取代** env bootstrap，`:559-566`）。

**既有先例**：fork 路径**不渲染**，而是从父的活 `LlmChat` 捕获已渲染的
`generationConfig.systemInstruction`（`agent.ts:1684` → `:1813`；
`background-agent-resume.ts:1637` → `:1724`），再以 `renderedSystemPrompt` 交回 `AgentCore`。
`ArenaManager.ts:1087-1096` 直接调 `assembleSystemPrompt`，但那是**预组合**（产出模板字段，
稍后仍由 `buildChatSystemPrompt` 再渲染），不是独立渲染 —— 其注释 `:1083-1086` 明确说明
故意不含易变的 auto-memory 段。

**history 侧的未决点**：完整消息列表还需复现 `willHaveSkillTool()`（`agent-core.ts:627-641`，
`private`，读 `toolConfig` + `EXCLUDED_TOOLS_FOR_SUBAGENTS`，决定 `<available_skills>` 是否进 history）。
**对外部执行器而言这可能根本不需要** —— Claude 有自己的 skills 概念，注入 qwen 的
`<available_skills>` 反而误导。倾向于**外部执行器不构造 env bootstrap history**，
只发渲染后的 system prompt + 用户任务文本。

**实际生产占位符集只有两个**：`{task_prompt, hook_context}`。
builtin agent 的 prompt 里的 `${ToolNames.X}` 是 **TypeScript 模板字面量**，
模块加载期即解析，不会有活的 `${...}` 到达 `templateString`。
`hook_context` 在每次 `execute` 前被无条件设置（`agent.ts:2111,3103,3120,3471,3820` 等），
故 `${hook_context}` 不会 throw。

> **顺带发现（既存问题，非本特性引入）**：`initial_messages_override`
> 在 `agent-headless.ts:263` 被读取，但**全仓无生产 setter**（仅
> `background-agent-resume.test.ts:3172` 出现）—— 是个死开关。不在本 PR 范围内处理。

### 9.2 core↔cli 依赖方向：注入，不给 core 加 ACP 依赖

`packages/core/package.json` **无 `@agentclientprotocol` 依赖**，而执行器分派点在 core、
ACP 客户端能力只在 cli/acp-bridge/qwen-live。

**采用仓库既有的注入范式**（core 定义 setter，cli 注入实现），已核实三处 precedent：

- `Config.setSessionWorkflowEnabledProvider(provider?: () => boolean)` — `core/src/config/config.ts:7820`
- `Config.setModelInvocableCommandsProvider(...)` — `:9192`
- `Config.setMcpBudgetEventCallback(...)` — `:9825`

故：core 定义 `ExternalAgentExecutor` 接口 + `Config.setExternalAgentExecutor(...)`；
cli 实现 ACP 驱动并在校验/启动路径注入。`createAgentHeadless` 在识别到外部 agent 定义时
分派给注入的执行器，未注入则该定义不可用（显式报错，不静默降级为 in-process）。

**实现状态**：`ExternalAgentExecutor` / `ExternalAgentExecutorParams` 已定义于
`packages/core/src/agents/runtime/subagent-executor.ts`；`Config.setExternalAgentExecutor` /
`getExternalAgentExecutor` 已加（`packages/core/src/config/config.ts`，紧邻既有
`setSessionWorkflowEnabledProvider`）；`createAgentHeadless` 的分派与显式报错已落地。

> **实现期发现的额外约束（§9.2 初版未预见）**：core 的公共入口
> `packages/core/src/index.ts` **完全没有导出 agent-runtime 与 subagents 面** ——
> `agent-core.js`、`agent-headless.js`、`agent-statistics.js` 三个模块零命中，
> `AgentEventEmitter`、`AgentEventType`、`ContextState`、`AgentTerminateMode`、
> `AgentStatsSummary`、`SubagentConfig`、`ToolCallConfirmationDetails` 亦全部未导出。
> 而 AGENTS.md 禁止跨包相对导入，深路径导入又需要 `package.json` 的显式 subpath export。
>
> 因此 cli 侧执行器**无法**直接引用它需要实现的类型。解法沿用仓库既有范式：
> core 的 `package.json` 已在使用窄 subpath export（`./transcriptRecords`、
> `./envVarResolver`、`./goalWire`、`./memoryScopes`、`./subSessionConstants`），
> 故新增一个窄出口（如 `./subagentRuntime`），**只**暴露执行器契约与实现它所需的最小类型集，
> 不把这些内部类型灌进主入口。这样公共 API 扩张是有界且显式可评审的。
>
> 备选是给 `packages/core` 直接加 `@agentclientprotocol/sdk` 依赖并把执行器放进 core，
> 但那与本节"不给 core 加 ACP 依赖"的决策相悖，且把外部进程生命周期管理塞进 core。
> 不采用。

### 9.3 定义层选择器（**待定，见 Q8**）

`SubagentConfig`（`core/src/subagents/types.ts:51-172`）没有任何字段可指认外部可执行文件或 ACP 端点，
必须新增一个。

**张力**：`core/src/subagents/agent-frontmatter-schema.ts:10-13` 声明自己
_"Mirrors Claude Code 2.1.168's `.claude/agents/<name>.md` schema verbatim"_，
新增 qwen 专有字段会破坏这一逐字镜像。缓解事实：该文件采取 lenient posture
（`:15-20`，无效可选字段 drop 为 undefined 而非 throw），且 `SubagentConfig` 中
`runConfig`/`background`/`color` 等字段本就存在，需逐个确认哪些已是 qwen 扩展。

候选方案：

1. 新增顶层字段（如 `executor: { kind: 'acp', command, args }`）—— 表达力最强，偏离镜像最明显
2. 复用 `model?`（现为 `'inherit' | 'fast' | 'model-id' | 'authType:model-id'`，`types.ts:110`）
   扩展出一个 agent 标识 —— 改动最小，但语义混淆（model 是 provider 路由，不是执行器）
3. 独立的 `.qwen/external-agents/` 目录，不进 frontmatter 镜像 —— 隔离最干净，但新增一套加载路径

**倾向方案 1**，理由：执行器与模型是两个正交概念，混进 `model` 会长期误导；
方案 3 会让 `SubagentManager.loadSubagent`（`subagent-manager.ts:299-320`）的
session > project > user > extension > builtin 优先级链出现第二套规则。

**`command` 的语义必须由基线干跑校正（D9）**：E2E 干跑实测
**`claude --help` 在 2.1.259 上没有 `--acp` 标志**（grep `acp` / `agent-client` 零命中）。
因此 `executor.command` **不是** Claude 二进制，而是"**要执行的进程**"。Claude 的可调形态是
adapter 包本身，与 `packages/qwen-live/src/agent-detector.ts:66-73` 的解析结果一致：

```yaml
executor:
  kind: acp
  command: npx
  args: ['-y', '@agentclientprotocol/claude-agent-acp']
```

Claude 二进制的可用性由 adapter 内部负责（adapter 通过 `claudeCliPath()` 解析）。
故组 2 的探测应针对 `command` 本身可解析，而非分别探测 `claude` 与 adapter 包。

**实现状态**：`SubagentExecutorSpec` 与 `parseAgentExecutor` 已按此语义落地
（`packages/core/src/subagents/types.ts`、`packages/core/src/subagents/agent-frontmatter-schema.ts`）。
解析对 `kind !== 'acp'`、`command` 非字符串或 trim 后为空、`args` 非字符串数组一律
**整字段 drop**（不做部分过滤 —— 带着被静默截断的参数运行比不运行更糟），
由加载器发 `debugLogger.warn`。命令**可用性不在解析期检查**，留给注入的执行器在 spawn 时判断。

### 9.4 翻译层（路线 C 的主要新建工作量）

**方向一：ACP `session/update` → `AgentEventMap`**（`core/src/agents/runtime/agent-events.ts:35-71`）

契约是 Qwen 形状的，映射不干净，需逐事件处理：

| AgentEventMap                                   | Qwen 形状                                                                                                           | ACP 来源                              | 难点                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------- |
| `AgentToolResultEvent.responseParts`            | `@google/genai` 的 `Part[]`（`:135`）                                                                               | ACP `content[]` 块                    | 需构造 genai Part    |
| `AgentRoundTextEvent.usageMetadata`             | `GenerateContentResponseUsageMetadata`（`:99`）                                                                     | 实测 `usage_update` 为 `{size, used}` | 字段语义不同，需映射 |
| `AgentApprovalRequestEvent.confirmationDetails` | `ToolCallConfirmationDetails` 联合（`{type:'edit',fileName,fileDiff}` / `{type:'exec',command}`，`:29-32`、`:186`） | ACP `toolCall` + `options[]`          | 需按 `kind` 分派构造 |
| `STATUS_CHANGE` / `IDLE`                        | 驱动 `VirtualSubagentTarget.updateStatus`（`virtual-subagent-sessions.ts:307-317`）                                 | ACP 用 prompt 响应的 `stopReason`     | 需从 stopReason 合成 |

已实测可用的 ACP 输入（见 spike 报告 §发现 2）：`agent_message_chunk`（真 token 流式）、
`tool_call`（带 `kind:"edit"`、`locations`、结构化 `diff`、`_meta.claudeCode.toolName`）、
`usage_update`（`{size:1000000, used:33037}`）、`turn_complete`。

**保真度损失（非崩溃）**：`SubAgentTracker.createToolCallHandler`（`:126-166`）会
`toolRegistry.getTool(event.name)` + `tool.build(event.args)` 取展示元数据；Claude 的工具不在
Qwen 的 `ToolRegistry` 里，但 `:139-143` 已 catch 并用默认值继续。

**方向二：权限 ACP-in → Qwen-internal**

与 `SubAgentTracker` 现有方向**相反**。它做的是 Qwen-internal → ACP-out
（`AgentApprovalRequestEvent` → `RequestPermissionRequest`）。路线 C 需要：
收到 Claude 的 `session/request_permission` → 合成 `AgentApprovalRequestEvent` →
由既有 `SubAgentTracker` 机制以**父 session id** 发出 → 用户决策回来后 resolve 停在那儿的 ACP resolver。

前半段已有可参照实现：`qwen-live/src/adaptor/acp-adaptor.ts:813-861` `onRequestPermission`
（park resolver 到 `state.parkedPermissions`、`classifyOption` 分类、
`respondPermission` `:324-348` 校验所选 `optionId` 确曾被提供）。
其 header `:24-26` 记录了协议约束：_"The reply MUST select an offered optionId (the agent validates);
pick the least-escalating one."_

已实测的 Claude 权限请求形状（spike A/B 双 PASS）：

```json
{
  "toolCall": "Write perm-deny.txt",
  "kind": "edit",
  "options": [
    { "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
    {
      "optionId": "allow-with-updates",
      "name": "Yes, allow all edits during this session",
      "kind": "allow_always"
    },
    { "optionId": "reject", "name": "No", "kind": "reject_once" }
  ]
}
```

**必须遵守的硬约束**：权限请求只能挂在**父 bridge session id** 下。
`MultiClientPermissionMediator` 的 `emit` 与 `votersForSession` 均经 `byId.get(sessionId)` 解析
（`acp-bridge/src/bridge.ts:4127-4140`），virtual subagent id（`subagent.X.Y`）不在 `byId` 里，
会导致 `emit` 静默 no-op、投票者集合为空。

**授权模式**：不能继承用户本机 Claude 设置。实测本机为 `permissions.defaultMode: "auto"`，
adapter 在 `acp-agent.js:5205-5206` 读取它作为初始模式，导致工具**无询问直接执行**。
必须由 subagent 定义的 `permissionMode`/`approvalMode`（`SubagentConfig` 已有这两个字段）推导，
在 `session/new` 的 `creationOpts.permissionMode` 处设定（优先），或事后 `session/set_mode`（已实测可用）。
precedent：`qwen-live/src/adaptor/acp-adaptor.ts:214-222`。

### 9.5 白拿的既有机制（无需改动）

| 机制                                                                          | 位置                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| JSONL transcript + `.stream` tail                                             | `core/src/agents/agent-transcript.ts:455` `attachJsonlTranscriptWriter`（keyed 在 `AgentEventEmitter`，不依赖 `AgentCore`）       |
| virtual subagent session（id 合成 / EventBus / SSE / replay / load / cancel） | `cli/src/serve/virtual-subagent-sessions.ts`；路由白名单 `routes/session.ts:3434/4616/4687/5579/5630`、`routes/sse-events.ts:345` |
| 嵌套权限桥（父 session id + fail-closed）                                     | `cli/src/acp-integration/session/SubAgentTracker.ts:210-297`、`Session.ts:11769-11788`                                            |
| Web Shell 面板（完整 transcript + 每轮 artifacts + 文件 diff + Stop）         | `web-shell/client/components/artifacts/SubagentDetail.tsx:229-247`、`ArtifactPanel.tsx:180/887`                                   |
| 只读钉扎 / worktree 钉扎                                                      | `core/src/agents/team/TeamManager.ts:561-570`、`core/src/agents/worktree-pin.ts:29`                                               |

### 9.6 文件清单

| 层   | 改动                                                          | 文件                                                             |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| core | `SubagentExecutor` 接口；`createAgentHeadless` 返回类型改接口 | `subagents/subagent-manager.ts:824`、新接口文件                  |
| core | `SubagentConfig` 新增执行器字段 + frontmatter 解析            | `subagents/types.ts:51`、`subagents/agent-frontmatter-schema.ts` |
| core | `Config.setExternalAgentExecutor` 注入点                      | `config/config.ts`（参照 `:7820`）                               |
| core | `AgentEventEmitter` 适配面确认（不改契约，仅实现）            | `agents/runtime/agent-events.ts:35-71`                           |
| cli  | ACP 驱动执行器实现（spawn adapter、翻译层、权限桥接）         | 新目录，参照 `qwen-live/src/adaptor/acp-adaptor.ts`              |
| cli  | 外部 agent 探测（是否在 PATH、adapter 是否可用）              | 参照 `qwen-live/src/agent-detector.ts:66-73`                     |
| cli  | 注入执行器                                                    | 启动/校验路径                                                    |

**注意 AGENTS.md 门禁**：`packages/core/src/subagents/**`、`packages/core/src/agents/**`、
`packages/core/src/tools/**` 均属 core 模块。

### 9.7 范围边界

**在范围内**：Claude Code 单一外部执行器；前台与后台 subagent 两种启动路径
（`agent.ts:3158` 后台、`:3989` 前台，两者都挂 transcript writer）；
transcript / 面板 / 权限审批 / 停止。

**不在范围内**：

- 直接与被委派的 Claude 对话（面板无 composer、无接受 virtual id 的 `prompt` 路由、
  `SubagentDetail.tsx:232` 硬编码 `pendingApproval={null}`）—— 这是路线 A 的形态
- 其他外部 agent（Codex / Gemini）。执行器接口应可扩展，但本 PR 只接 Claude
- Agent Team / teammate 宿主。已核实**更差**：teammate 同为 in-process `AgentCore`，
  且 `TEAMMATE_APPROVAL_REQUEST` 全仓仅一个监听者（`cli/src/nonInteractiveCli.ts:1007`，
  stream-json headless），`acp-integration/` 零命中、web-shell 无 teammate UI，
  `TeamManager.ts:2032-2038` 自陈后果是"阻塞到 stall timeout"
- `qwen/control/*` 变更类能力的任何替代实现

### 9.8 待确认

**Q8（阻塞级）**：定义层选择器取 §9.3 的方案 1 / 2 / 3 哪一个？影响 frontmatter 镜像承诺与加载路径。

**Q9**：外部 agent 定义在**未安装 Claude / adapter 不可用**时的行为 —— 加载期就报错、
还是加载成功但调用时失败？倾向前者（与 `qwen-live/src/agent-detector.ts` 的
`probeVersion` + `findExecutable` 探测一致）。

**Q10**：`SubagentConfig` 已有的 `permissionMode` 与 `approvalMode` 两个字段语义如何分工？
路线 C 需要其中一个映射到 Claude 的 permission mode，需先确认现有语义避免冲突。
（实现期已部分回答：加载器 `subagent-manager.ts:1705` 已有
`claudePermissionModeToApprovalMode(permissionMode)` 桥接，`approvalMode ?? bridgedApprovalMode`
为最终值。故 `ExternalAgentExecutorParams` 同时传出两者，由执行器优先用 `permissionMode`
原文映射到 Claude 的模式名，缺失时回落 `approvalMode`。）

## 10. 实现状态（截至 2026-09-03）

分支 `feat/claude-code-subagent`（基于 `origin/main` `cca376f6aa`）。
**repo-wide `npm run typecheck` 全绿**；9 改 + 3 新，+225 / −32。

### 已完成

| 项                                                                                            | 文件                                                                        |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SubagentExecutor` + 收窄的 `SubagentExecutorCore` 接口                                       | `packages/core/src/agents/runtime/subagent-executor.ts`（新）               |
| `ExternalAgentExecutor` / `ExternalAgentExecutorParams`（含 `approvalMode`/`permissionMode`） | 同上                                                                        |
| `AgentHeadless implements SubagentExecutor`                                                   | `agents/runtime/agent-headless.ts`                                          |
| `createAgentHeadless` 返回类型放宽 + 执行器分派 + **未注入时显式报错**（关闭静默降级）        | `subagents/subagent-manager.ts`                                             |
| `SubagentExecutorSpec` 类型 + `SubagentConfig.executor?`                                      | `subagents/types.ts`                                                        |
| `parseAgentExecutor`（lenient 姿态，但指名外部进程故收紧）                                    | `subagents/agent-frontmatter-schema.ts`                                     |
| `Config.setExternalAgentExecutor` / `getExternalAgentExecutor`                                | `config/config.ts`                                                          |
| `renderSubagentSystemPrompt` 抽取（`buildChatSystemPrompt` 改为委托，行为不变）               | `agents/runtime/agent-core.ts`                                              |
| 窄 subpath export `./subagentRuntime` + barrel                                                | `packages/core/src/subagent-runtime.ts`（新）、`packages/core/package.json` |
| 7 处 `AgentHeadless` 类型位置放宽                                                             | `tools/agent/agent.ts`、`agents/background-agent-resume.ts`                 |

`executor` 字段**已不再是死开关**：声明了 `executor` 而宿主未注入执行器 → 抛
`SubagentError(INVALID_CONFIG)`，消息明确说明"拒绝 in-process 运行，因为那会静默替换成
定义并未要求的 agent"。这正是基线干跑（E2E 计划 8.3）识别出的核心产品风险。

### 未完成（下一步）

1. **ACP 执行器本体**（`packages/cli`，最大一块）：spawn adapter、`initialize` 握手并捕获
   `_meta.steering.supported`、`session/new` 带 `creationOpts.permissionMode`、
   `session/prompt`、`session/update` → `AgentEventEmitter` 翻译、
   `session/request_permission` → `AgentApprovalRequestEvent` 反向桥接、`dispose`。
   **开工前需先核实 `@agentclientprotocol/sdk` 的确切类型名**（`Client`、`SessionNotification`、
   `RequestPermissionRequest/Response`、`ContentBlock`、`StopReason` 等），不要凭记忆写。
2. CLI 启动路径注入 `config.setExternalAgentExecutor(...)`。
3. 单测（`parseAgentExecutor` 的 6 种输入、分派的显式报错、翻译层各事件）。
4. Phase 6 E2E（重点 3A 区分力断言与 8.3）、Phase 7 自审 + `/review`、Phase 8 截图与 PR。

### 实现期避开的坑（记录以免重犯）

- **执行器必须从 `runtimeContext` 读，不能从 `subagentContext` 读**：后者是派生 wrapper
  的独立实例，base Config 上的字段不保证可见（`setSessionWorkflowEnabledProvider` 的注释
  已警告过同类遮蔽问题）。
- **外层 catch 需对 `SubagentError` 直通**：否则执行器路径的报错会被包成
  "Failed to create AgentHeadless"，而该路径根本不构造 `AgentHeadless`。
- **`renderSubagentSystemPrompt` 不能放独立文件**：`templateString` / `ContextState` 是
  `agent-headless.ts` 的值/类导出，而 `agent-headless.ts` 已 import `agent-core.js`，
  独立文件会闭合成**运行时**导入环。
- **`setExternalMessageProvider` 是必选成员**：`agent.ts:3365` 与
  `background-agent-resume.ts:1104` 是非可选调用（初版误判为可选链，编译期 TS2722 暴露）。
- 在 doc comment 与其描述的声明之间插入代码会把注释变成孤立注释 —— 本次犯了三次
  （import、`PERMISSION_MODE_VALUES`、`AgentCore` 类注释），均已修正。
