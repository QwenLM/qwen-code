# 双引擎宿主接线

[English](./2026-09-26-paired-engine-host-wiring.md) | [简体中文](./2026-09-26-paired-engine-host-wiring.zh-CN.md)

## 状态

**优先级更新（2026-09-28）：** 保留已合入的 B2d 基础。普通宿主 Managed 引擎的
剩余工作（M2、M4–M6）后置到 Hosted Managed 首个可交付闭环之后，不是该闭环的
前置条件。M1 与 M3 已实现并保留；此后 M4 与 M2 已先行落地但不注册引擎，本地引擎
仍未注册。排期与按需子进程宿主决定见
[引擎状态](./2026-09-27-ordinary-host-managed-engine.zh-CN.md#状态)及 #12737。
本决定不推迟 Hosted 的 Runtime/Broker 工作与恢复验证。

#12737 的 B2d 切片设计，属于 #12380 的 Stage B 宿主接入，基于上游 `663d98eac5`。
已由 #12828 在 `--experimental-paired-engines` 开关之后实现，未注册 Managed 引擎。它把 #12737 中已决定的选择与范围规则
（[Q1/Q4](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5846602143)）
记录到本仓库，使 B2d 以本文而不是
[外部引擎选择设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-session-execution-engine.md)
为评审依据。本文承接[双引擎 owner 选择](./2026-09-26-paired-engine-owner-selection.zh-CN.md)
（B2a）。#12737 要求在普通宿主配对之前完成的切片均已合入：工作区契约（B2b，#12776
与 #12807）和按引擎的运维行为（B2c，#12795），它们落实了
[Q2/Q3 决定](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5846370487)。
Managed 引擎本身的设计见[普通宿主的 Managed 引擎](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)。
其 M1 切片完成下文 Managed 引擎接口中的 Legacy 拒绝与用途标记两项，该设计也确定了
该接口的待解问题。

## 问题与当前行为

在 #12698 与 B2a 之后，双引擎 Bridge 可以同时持有两个引擎，Legacy ACP 宿主会持久化
或核验会话 owner，宿主选择器会按该 owner 冷恢复会话。但没有任何生产构造点用到这些
能力：`runQwenServe` 的 primary、启动时 secondary、dynamic/replacement runtime，以及
`createServeApp` 的默认 Bridge，构造的都是单 factory Bridge。

决定哪些新会话可以在 Managed 上运行的规则，只存在于个人 fork 中的外部设计里，且只有
中文。B2a 的选择器用的是固定的 `newSessionEngine`。

此外，也没有可供普通宿主配对的 Managed 引擎。参考实现中的 Managed channel 是一个在
Tool Runtime 中执行工具的进程内 ACP 宿主，没有被引入上游。`--experimental-managed-*`
开关会使启动失败，Legacy ACP 宿主拒绝 Managed 选择，Hosted Harness（#12713）则在
进程内基于私有 Session Store 运行自己的会话，不经过 Bridge。

最后，未配对的 Legacy 宿主会拒绝恢复或 fork 带有 Managed Session header 的
transcript，但不会拒绝唯一 Managed 证据只是一条 `session_execution_engine` owner
记录的 transcript。目前还没有普通宿主会创建这种 transcript。

## 范围

范围内：

- 一个 daemon 级、默认关闭的显式开关（opt-in），作用于四处普通构造点。
- 双引擎宿主的选择策略：首阶段创建用途、Managed 引擎是否可用，以及按持久 owner
  冷恢复且不回退。
- 注册 Managed 引擎及其兼容评估的接口。B2d 不注册任何引擎。
- 配置兼容契约：在本文中定义，随 Managed 引擎一起实现。
- 在 Hosted Harness profile 中拒绝该开关。

不在范围内：普通宿主的 Managed 引擎与严格配置快照（二者以后一起落地）；工作区契约
（B2b）；按引擎的运维行为与隔离恢复（B2c）；默认启用；把 Hosted 会话迁到双引擎
Bridge；Java 承载的 Managed WebShell 产品链路；Managed 分支（仍保持拒绝）。不改变
任何 daemon 路由或 REST 形状。

## 方案

### 不变量

1. 会话的引擎在创建时固定。创建与冷恢复决定使用哪个通道；prompt、取消、审批、模型
   变更与关闭沿已绑定的连接执行；热 attach 复用存活的 entry。客户端元数据永远不能
   选择引擎。
2. 新会话只有在用途符合条件且配置被证明兼容时才在 Managed 上运行。延期或不确定的
   配置在 Legacy 上运行。
3. 冷恢复使用持久 owner。Managed owner 必须通过同一兼容规则；不通过时恢复准确失败，
   owner 保持不变。任何失败都不会选择、启动或派发到另一个引擎。
4. 没有 owner 记录的历史，只有在完整且可读时才视为 Legacy（B2a）。未知版本、非法值、
   冲突和读取失败都会拒绝。
5. 配对不会使会话、ID 或进程预算翻倍；两个引擎共用 Bridge 的准入。

### 开关与构造点

`qwen serve --experimental-paired-engines` 设置
`ServeOptions.experimentalPairedEngines`。不设置时，每个构造点保持现有的单 factory
构造。设置后，每个构造点改为传入由该 runtime 自身输入构造的 `executionEngines`，
而不是 `channelFactory`；Bridge 的其他选项全部不变。双引擎 Bridge 沿用 B2b 与 B2c
的默认值，包括 5 分钟的隔离排空期限；B2d 不为它们新增运维配置项。

| 构造点                 | 构造方                                          | Legacy factory                     | owner 读取位置                |
| ---------------------- | ----------------------------------------------- | ---------------------------------- | ----------------------------- |
| Primary                | 启动时的 `runQwenServe`                         | primary 的 spawn factory           | primary 的会话 runtime 目录   |
| 启动时 secondary       | `runQwenServe`，每个 secondary 工作区一个       | 该工作区的 spawn factory           | 其会话 runtime 目录           |
| Dynamic 与 replacement | `runQwenServe` 的工作区 runtime 工厂            | 新 runtime 的 spawn factory        | 其会话 runtime 目录           |
| 嵌入式默认             | 未注入 Bridge 或 registry 时的 `createServeApp` | 现在所用的 spawn factory，改为显式 | `Storage.getRuntimeBaseDir()` |

- Dynamic 工厂构造已注册的工作区、managed scratch 工作区，以及工作区信任变化时替换它的
  runtime，包括 primary 与启动时 secondary 的替换。替换 runtime 用自己的输入构造新的
  配对，绝不复用上一代的选择器或 factory。环境重载就地更新 runtime 的环境，不会构造
  新的配对。
- Conversations runtime（`live-conversation` provenance）保持单 factory。工作区路由
  永远不会解析到它；它的会话是 daemon 自有的 standalone 对话以及这些对话启动的会话，
  首阶段全部保持 Legacy。只有当其 Bridge 的每个 factory 都会转发子进程环境时，它的
  强制 writer lease 才被认证；双引擎 Bridge 会把这一要求扩展到一个它永远用不上的
  Managed factory。
- 通过 `deps.bridge` 注入的 Bridge 或注入的工作区 registry 仍由调用方控制；开关既不
  包装也不替换它们。`qwen serve` 自身会把工作区 registry 注入 serve app，因此在其中
  起作用的是 `runQwenServe` 的三处构造点；嵌入式默认 Bridge 由两者都不注入、并设置了
  该选项的嵌入方配对。
- 嵌入式默认 Bridge 从嵌入进程的 runtime 目录读取 owner，与它读取 artifact 快照和
  附件的位置相同；而它的子进程根据自身环境与工作区 settings 解析 runtime 目录。如果
  嵌入方的工作区 settings 改变了 runtime 目录，嵌入方需为自身进程设置
  `QWEN_RUNTIME_DIR`，使两者一致；否则双引擎嵌入式宿主会到错误的目录读取 owner，冷
  恢复返回 404。daemon 的各 runtime 会为其子进程设置该变量。
- Channels 没有自己的 Bridge。Channel worker 通过 daemon 创建会话，并带上
  `sourceType: 'channel'`，用途规则会让这些会话保持 Legacy。

### 选择

每个双引擎 runtime 有一个选择器，由 CLI serve 层基于 B2a 的 owner 选择器和下述规则
构造。Bridge 与现在一样，在共享准入和 ID 预留之后调用它。

**新会话**，按顺序：

1. 延期用途选择 Legacy：daemon 自有的 standalone 创建（`daemonOwnedStandalone`）；
   有父会话的会话（`parentSessionId`，涵盖子会话和其他子级会话）；worktree
   （`worktree`）或 Git 分支（`branch`）会话；`default` 以外的任何 `sourceType`，
   涵盖 channel、定时任务控制会话、side task、Tool-only 的 `managed-gateway` 会话以及
   未知的未来来源；以及带 `sourceId` 的 `default` 来源，内部创建方用它标记定时任务
   运行（`scheduled_task_run:`）和 Live 对话（`realtime_voice:`）。
2. 没有注册 Managed 引擎时，选择 Legacy。
3. 否则询问引擎的兼容评估。只有 `compatible` 选择 Managed；`deferred`、`unknown`
   或评估失败选择 Legacy。

只有没有来源，或来源为 `default` 且没有 `sourceId` 的会话，才是普通创建。
`daemonOwnedStandalone` 只由 daemon 内部创建设置，父会话、worktree 和分支由 daemon
路由设置。`sourceType` 和 `sourceId` 来自创建方，因此只能让会话失去资格；普通来源
不等于兼容证明。没有 Managed 引擎时，该策略不做任何 I/O，所有新会话都选择 Legacy。

**冷 load 与 resume。** B2a 选择器从会话自身的 transcript 读取已核验的 owner。

- Legacy owner 选择 Legacy。
- Managed owner 只有在注册了 Managed 引擎且其评估返回 `compatible` 时才选择
  Managed。否则选择器抛出 `SessionExecutionEngineError`，在任何通道启动之前以 409
  `session_execution_engine_unavailable` 应答；owner 记录保持原样。创建用途不再重新
  评估，因为 owner 已经反映了它们。
- 无法读取、冲突或不完整的归属会被拒绝，与 B2a 相同。这包括含有无法完整解析的行
  （例如写入中途崩溃留下的行）的 transcript，以及含有 daemon 当前版本不认识的记录
  类型的 transcript；见“风险与待定问题”。

**热 attach** 复用存活的 entry，不调用选择器。

| 操作                                 | 引擎的决定依据                                                    |
| ------------------------------------ | ----------------------------------------------------------------- |
| 新会话（REST、ACP、内部创建方）      | 上述策略，只选一次                                                |
| `single` attach、热恢复              | 已有 entry                                                        |
| 冷 load 或 resume                    | 持久 owner                                                        |
| Prompt、取消、审批、模型、cwd、关闭  | 存活会话的连接                                                    |
| 存活 transcript 与 turn 读取、flush  | 存活会话的 owner；没有存活 entry 的持久化读取走 Legacy 工作区通道 |
| 工作区 MCP、Hooks、skills 与状态控制 | Legacy 工作区控制通道；B2b 负责把影响会话的变更下发到存活引擎     |
| Fork、会话分支、会话内历史切换       | 已核验的源 owner；Managed 源会被拒绝                              |
| 关闭、强制退出、空闲回收             | 所有存活通道与在途创建                                            |

### Managed 引擎接口

要参与配对，Managed 引擎需要为每个工作区 runtime 提供：

- 一个 `ChannelFactory`，其宿主以 `managed` 遵循 B2a 契约：在任何初始化副作用之前
  持久化或核验 owner，之后才返回引擎回执；
- 一个基于选择上下文与该 runtime 输入的兼容评估，返回 `compatible`、`deferred` 或
  `unknown`，并附原因；
- 重新核验：在 Hooks、MCP、工具或模型启动之前，引擎宿主用它实际将使用的配置重新执行
  同一评估，不一致时准确地使创建或恢复失败，绝不回退；
- 生命周期：它的进程与资源参与 daemon 的关闭、工作区排空与撤销、代际失效以及环境
  重载，且一个工作区的清理绝不停止另一个引擎或工作区的进程；
- Legacy 拒绝：在创建任何会话之前，确保每个未配对的、会恢复或 fork transcript 的
  Legacy 入口都拒绝它的会话——要么它的 transcript 带有这些入口已经拒绝的 Managed
  Session header，要么把拒绝扩展到它的 owner 记录。否则关闭开关会让 Managed 会话在
  Legacy 上运行。引擎设计的 M1 把拒绝扩展到了 owner 记录；
- 工作区控制：权限规则与 Skills 变更需要 Legacy 工作区控制通道（B2b），因此只有
  Managed 存活时无法应用。由引擎切片决定宿主是否为这些路由启动工作区控制；B2d 中
  不会启动 Managed 通道，所以不会出现这种情况。引擎设计决定启动它（决定 3）；
- 有界的评估：Bridge 以其 initialize 超时限制每次选择（包括 owner 读取），超时的
  选择会使创建或恢复失败，而不是选择 Legacy。因此评估必须在该预算内充分提前完成。
  抛出异常或 reject 的评估按 `unknown` 处理；选择器不保留失败细节，因此由引擎按兼容
  契约中的日志规则自行记录其失败；
- 用途标记：在注册引擎之前，每个延期用途的内部创建方都要标记其会话，或以其他方式
  保持 Legacy。worktree 重置产生的替代会话目前没有标记：它创建时不带 `worktree`，
  之后才移入 checkout。Live 对话在项目中启动的任务也以无来源的方式创建线程，由引擎
  切片决定该线程是否属于 Live 用途。按上述规则，二者都是普通创建。引擎设计的 M1
  用 worktree 元数据标记 reset 的替代会话，引擎设计把 Live 线程保留为普通创建
  （决定 6）。

B2d 不注册任何引擎。此时双引擎的 `managed` factory 以“不可用”错误拒绝。没有注册引擎
时选择器永远不会返回 `managed`，因此不会走到这个 factory；它存在只是因为双引擎 Bridge
要求两个 factory 都存在。测试通过 serve app 默认 Bridge 的依赖项注册进程内替身，并
配一个桩评估。daemon 中 `runQwenServe` 的三处构造点不注册任何引擎，直到引擎切片为每个
runtime 构造引擎。

### 配置兼容契约

Managed 引擎切片实现该评估。它读取实际的工作区 runtime，对读取的内容绝不迁移、修复、
加锁或写入。

| 输入        | 只有满足以下条件才兼容                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区      | 已受信，且请求的规范化 cwd 等于 runtime 工作区                                                                                                                                              |
| 环境与 argv | 以 runtime 的有效环境（它决定 settings 与扩展的位置并替换 settings 变量）以及转发给子进程的参数（`--experimental-lsp`、`--restore-ask-user-question`）评估；启用延期能力的参数为 `deferred` |
| Settings    | 每一层（system defaults、system、user，以及受信时的 workspace）读取时都不写迁移、不备份、不重置，已知的旧版本只在内存中迁移；未知的 `$version` 或无法读取的层为 `unknown`                   |
| MCP         | 任何来源都没有 server：settings 各层、`.mcp.json`（保留其读取与解析错误）、`mcp.serverCommand`、扩展、agent 定义、运行时添加的 server、WebSocket 上的客户端 MCP，以及注入会话的 server      |
| Hooks       | 任何 settings 层（system、user，以及受信时的 project）、活动扩展，以及 skill 与 agent 定义的动态注册都没有 Hooks                                                                            |
| 扩展        | 以只读方式证明已安装集合为空，不经过 store 的加锁、恢复或 cache 刷新；部分或过期的证据为 `unknown`                                                                                          |
| 请求选项    | 引擎能够绑定所请求的模型服务、启动配置与审批模式                                                                                                                                            |

`deferred` 表示存在首阶段 Managed 引擎不支持的能力；`unknown` 表示有内容无法证明。
选择器与引擎的重新核验对可比较的输入使用同一规则，因此选择与初始化之间发生的变化会
准确失败，而不是带着延期能力进入 Managed。后续变更（例如运行时添加 MCP、客户端注册
MCP、Hook 或扩展重载）必须检查已有的 Managed owner，不能向其注入延期能力；Legacy
保持现有行为。日志只记录来源类别与原因，绝不记录配置值或凭据。

| 首阶段只在以下条件下选择 Managed                               | 首阶段对以下情况保持 Legacy                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 受信工作区中 cwd 精确匹配的普通用户会话                        | 已有的 Legacy 会话；用途或配置未知                                                       |
| 没有未迁移的 Hooks、动态 MCP 或扩展                            | Channel、定时任务、Standalone、Worktree 与 Branch 的创建；子会话、side task 与 Live 对话 |
| Harness、AgentBundle 与 Runtime 协议兼容，owner 与配置证明齐全 | 依赖未迁移的能力；证明不完整；服务端策略保留                                             |

### Hosted 边界

`validateHostedHarnessProfile` 在 `--profile hosted-harness` 下拒绝
`--experimental-paired-engines`，与它拒绝 channel、shell 和 Runtime Broker 选项一样，
使 Hosted 进程无法通过它仍会构造的 primary Bridge 进入配对。即使 B2c 定义了 Managed
预热与保活，Hosted 会话也继续留在以私有 Store 为权威的进程内 Harness 上：预热并不能
统一 Store 的权威与双引擎选择器读取的 transcript owner。把 Hosted 会话迁到双引擎
Bridge，需要单独的迁移设计，并证明 Store 权威与 transcript owner 一致。两条路径都保持
owner 固定、不跨引擎回退。

外部设计中“WebShell 不经四处普通 daemon factory 选择 Managed”的表述，指的是 Java
承载的 Managed WebShell 产品链路，并不取消普通本地 `qwen serve` 宿主的配对。

### 切换开关

在已有会话上打开开关时，这些会话按“没有 owner 记录的历史”规则在 Legacy 上恢复。
关闭开关时，每个双引擎 Legacy 会话保留其 owner 记录，未配对的 Legacy 宿主照常恢复
这类会话。没有 Managed 引擎时，双引擎宿主只会创建 Legacy 会话，因此打开或关闭开关都
不会把会话移到另一个引擎。Managed 引擎接口中的 Legacy 拒绝一项，保证 Managed 会话
出现之后这一点仍然成立。在此之前，如果双引擎宿主因 transcript 无法证明 owner 而拒绝
某个 Legacy 会话，运维人员也可以通过关闭开关来恢复它。

## 文件与使用方

| 领域       | 文件                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 开关       | CLI `commands/serve.ts`；`serve/types.ts`；`serve/hosted-harness-profile.ts`                                    |
| 配对与选择 | `serve/session-execution-engine-selector.ts`                                                                    |
| 构造点     | `serve/run-qwen-serve.ts`（primary、启动时 secondary、dynamic 与 replacement）；`serve/server.ts`（嵌入式默认） |
| owner 证据 | core `utils/transcript-records.ts`（owner 读取接受的记录类型）                                                  |
| 设计链接   | 本文；[ACP Bridge 执行引擎](./acp-bridge-execution-engines.zh-CN.md)                                            |

不新增 daemon 路由。工作区路由保持各自的作用域；会话路由保持存活会话 owner 或所选
runtime 的作用域，其错误分类沿用 B2a。

## 验证与验收标准

1. 开关关闭时，每个构造点完全按现有方式构造 Bridge，既有单 factory 测试保持通过。
2. 开关打开时，四处构造点各自用自己的 Legacy factory 与会话存储构造双引擎 Bridge；
   替换 runtime 得到新的配对；注入的 Bridge 与 Conversations runtime 不变。
3. 没有 Managed 引擎时，所有用途的新会话都在 Legacy 上运行，Legacy 宿主把 owner 写为
   transcript 的第一条记录。属于 Managed 的 transcript 在 load 和 resume 时于任何
   通道启动之前以 409 `session_execution_engine_unavailable` 失败，字节保持不变。
   Legacy 历史与没有 owner 的历史在 Legacy 上恢复。
4. 在 serve app 上注册替身后，双引擎嵌入式宿主能以两个引擎启动、恢复和关闭。
   即使评估返回 `compatible`，延期用途仍保持 Legacy。`deferred`、`unknown` 与失败的评估使新会话选择 Legacy，并
   使 Managed 恢复准确失败，且不向另一个引擎派发任何内容。
5. 会话存在之后修改替身的评估，既不改变已 attach 的会话，也不改变已持久化 owner 的
   会话。
6. `--profile hosted-harness` 与 `--experimental-paired-engines` 同时使用时启动失败。
7. 配对使用之后，未配对的宿主能恢复双引擎 Legacy 会话；双引擎宿主能在 Legacy 上恢复
   未配对期间创建的会话。
8. Build、typecheck、bundle、定向单元测试，以及以真实 Legacy 子进程对双引擎 daemon
   进行隔离的进程级检查：启动、创建、恢复与关闭。

## 风险与待定问题

- 在 Managed 引擎落地之前，开关不会在 Managed 上运行任何内容，但仍会在三方面改变
  Legacy 的行为。Legacy 会话从创建起就是持久的，并带来 B2a 所述的未使用会话只含 owner
  的 transcript。被隔离的 Legacy 通道遵循 B2c 的策略：拒绝新 prompt、关闭已结算的
  会话，并在排空期限内退役；而未配对的通道允许其会话继续 prompt 直至排空。因此，B2c
  批准时要求在 B2d 启用配对之前完成的后续项（#12811：隔离期间结束的后台任务不能卡住
  排空，退出核验须在开始终止时启动）同样适用于只有 Legacy 的双引擎宿主。此外，冷恢复
  会再读一遍 transcript 以核验 owner，因此更严格，见下面几项。
- 在引擎切片落地之前，serve app 的 Managed 引擎依赖项没有生产调用方；测试用它注册
  替身。
- 双引擎宿主的恢复比未配对宿主更严格。transcript 如果因为某行无法完整解析、或某条
  记录的类型不为 daemon 所知而无法证明 owner，会以 409 被拒绝，而未配对宿主会恢复
  它。写入中途崩溃会留下这样的行；writer lease 关闭时（这是默认值），之后的写入方会
  在它后面继续追加。原地升级的 daemon 在重启之前一直使用旧的记录类型列表，而它新启动
  的子进程可能已经写入更新的类型。目前没有任何机制修复这类 transcript；B2c 恢复的是
  通道，不是 transcript。B2d 仍允许在 lease 关闭时配对：该开关是实验性的且默认关闭，
  拒绝是准确的且不改动字节，关闭开关即可在 Legacy 上恢复该会话。已知记录类型与子类型
  列表现在覆盖 chat 记录类型的全部成员；该类型新增列表缺少的成员时，一个经过 typecheck
  的测试会失败；不以该类型构造记录的写入方不在其覆盖范围内。在此之前，记录过 text
  elements 的 Legacy 会话无法在双引擎宿主上恢复。
- owner 读取在选择预算（initialize 超时，默认 10 秒）内进行，而不是在恢复预算（默认
  60 秒）内。transcript 过大或存储过慢、无法在该预算内读完时，双引擎宿主上的恢复会
  失败。测试中读取 100 MB 的 transcript 远少于 1 秒。
- daemon 不清理旧 transcript，因此从未使用的会话留下的纯 owner transcript 会在双引擎
  宿主上累积（B2a）。默认启用之前需要给出处理方案。
- 用途规则依赖创建方标注的来源，而这些来源只能让会话失去资格。不标记其会话的延期
  用途内部创建方，在引擎出现后其会话就会变得有资格；Managed 引擎接口的用途标记一项
  列出了已知情况，引擎切片还要重新审计其余创建方。引擎设计的 M1 记录了这次审计。
- 在引擎设计的 M1 之前，未配对的 Legacy 宿主不识别 Managed owner 记录。在没有普通
  宿主创建 Managed 会话时这没有影响；Managed 引擎接口把补上这一点列为引擎切片的前置
  条件，该切片也确定 `session_execution_engine` 与 Managed Session header 的关系
  （引擎设计，决定 1）。
- 引擎如何把评估所用的输入交给其宿主做重新核验，与引擎一起决定：宿主重新读取并重新
  评估同一份严格快照（引擎设计，决定 5）。
