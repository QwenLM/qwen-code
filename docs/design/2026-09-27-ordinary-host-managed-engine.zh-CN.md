# 普通宿主的 Managed 引擎

[English](./2026-09-27-ordinary-host-managed-engine.md) | [简体中文](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)

## 状态

**优先级更新（2026-09-28）：后置到 Hosted Managed 首个可交付闭环之后。**
普通本地 `qwen serve` 的 Managed 执行是可选后续能力，不是 Hosted 交付的前置条件。
保留已合入的双引擎宿主基础、M1 保护（#12861、#12906）和 M3 兼容评估
（#12883、#12903）。M2 与 M4–M6（包括本地引擎注册及启用）列入低优先级待办；
在 Hosted 闭环的工具执行、持久结果和必要故障门禁验收后，再评估其排期。
后置不免除验收。本次修订还按子进程宿主边界调整了 M2/M5 的验收检查：M2 验证资源
清理与隔离；M5 允许宿主启动 worker 和记录会话，但工具文件写入与 Shell 进程仍在
worker 中执行。Hosted 所需的本地 Runtime worker、Broker、输出持久化和恢复验证
仍沿各自路线推进。排期由 #12380 与 #12737 跟踪。

[wenshao 在 2026-09-27 的宿主建议](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5858038609)
把原先嵌入 daemon 的 M2 方案改为按工作区 runtime 按需启动 Managed 子进程。
[doudouOUC 在 2026-09-28 的答复](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5864516602)
同意这一宿主边界，并为首版 M5 保留会话独占 worker。随后的
[排期更新](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5867178768)
调整了前两条评论中“先修订设计，再实现并验证 M2”的顺序，保留宿主边界与生命周期要求。
[wenshao 随后确认了更新](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5869898053)，
并暂存已准备的 M4 工作。[后来开出的 PR #12935](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5870071280)
用于等待期间的 CI 与评审，不改变后置交付的排期，也不注册或启用引擎。

普通 `qwen serve` 宿主的 Managed 执行引擎设计，对应 #12737 中
[双引擎宿主接线](./2026-09-26-paired-engine-host-wiring.zh-CN.md)（B2d，#12828）
留在范围之外的部分，服务于 #12380。基于上游 `302e7d88ef`；M3 的更新基于
`3f5ae3ffeb`。本文实现 B2d 设计中的“Managed 引擎接口”与“配置兼容契约”，并把工作
拆成 M1 到 M6 六个切片。M1 是 B2d 设计要求在任何 Managed 会话出现之前完成的前置条件
（Legacy 拒绝与用途标记），已经实现（#12861）；M1 的后续修改把拒绝扩展到重命名，并让
owner 证据与 owner 读取器一致。M3 是配置快照与兼容评估，已在 #12883 实现，并有
#12903 的后续修改。M2 以及 M4 到 M6 仍是后置提议，重新排期后各自落地时更新设计。

参考实现为分支 `doudouOUC/qwen-code:feature/managed-agents-p0-p8` 的
`032392a673`。本文记录哪些内容移植到上游、按什么顺序移植，以及上游移植在哪些地方
有意与参考实现不同。

## 问题与现状

以下描述 M1/M3 之前的原始基线。已完成的工作与当前排期见上方状态。

B2d 在 `--experimental-paired-engines` 之后为 daemon 的普通工作区 runtime 配对了
引擎，但没有注册任何 Managed 引擎：双引擎 runtime 的新会话全部在 Legacy 上运行，
Managed owner 以 409 `session_execution_engine_unavailable` 被拒绝。这样一个引擎所需
的部件，上游一个都没有：

- 生产中唯一的 ACP agent 是 `runAcpAgent` 内部构造的 `QwenAgent`。它绑定进程的
  stdin 和 stdout，会删除环境变量并重定向 console。`createInMemoryChannel` 虽然存在，
  但没有生产调用方。
- 在普通宿主上，所有工具都在承载会话的进程里执行。Managed Runtime worker
  （`qwen managed-runtime-worker`）通过 tool v2 路由执行 Read、Write、Edit 和前台
  Shell，但只有 Java Broker 会启动它；Hosted Harness 通过该 Broker 使用它来执行
  受开关控制的 Read、Write 和 Edit 回合（#12831）。`LocalManagedRuntimeProvider`
  依赖的 Bridge 方法没有任何实现，`LocalProcessRuntimeActivator` 使用的启动协议与
  worker 不一致；二者都没有生产调用方。
- Managed Session authority（#12693）只为 Hosted Harness 写 log，且通过 HTTP 存储；
  生产中没有任何代码通过其本地 JSONL journal 与资源存储写入 Managed Session log。
  Hosted Harness 运行自己的模型循环，通过 HTTP 和 SSE 而不是 ACP 提供服务，其工具
  回合需要 Java Runtime Broker。
- 读取配置会产生副作用或丢失证据。`loadSettings` 会迁移、备份并改写 settings 文件；
  读取 extension store 会加锁、恢复并写入；`.mcp.json` 的读取错误被当作文件不存在，
  解析错误只打印出来。没有任何只读快照能够证明某份配置兼容。

B2d 设计要求在第一个 Managed 会话出现之前满足的两项前置条件也尚未完成：

- 未配对的 Legacy 宿主会拒绝执行、记录、重命名或 fork 带有 Managed Session header
  的 transcript，但不会拒绝唯一 Managed 证据是一条指明 `managed` 的
  `session_execution_engine` owner 记录的 transcript。于是关闭开关就可能让 Managed
  会话在 Legacy 上运行。
- worktree reset 的替代会话在创建时不带 `worktree`，之后才移入 checkout，所以用途
  规则把它当作普通创建。Live 对话在项目中启动的线程是否属于 Live 用途，也还没有定论。

## 范围

范围内：

- 普通宿主 Managed 引擎的定义，以及 B2d 设计留给它的决定：owner 记录与 Managed
  Session header 的关系、只有 Managed 存活时的工作区控制、有界的评估、复核输入和
  用途标记。
- M1 到 M6 的切片计划及各自的验收检查。
- M1 与 M3 的实现。

范围外：默认启用；把 Hosted 会话放到双引擎 Bridge 上；Managed 分支（仍保持拒绝）；
Stage G 接管；Managed 会话上的 Stage H 扩展（MCP、Hooks、后台 Shell、子 agent）；
Java 承载的 Managed WebShell 产品链路；任何 daemon 路由或 REST 形态的变更。

## 设计方案

### 引擎是什么

每个双引擎工作区 runtime 有一个 Managed `ChannelFactory` 和一个兼容评估，通过 B2d
定义的接口注册。

- **按需子进程宿主。** 每个双引擎工作区 runtime 最多按需启动一个 Managed 子进程，
  使用既有 spawn factory 与 ACP transport。该 runtime 的会话复用此子进程中的普通
  `QwenAgent`；模型、权限、取消及其他会话状态仍保持各自作用域。会话保留 Legacy 的
  prompt、审批、压缩、模型切换和模型循环。没有 Managed 工作时，不启动 Managed
  宿主或 worker。
- **工具在 Runtime 中执行。** Managed 宿主只注册由 Runtime 承载的工具。工具调用在
  宿主中准备并做权限检查，然后由 Managed 子进程在第一次工具操作时为该会话启动、
  并绑定到会话目录的独占本地 Runtime worker 执行。宿主自己从不执行工具的副作用。首阶段支持 worker 已有的工具
  集合：Read、Write、Edit 和前台 Shell。其他工具不为 Managed 会话注册；需要这些工具
  的配置评估为 `deferred`。#12831 的 Hosted 工具回合是在 Hosted 循环中以预先批准的
  配置驱动 Java Runtime Broker；与之不同，普通宿主保留 `QwenAgent` 的权限与审批流程，
  也不需要任何 Java 服务。
- **Managed Session log。** Managed 会话以 Managed Session log 的形式记录在会话的
  transcript 文件中，通过 #12693 的 authority 及其本地 JSONL journal 与资源存储写入。
  authority 在第一个事务中先写 `managed` owner 记录，再写 Managed Session header；
  宿主的 recorder 通过 authority 的 record sink 写入。
- **Owner 与回执。** 宿主以 `managed` 遵循 B2a 契约：在任何初始化副作用之前，先创建
  或打开 log（由此持久化或核验 owner），之后才返回
  `_meta['qwen.session.executionEngine'] = 'managed'`。
- **最后才注册。** 只有能在 Runtime 中运行首阶段工具集合时，双引擎 runtime 才注册该
  引擎。在此之前保留 B2d 的占位 factory，没有任何会话会选中 Managed。

### 决定

1. **owner 记录与 Managed Session header。** Managed 会话是 Managed Session log，
   而不是带 `managed` owner 记录的普通 transcript。理由：Legacy 各入口在执行、记录、
   重命名或 fork 时已经会拒绝 header；这种 log 是 Hosted Harness 写入、Stage G 要外置
   的格式；恢复 Runtime 工具工作需要 authority 的 journal 与 checkpoint；双引擎选择器
   也已经能从这种 log 中读取 owner，其记录类型都是已知类型。owner 记录仍是引擎身份，
   header 标识格式。M1 让单独一条 `managed` owner 记录就足以使 Legacy 拒绝，因此拒绝
   不依赖 header 是否存在。
2. **每个工作区 runtime 一个子进程宿主。** 普通 agent 路径会修改 `process.env`，并依赖
   进程级服务。按需 Managed 子进程隔离工作区环境与故障，无需先完成全局状态重构。
   子进程负责正常的 worker 生命周期；daemon 侧清理也必须在子进程崩溃或被强制终止后
   生效，覆盖 worker、独立进程组和 Shell 后代。只有核验物理清理完成后才释放准入与
   ID，持久 owner 始终保留；否则保持引擎隔离，工具结果未知时阻塞，不重放或回退到
   Legacy。Hosted 保留独立 Harness。完整 Hosted 循环复用与 worker 共享另行推进。
3. **只有 Managed 存活时的工作区控制。** 工作区控制保持 Legacy 作用域（#12737 Q4）。
   目前在 Legacy 未存活时，权限规则变更在应用任何内容之前就会失败，因为持久化它的
   正是 Legacy 工作区控制，所以它永远到达不了存活的 Managed 会话；其他影响会话的变更
   能送达 Managed，但会把缺少控制通道报告为失败。当 Legacy 工作区控制通道未存活时，
   引擎为影响会话的变更启动它（部分工作区控制命令已经这样做），先在那里应用变更，
   再通过 B2b 的 `qwen/control/workspace/change` 送达 Managed。变更绝不会仅因 Legacy
   空闲而被拒绝。
4. **有界的评估。** 评估只读取本地文件（各层 settings、`.mcp.json`、扩展目录和 store
   元数据），不访问网络，也不启动进程。它会在 Bridge 的选择预算（initialize 超时，
   默认 10 秒）内远早于期限完成。抛出异常或 reject 的评估视为 `unknown`；引擎只记录
   来源类别和原因，绝不记录配置值或凭据。
5. **复核输入。** 宿主不接收选择器的快照。在 Hooks、MCP、工具或模型启动之前，它从
   实际将要使用的配置重新读取同一份严格快照，并应用同一评估。结果不是 `compatible`
   时，创建或恢复以 `SessionExecutionEngineError` 失败（映射为 409），绝不回退到
   Legacy。通道启动把选择与初始化隔开，其间发生的变化必须导致失败，而不是带着延期
   能力进入 Managed。
6. **用途标记。** worktree reset 的替代会话从 spawn 起就带上 worktree 元数据（M1）。
   Live 对话在项目中启动的线程属于普通创建：Live 任务工具会列出并驱动所有 runtime 中
   的所有线程，不论是谁创建的，所以只标记 Live 创建的线程隔离不了任何东西。Live
   对话本身运行在 Conversations runtime 上，而该 runtime 从不配对。其他内部创建方已经
   标记了各自的会话（见 M1）。
7. **只认明确证据。** Legacy 只在有明确 Managed 证据时拒绝 transcript。owner 读取器
   对含有无法完整解析的行或未知记录类型的 transcript 报告 `unavailable`；若未配对宿主
   依据它做拦截，就会拒绝因崩溃而截断的 Legacy 会话，而这种更严格的恢复是 B2d 只在
   开关之后才接受的。参考实现改为断言已核验的 `legacy` owner；上游移植不这样做。

### 不变量

B2d 的不变量仍然成立。此外：

1. Managed 会话从不在宿主进程中执行工具的副作用。
2. Legacy 入口从不执行、记录或 fork 明确标识为 Managed 的 transcript，无论是否配对。
3. 只有能在 Runtime 中运行首阶段工具集合时，双引擎 runtime 才注册该引擎。

### 切片计划

M1 与 M3 已实现并保留。M2 与 M4–M6 后置，等待状态一节所述的优先级评估；
下方依赖顺序与验收检查不代表已安排实施。参考提交描述原始移植方案；所链接的
宿主决定取代了旧的进程内 M2 方案。

| 切片                                      | 交付内容                                                                                                                                                                                                                                                                                                                                                               | 验收检查                                                                                                                                                                                                                                             | 参考                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — 前置条件**（#12861）               | Legacy 拒绝 `managed` owner 记录；worktree reset 的用途标记；Live 任务的决定；本设计。                                                                                                                                                                                                                                                                                 | 见 M1 的验收标准。                                                                                                                                                                                                                                   | `2f00ac26e3`（拒绝，改为只认明确证据）                                                                                                                                             |
| **M2 — 子进程 ACP 宿主**（后置）          | 每个工作区 runtime 最多按需启动一个 Managed 子进程，使用既有 spawn factory 与 ACP transport，隔离工作区环境并实现完整宿主生命周期；Hosted 保持独立 Harness。                                                                                                                                                                                                           | ACP 测试保持通过；通过子进程创建、prompt、关闭和释放，不泄漏句柄、定时器或 MCP 客户端，也不让环境变量改动影响 daemon 或其他工作区 runtime。子进程故障不影响 daemon、其他工作区与无关 Legacy 会话；在 M6 之前结合 M5 核验 worker 后代清理。           | [宿主建议](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5858038609); [首版 worker 范围](https://github.com/QwenLM/qwen-code/issues/12737#issuecomment-5864516602) |
| **M3 — 严格配置快照**（#12883）           | 按 M3 一节细化后的兼容契约，对其配置输入的只读快照：读取各层 settings 时不做迁移写入、备份或重置（迁移只在内存中进行；缺失、不可读、损坏和版本未知的层彼此区分），带错误的 `.mcp.json`，所有 settings 层的 Hooks，不加锁地证明 extension store 为空，转发的 argv，信任状态与 cwd，以及请求的审批模式；外加返回 `compatible`、`deferred` 或 `unknown`（附原因）的评估。 | 读取不改变任何字节或元数据文件；每个输入来源单独都能使配置成为 `deferred` 或 `unknown`；对空的受信工作区评估为 `compatible`。                                                                                                                        | `a836081466`、`306cf17546`、`d48161bc4a`                                                                                                                                           |
| **M4 — Managed Session log 记录**（后置） | 宿主的 recorder 在 certified writer lease 下通过 authority 的 record sink 写入；恢复读取 log 的 projection；关闭时封存 log。                                                                                                                                                                                                                                           | 以这种方式记录的会话恢复后历史相同；Legacy 入口凭 header 拒绝它；在第一次提交之前崩溃，不会留下 Legacy 能运行的 Managed 会话。                                                                                                                       | `e98cda5c95`、`1ed806ca85`、`f501d9694d`                                                                                                                                           |
| **M5 — Runtime 承载的工具**（后置）       | 会话独占的本地 Runtime worker，由 Managed 子进程在第一次工具调用时惰性启动并绑定到会话目录；Read、Write、Edit 和前台 Shell 无需等待 worker 即可声明，在宿主中准备并做权限检查，在 worker 中执行；取消能到达 worker 的进程；模型继续之前结果已持久写入 log；结果未知时阻塞而不是重放。                                                                                  | 工具文件写入与 Shell 进程只在 worker 中执行；宿主仍可启动 worker 和记录会话。取消有物理停止证据；结果丢失时会话被阻塞。                                                                                                                              | `7786edd123`、`5dde5c8dd7`、`174e072ac4`                                                                                                                                           |
| **M6 — 引擎**（后置）                     | Managed 通道 factory（M2 宿主、M4 记录、M5 工具、M3 复核、owner 与回执），Bridge 在 Managed 通道上调用的扩展方法（会话关闭、工作区变更确认、用户语言、资源快照），工作区控制的决定，在 `--experimental-paired-engines` 之后注册到三个 daemon 构造点和嵌入式默认 Bridge，以及生命周期（关闭、排空、撤销、代际与环境重载）。                                             | 在双引擎 daemon 上，受信工作区中配置为空的普通新会话经真实路由在 Managed 上运行：创建、prompt、工具调用、取消、关闭，以及 daemon 重启后的冷恢复。延期配置留在 Legacy，新的 deny 规则送达存活的 Managed 会话，关闭开关后 Legacy 拒绝该 Managed 会话。 | `824e92d84f`、`306cf17546`                                                                                                                                                         |

M2 与 M3 互不依赖。M4 和 M5 依赖 M2。M6 依赖以上全部，也是唯一能让会话选中
Managed 的切片。

### M1：前置条件

#### Legacy 拒绝

明确的 Managed 证据包括原有的 Managed Session header，以及 owner 读取器的行解析器能从
头部某一行中恢复出的一条记录，其 `type: "system"`、
`subtype: "session_execution_engine"` 且 `systemPayload.engine: "managed"`。某一行
无法整体解析时，该解析器仍会恢复它能界定出的完整记录，因此这样的记录即使与另一条记录
同处一行也算数；在该记录内部被截断的行则恢复不出记录。消息中的文本不算。Managed owner 总是先于其他内容写入，因此该检查读取与 header
检查相同的 64 KiB 头部窗口。与 header 检查一样，读取出错时它放行；下文的风险记录了这会
在哪些情况下放过 Managed transcript。owner 证据
只由一个谓词 `isManagedOwnerRecord` 定义，该检查与会话列表的 Managed 识别都使用它。
owner 读取器对 owner 记录的校验更严格（例如要求 `version: 1`），它拒绝的记录会被报告
为 unavailable，而不会被当作 Legacy。

三个现有的拒绝点以及没有存活 recorder 时的重命名改用新的检查。每个执行、记录、重命名
或 fork transcript 的 Legacy 入口都会经过其中之一：

| 入口                                                                                                          | 拒绝点                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| CLI `--resume` 与 `--continue`                                                                                | `loadCliConfig` → `SessionService.assertLegacySessionExecution`                                               |
| CLI `--fork-session`                                                                                          | 同上，之后 `SessionService.forkSession`                                                                       |
| 未配对宿主上的 ACP 冷 `session/load` 与 `session/resume`，包括 IDE 客户端、channels 和未配对的 daemon runtime | `loadCliConfig` → `assertLegacySessionExecution`，映射为 -32024 和 409 `session_execution_engine_unavailable` |
| ACP 会话 source 复制                                                                                          | 其临时恢复 Config 经过 `loadCliConfig`                                                                        |
| TUI `/resume`（Ink 与 OpenTUI）                                                                               | `assertLegacySessionExecution`                                                                                |
| TUI `/branch`、ACP 分支与 side task                                                                           | `SessionService.forkSession`                                                                                  |
| 不持 writer lease 写入的 recorder                                                                             | `ChatRecordingService` 中的会话文件检查                                                                       |
| 没有存活 recorder 时的重命名：daemon 元数据路由（含 standalone）、ACP、TUI `/rename`、分支、取消归档          | `SessionService.renameSession` 或 `renameSessionForLifecycle`                                                 |

热 attach 或 live load 复用存活会话，而 Legacy 子进程只会持有 Legacy 会话。只读的
transcript 读取、重放和列表仍然可用。封存维护 lease 仍只检查 header，读取器选择
Managed projection 时也一样：它们依赖 Managed Session log 格式，而单独一条 owner 记录
并不具备这种格式。把关执行、记录与 fork 的拒绝不改变双引擎宿主的行为：其选择器已经会
拒绝没有引擎能运行的 Managed owner。

重命名在所有宿主上（无论是否双引擎）遇到任一种证据都会拒绝，因为没有存活 recorder 时的
重命名会直接追加写入 transcript。Managed 创建若在 owner 记录与 header 之间中断，只会
留下 owner 记录；下一次 Managed 打开只有在 transcript 中除 owner 记录外没有别的记录时
才会补完这次创建。在这次后续修改之前，Legacy 重命名会在这里追加标题，使 transcript
变得两个引擎都打不开。

#### 用途标记

worktree reset 的替代会话现在在 spawn 时就带上它之后才会得到的 worktree 元数据
（slug、checkout 路径和分支），与新建 worktree 会话相同。选择器因此把它留在 Legacy。
子进程也会推迟 MCP 发现，直到会话移入 checkout，届时由重定位刷新 MCP，与新建的
worktree 会话一致；此前，替代会话会先在工作区根目录发现 MCP 服务器。

其他内部创建方已经标记了各自的会话：

| 创建方                         | 标记方式                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| Conversations standalone 服务  | `daemonOwnedStandalone`                                           |
| 子会话（`create_sub_session`） | `parentSessionId`                                                 |
| 定时任务控制器                 | `sourceType: "scheduled_task"`                                    |
| 定时任务运行                   | `default` 来源加 `scheduled_task_run:` id，并带父会话             |
| Live 对话                      | `default` 来源加 `realtime_voice:` id，位于 Conversations runtime |
| Channel worker                 | `sourceType: "channel"`                                           |
| Managed Runtime provider       | `sourceType: "managed-gateway"`                                   |
| 新建的 worktree 或分支会话     | `worktree`、`branch`                                              |
| 分支与 side task               | 恢复已核验的 Legacy 来源；Managed 来源被拒绝                      |
| 项目中的 Live 任务线程         | 普通创建（决定 6）                                                |

### M3：配置快照与兼容评估

M3 把 B2d 设计中的配置兼容契约实现为 CLI 配置层中的一个函数
`evaluateManagedCompatibility`。在 M6 中，daemon 的选择器与 Managed 宿主的复核都用
各自的输入调用同一个函数，所以它放在两者都能引用的位置。在此之前，生产代码中没有任何
调用方。

#### 输入

请求提供会话的工作区目录和它要求的审批模式。runtime 提供：

- 规范化的工作区目录和信任状态；
- 它交给各会话宿主的有效环境；
- daemon 转发给每个会话宿主的参数；
- 运行中的工作区是否持有配置文件之外的 MCP 服务器（运行时添加或由客户端注册）。只有
  daemon 知道这一点，由 M6 提供。

#### 无副作用的读取

- **settings。** `readSettingsSnapshot` 对每一层应用 `loadSettings` 的合并、迁移、
  信任与 `${VAR}` 规则，但跳过 `loadSettings` 中所有会写入的步骤：
  - 把 home `.env` 的值预先写入 `process.env`；
  - 运营方沙箱的预读（它会把损坏的用户文件复制为 `.corrupted`）；
  - 重定向告警对 `QWEN_HOME` 的临时替换；
  - 损坏恢复，以及消费重新启动时留在 `process.env` 中的损坏标记；
  - 持久化迁移结果与版本规范化；
  - 加载环境变量。

  严格读取器区分文件真正不存在与悬空链接、非普通文件、读取失败、读取期间发生变化这
  几种情况。后几种都会抛错；无效 JSON、不是对象的值，以及不是从 1 开始的整数、或迁移
  后仍高于当前版本的版本号，也都会抛错。

- **环境。** 传入的环境就是该 runtime 的会话宿主所用的环境。其中的 `QWEN_HOME` 与
  两个系统 settings 路径用来定位用户与系统 settings 文件和 extension store；没有
  `QWEN_HOME` 时，用户目录位于进程的 home 目录下。它也是占位符的唯一来源，并且已经
  包含 runtime 应用的用户级 `.env` 值。评估只读取它一次，M6 必须用同样的变量 spawn
  宿主。定位变量和占位符按被 spawn 的会话宿主收到的方式读取：取字符串形式；在
  Windows 上不区分大小写，多种拼写并存时取排序最前的一种。名字像数组下标的变量（例如
  `0`）不计入，因为 Node 进程从 `process.env` 取不到这类名字的值。会话宿主无法原样
  收到的环境判为无法读取：缺失的环境，spawn 会改为传递它自己的环境；无法读取的变量、
  Symbol 值或 NUL 字节，spawn 会拒绝，或者值会在该处被截断；以及因为含有 `=` 而让
  宿主收到另一个名字的变量名。依赖工作目录的位置判为 `unknown`，因为会话宿主会按
  它自己的工作目录解析：相对路径，以及 Windows 上既没有盘符根、也没有 UNC 服务器与
  共享名的路径。为空或为相对路径的 home 目录同样如此，settings 加载既用它确定用户
  目录，也用它判断工作区是否就是 home 目录。无法查到的 home 目录判为无法读取，其他
  无法解析的 home 目录（例如不存在）同样如此。`QWEN_HOME` 可以是 `~`，或以 `~/`、
  `~\` 开头，它按 home 目录展开。在 daemon 中，这些定位变量和 `HOME` 不允许被工作区
  覆盖，Windows 上给出 home 目录的 `USERPROFILE` 一旦设置也不会被覆盖所替换，所以
  它们与 daemon 自己的值相同；在会话宿主中，它们就是宿主自己的环境。
- **项目 MCP 文件。** 严格模式下，`.mcp.json` 的读取失败会作为错误保留，而不是当作
  文件不存在。两种模式下，无法解析、没有 `mcpServers` 对象，或含有不是对象的条目的
  文件都算错误。
- **扩展。** `ExtensionStore.inspectEmptiness` 在不使用 store 的锁、恢复和初始化的
  前提下证明已安装集合为空。
  - 扩展目录或指向目录的链接判为 `installed`。store 中记录了扩展同样判为
    `installed`，但 store 的条目会在读取其状态之前检查：存疑的 store 无论状态记录了
    什么都判为 `unknown`。
  - 以下情况判为 `unknown`：锁被持有、`transactions` 目录中有日志、`staging` 或
    `rollback` 目录中有内容、store 中有意外条目、只有上一版状态而没有当前状态、状态
    损坏、enablement 文件损坏或不是普通文件、projection 与状态不一致、没有状态却有启用
    记录、读取失败，以及读取期间 store 的目录列表或状态文件发生变化。
  - 扩展目录中的文件都是控制文件，从不计入。空闲 daemon 或已初始化的空 store 留下的
    内容也都可以接受：`lock` 文件，没有记录任何扩展的状态及其上一版副本，空的
    `staging` 和 `rollback` 目录，没有日志的 `transactions` 目录，`plugin-data`，以及
    状态为尚未安装的扩展保留的旧版启用规则。store 永久留下且不再读取的文件同样可以
    接受：恢复时隔离的日志，以及状态和日志写入中断后留下的临时文件。store 从不创建
    以点开头的条目（例如 `.DS_Store`），在 store 及其 `staging` 和 `rollback` 目录中
    忽略这类条目。

#### 规则

按顺序匹配，第一个成立的条件决定结果：

| 条件                                                            | 结果       |
| --------------------------------------------------------------- | ---------- |
| 工作区不受信                                                    | deferred   |
| 无法解析会话目录或工作区目录                                    | unknown    |
| 会话目录不是 runtime 的工作区                                   | deferred   |
| 转发了 `--experimental-lsp`                                     | deferred   |
| 转发了 `--restore-ask-user-question`                            | deferred   |
| 转发了其他参数                                                  | unknown    |
| 运行中的工作区持有配置文件之外的 MCP 服务器                     | deferred   |
| 无法读取 home 目录或环境                                        | unknown    |
| 环境中的某个 settings 位置依赖工作目录                          | unknown    |
| 某一层 settings 无法读取                                        | unknown    |
| 任何一层 settings 中有 MCP 服务器，或配置了 `mcp.serverCommand` | deferred   |
| 配置了 `tools.discoveryCommand` 或 `tools.callCommand`          | deferred   |
| system、user 或受信 project 层中配置了 hooks                    | deferred   |
| settings 中的审批模式无效                                       | unknown    |
| 审批模式为 `plan`（请求指定或来自 settings）                    | deferred   |
| `.mcp.json` 无法读取或格式不正确                                | unknown    |
| `.mcp.json` 中有服务器                                          | deferred   |
| 已安装扩展                                                      | deferred   |
| 无法证明 extension store 为空                                   | unknown    |
| 其他情况                                                        | compatible |

hooks 条目只要不是空列表，也不是 hook 注册表会跳过的配置字段 `enabled`、`disabled`
和 `notifications`，就算已配置。settings 中的审批模式按会话创建时的方式规范化，请求
指定的模式会替换它；但会话创建时仍会先解析 settings 中的值，所以它拒绝的值无论如何都
判为 `unknown`。原因只说明来源，从不包含配置值。

#### 对契约的细化

M3 确定了契约中的以下细节：

- **不读取 skill 与 agent 定义。** 它们的 hooks 和 MCP 服务器只能通过 Skill 与
  Agent 工具、skill 命令和 agent 编排注册。首阶段引擎不提供其中任何一项，M6 也不会为
  Managed 会话注册它们。后续阶段加入这些能力时，再扩展本评估。
- **请求选项中只评估审批模式。** Managed 宿主就是同一个 `QwenAgent`，因此它绑定请求
  的模型服务和启动配置的方式与 Legacy 宿主完全相同。`plan` 审批模式需要引擎不提供的
  计划模式工具。
- **工具发现与调用命令与 MCP 同等对待。** 它们会增加在宿主中执行命令的工具。
- **注入会话的 MCP 服务器不是输入。** Bridge 创建和恢复每个会话时都传入空的
  `mcpServers` 列表，所以没有会话在启动时带有注入的服务器。运行中的工作区新增的服务器
  属于上面的 runtime 输入。
- **评估不认识的参数判为 `unknown`。** daemon 目前转发的每个参数都会启用一项被推迟的
  能力。新增的转发参数会让会话留在 Legacy，直到评估了解它启用了什么。

只启用更多内置工具或后台功能的 settings（例如 cron、artifact 或自动记忆）不是输入。
首阶段引擎不注册也不运行它们，这由 M5 和 M6 保证。

### M4：Managed Session log 记录

M4 通过 #12693 的 authority，使用其本地 JSONL 日志与资源存储，把 Managed 会话记录为
Managed Session log。它改动 core 的 `Config`、`ChatRecordingService`、record sink 与读取器的
Managed 恢复投影，不增加生产调用方：Managed 宿主在 M6 才开始使用它。它不需要 M2 宿主：宿主选定的
引擎本来就以 `sessionExecutionEngine` 传到 `Config`，测试也像宿主那样直接驱动
`Config`。

#### 触发条件

`sessionExecutionEngine` 为 `managed` 的 `Config` 会把会话记录为 Managed Session log。
只有运行 Managed 会话的宿主才会设置这个值；普通 ACP 宿主在 `Config` 创建之前就会拒绝
`managed` 请求。这样的 `Config` 需要 chat recording 与会话 writer lease，缺少它们时
初始化以 `SessionExecutionEngineError` 失败。在 M4 之前，`managed` 引擎只会在普通
transcript 中写入一条 `managed` owner 记录，而决定 1 排除了这种形态。

#### 写者与打开

- 含有记录、但头部没有 Managed 证据的 transcript 属于 Legacy 会话，Managed 激活会在
  获取 lease 之前拒绝它：certified 接管会先让 Legacy 会话的 handoff 封存失效，之后的
  任何检查都来不及拒绝这次恢复。
- recorder 的 writer lease 以 Managed 写者身份获取：锁 schema 3 并带 Managed 格式版本，
  且使用 certified 接管。不认识 schema 3、且会获取 writer lease 的程序会拒绝这把锁，
  而不会写入日志；封存的 Managed 锁只有在日志仍与封存中的提交证明一致时才能重新打开。
  TUI、无头 CLI 以及未开启 `experimental.sessionWriterLease` 的 daemon 不获取 lease：
  当前版本凭 header 拒绝 Managed 日志，0.24.6 之前的版本则会向它追加记录，此后该日志
  在下一次打开时会以失败告终。
- 持有 lease 之后、recorder 接收任何记录之前，`Config` 用 `openManagedSession` 在这个
  lease 上打开日志。authority 接管这个 lease，因此会话始终只有一个写者。
- transcript 没有 header 时，`Config` 发布定义（引擎、模型与审批模式，不含任何凭据）
  与根快照，authority 先写 owner 记录，再写 header。这同时覆盖新会话，以及在 owner
  记录之后中断的创建。header 之前如有其他任何记录，打开就会失败。
- 恢复经由读取器的恢复投影进行，并且在打开日志之前必须确认投影中的 owner 为
  `managed`。Managed 日志从不使用 Legacy 加载器，没有投影的 Managed 恢复会失败。
- 如果崩溃中断了写入，使日志的最后一个事务没有提交标记，日志会在打开时被修复：写者持有
  lease，因此会把最后一个提交标记之后的记录移到 transcript 旁的诊断文件，并在该提交处
  打开日志。这些记录从未提交过。
- authority 无法打开的日志，例如已与其封存不再一致的日志，会让激活以 authority 自身的
  错误失败，而不会被报告为写者不可用。
- activation 以会话作为其 worker，记录五分钟的期限，并在会话打开期间每过期限的三分之一
  续期一次。

#### 记录

- recorder 在激活之前绑定 authority 的 record sink。它接收的每条记录都经由 sink 作为
  Managed 事务提交；不会直接追加原始记录，recorder 也不会再写第二条 owner 记录。
- sink 能承载的记录包括：消息与工具结果、标题、压缩、goal 状态、文件历史、回合结果、
  分支检查点、会话来源、斜杠与 `@` 命令、UI 遥测以及归因快照，且每种记录都须符合其映射
  所需的形态：标题不能为空，回合结果须带 prompt id 与状态，压缩须带历史。
- 其他任何记录，或形态不符的可承载记录，都会在进入队列之前被 recorder 拒绝，会话继续
  记录。现在任何一次写入失败都会让 recorder 在会话剩余时间内停止工作，所以拒绝绝不能
  进入队列。被等待、且不返回值的记录方法会以 `ManagedSessionRecordRefusedError` 拒绝；
  约定返回布尔值的方法（例如 `recordCustomTitle` 与 `recordParentSession`）会返回
  `false` 并记录日志，与其他写入失败时相同；不等待结果写入的记录会被丢弃，并记录一条
  调试日志。在队列中仍然失败的写入，例如 authority 中的冲突或追加失败，照旧会让
  recorder 停止。
- sink 在发布摘要之前读取压缩所替换的范围，因为那正是摘要所覆盖的历史；压缩事件则在
  提交时编号。发布摘要期间可能有续期提交，在此之前编好号的事件会发生冲突，从而让
  recorder 停止。
- Managed 标题是日志保存在读取器回放的记录之外的元数据，因此它不会成为下一条记录的父
  记录。
- 会话列表在日志两端各 64 KiB 的窗口中查找标题与来源，与 Legacy transcript 相同，
  因此 recorder 会重新锚定两者。它测量日志增长了多少，因为记录自身的大小无法说明这一点：
  每条记录都包在事务记录中提交，其内容存入资源，续期也会在记录之间追加。到期的锚点紧跟在
  使其到期的那条记录之后写入；关闭时会写入已到期的锚点，`finalize()` 会写入已到期的标题，
  即使只是续期让日志增长也是如此。恢复后的会话把两者都视为已到期，因为它无法知道它们
  离日志末尾有多远。
- 恢复从整个日志读取标题，从读取器回放的记录读取来源，因此标题已移出窗口的日志（例如
  崩溃之后）不会恢复出较早的标题。内容无法读取的标题恢复为没有标题，与会话列表的显示
  一致。
- goal 证据从读取器回放的记录中读取活动链。这条链与 Legacy 的相同，只是不含 owner
  记录与标题。

首期中，以下记录没有映射，或者其形态格式无法承载：

- 模型切换不会被持久化：daemon 会忽略被拒绝的写入，rewind 也会丢弃它本要重新追加的
  模型记录。恢复后的会话使用其配置所选的模型。
- Web Shell 文本元素、会话 artifact、来源快照、goal 运行时的回合结束记录，以及 daemon
  投递的通知，写入时都会失败。清空标题同样会失败。
- rewind 记录会被丢弃。实时会话及其活动链是正确的，因为后续记录会跳过被移除的回合
  链接上去；但 Managed 恢复投影把日志当作线性历史读取。记录 A 和 B、rewind 回到 A、
  再记录 C：恢复后的 Managed 会话给模型的是 A、B 和 C，而 Legacy 给的是 A 和 C。
- 后台任务、cron 与 omni recall 的记录会被丢弃。首期的 Managed 会话没有这些功能。
- 子会话的父会话记录与 Live 对话的记录会被拒绝。这两种用途都留在 Legacy。

M6 逐项决定：Managed 会话拒绝该功能，还是为其记录增加映射；后者会改变 Managed Session
格式，需要格式所有者同意。在投影能够沿记录链读取之前，Managed 会话必须拒绝 rewind；
`Session.rewindToTurn` 本来就会在做任何改动之前校验请求。

#### 关闭

- recorder 先 flush 并写入已到期的锚点，authority 记录 activation 已停止推进，然后
  recorder 用 authority 的提交证明封存 lease，而不是释放它。handoff 也以同样方式关闭，
  尽管它不运行 `finalize()`。
- 写入失败不会改变这一点：到期的锚点仍会尝试写入，提交证明只覆盖已提交的事务，下一次
  打开会修复尾部。
- 激活期间的关闭不会像对 Legacy 写者那样提前释放 Managed 写者：由激活在失败时结束它。
  - 已经打开的日志按 authority 的提交证明封存。
  - 接管了已封存锁的 lease 会把那份封存原样恢复。打开会在写入任何内容之前按封存校验
    日志，而按从日志读出的位置封存，会让一个在封存之后被改动的日志被接受。
  - 不存在、为空或头部不含 Managed 证据的 transcript 会释放其锁：它没有需要守护的内容。
  - 其他日志按从中读出的已提交位置封存。头部或日志无法读取的，会一直持有锁直到进程
    退出，因为无从知道它包含什么、该在哪个位置封存。这个 lease 可能回收的是某个崩溃的
    Managed 写者的锁，释放它会让那把锁消失。
- 没有任何内容就被关闭的 Managed 会话会保留其封存的日志。是否丢弃它由 M6 决定。

#### 留给后续切片的风险

- 每次续期都会提交一条 activation 事件，因此打开的会话无论是否空闲，其日志每 100 秒
  都会增长一个约 2 KB 的事务。会话空闲 25 到 50 分钟后，仅续期就会把标题移出尾部窗口，
  此后会话列表显示较早的标题或不显示标题，直到下一条记录或关闭将其重新锚定；恢复则读取整个日志。M6 可以为
  本地会话延长期限；本地会话的存活由其 writer 锁判断。
- 续期经由 lease 追加写入，不经过 recorder 的写屏障。在该屏障下读取日志、随后检查其
  大小的实时恢复可能会看到日志变化。M6 在实时恢复 Managed 会话之前必须处理这一点。
- 修复会丢弃从未提交的记录。M5 必须让 Runtime 工具的结果自身保持持久，这样被丢弃的
  尾部就不会掩盖已经发生的副作用。
- `loadCliConfig` 会拒绝 owner 为 `managed` 的恢复。M6 宿主恢复 Managed 会话时必须绕过
  这项 Legacy 检查，并且必须提供恢复投影。
- 记录 Managed 会话的开销高于 Legacy transcript。在同一台机器上测 300 个回合：写一个
  回合的耗时约为 3.4 倍，日志约大 2.8 倍，磁盘占用约为 9 倍；goal 校验每次都要读取的
  活动链，读取耗时为 30 到 80 倍，并随日志增长。M6 在 Managed 会话上运行 goal 之前必须
  限制或缓存这次读取。
- 含有 Managed 证据但无法读取的日志，其锁会由打开失败的那个进程一直持有，因此同一
  进程内的重试会遇到写者冲突，直到该进程退出。长期运行的 M6 宿主必须能回收这样的锁，
  例如回收进程内没有任何存活 lease 持有的锁。
- 0.24.6 之前的版本在 TUI 或无头模式下不获取 writer lease，会向 Managed 日志追加
  记录，此后该日志会以失败告终。M6 可以为混用多个版本的安装规定最低版本。

## 文件与消费者

| 切片 | 文件                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1   | core `utils/sessionStorageUtils.ts`、`services/sessionService.ts`、`services/chatRecordingService.ts`；CLI `serve/routes/session.ts`                                                                                                                                               |
| M2   | CLI `acp-integration/acpAgent.ts`；既有 daemon ACP spawn factory 与 transport（重新排期时确定最终文件范围）                                                                                                                                                                        |
| M3   | CLI `config/settings.ts`、`config/mcpJson.ts`、`config/storage-paths-lite.ts`、`config/config.ts`，以及新增的 `config/read-config-file.ts`、`config/approval-mode-value.ts` 与 `config/managed-compatibility.ts`；core `extension/extension-store.ts` 与 `utils/envVarResolver.ts` |
| M4   | core `config/config.ts`、`services/chatRecordingService.ts`、`services/session-transcript-reader.ts` 与 `utils/sessionStorageUtils.ts`；`managed-runtime/managed-session-record-sink.ts`、`managed-session-message-projection.ts` 与 `managed-session-authority.ts`（一处导出）    |
| M5   | core 工具与调度器；CLI `serve/managed-runtime-*`                                                                                                                                                                                                                                   |
| M6   | CLI `serve/session-execution-engine-selector.ts`、`serve/run-qwen-serve.ts`、`serve/server.ts`；一个新的 Managed 通道模块                                                                                                                                                          |

任何切片都不改动 daemon 路由或 REST 形态。M1 不改变任何公开分类：它的拒绝使用
已有的 `session_execution_engine_unavailable`。M3 没有生产调用方：选择器与 Managed
宿主从 M6 起才调用该评估。M4 同样没有：Managed 宿主从 M6 起才创建 `managed` 会话。

## 验证与验收标准

M1：

1. 未配对的 Legacy 宿主拒绝执行、fork、记录或重命名唯一 Managed 证据是 `managed`
   owner 记录的 transcript，并使用已有的分类；transcript 字节不变，也不会创建 fork
   目标。在 header 之前中断的 Managed 创建仍能由下一次 Managed 打开补完。
2. 只有 header，或 owner 读取器的行解析器能从头部某一行恢复出的 Managed owner 记录，
   才会让 transcript 成为 Managed。Legacy owner、没有 owner 记录、在 owner 记录内部被
   截断的行，或在能完整解析的行中位于消息文本或其他记录内部的 owner 记录内容，都不会：
   未配对的 Legacy 宿主仍能执行和重命名这样的 transcript，带 Legacy owner 的 transcript
   仍能 fork。在头部窗口内，owner 读取器确认为 Managed 的记录都是 owner 证据；读取器
   拒绝的 owner 证据会让 owner 成为 unavailable。
3. 带 Managed Session header 的 transcript 行为不变，包括拒绝重命名。
4. worktree reset 在 spawn 替代会话时带上 worktree 元数据，双引擎选择器把它视为延期
   用途。
5. build、typecheck 和定向测试通过；对每个拒绝点或 reset 元数据做变异，都会使某个
   测试失败。

M3：

1. 空的受信工作区判为 `compatible`。普通配置同样如此，包括需要迁移的文件，以及空闲
   daemon 或已初始化的空 store 留下的文件。评估之后，每个文件的字节、inode、修改时间
   与状态变更时间，以及进程环境都不变。
2. 单独布置规则中的每个条件，都得到对应的结果与原因。
3. 严格的 settings 读取、严格的 `.mcp.json` 读取和 extension store 检查，在其报告的
   每种失败下都不改动文件树。
4. build、typecheck 和定向测试通过；对每条规则或严格读取的每种拒绝做变异，都会使某个
   测试失败。

M4：

1. 新的 Managed 会话先写 owner 记录，再写 header，之后只写已提交的 Managed 事务：没有
   原始记录，也没有第二条 owner 记录。Legacy 入口拒绝它，它的锁使用 Managed schema。
2. 关闭时记录 activation 已停止，并用提交证明封存锁。经由投影恢复得到相同的活动链并能
   继续记录，每次关闭后再恢复都是如此。活动链会经过回合结果与会话来源，并与 Legacy 的
   活动链相同，只是不含 owner 记录与标题。
3. 在 owner 记录之后中断的创建会被 Legacy 拒绝，并由下一次 Managed 恢复补完。
4. 崩溃留下的、缺少提交标记的事务，会在下次打开日志时被移到诊断文件；已提交的前缀
   保持不变。
5. 日志无法承载的记录，或形态不符的可承载记录，会在进入队列之前被拒绝，会话继续记录：
   被等待、且不返回值的方法以带类型的错误拒绝，返回布尔值的方法返回 `false`，不等待
   结果写入的记录会被丢弃。发布摘要期间有续期提交时，压缩仍能提交，并且只覆盖摘要之前
   的历史。
6. 在仅由续期推动日志增长的长会话中，关闭、handoff 或写入失败后的关闭之后，会话列表都能
   读到最新的标题，崩溃之后恢复也能读到它。到期的锚点紧跟在使其到期的那条记录之后，
   紧跟锚点的 `finalize()` 不会再追加标题，恢复后的改名只提交一条标题记录。恢复会带回
   会话来源，恢复后的会话会拒绝另一个来源，内容丢失的标题恢复为没有标题。
7. 没有 chat recording 或 writer lease 的 `managed` 会话会在写入任何内容之前失败，在写入
   任何内容之前就失败的会话会释放其锁。没有投影的 Managed 恢复会失败并保持锁为封存状态。
   Legacy 拥有的 transcript 在获取 lease 之前就被拒绝，因此 Legacy 的 handoff 封存保持
   不变。接管了与日志不一致的封存的恢复会以 authority 的错误失败，并保留那份封存。恢复或
   创建期间的关闭会让日志保持封存，最后一次 flush 失败的 handoff 关闭也是如此。含有
   Managed 证据但无法读取的日志会一直持有锁，回收来的锁在日志头部无法读取时也是如此。
8. build、typecheck 和定向测试通过；对以上每种行为做变异，都会使某个测试失败。

整个引擎由 M6 的验收检查判定，并同时满足 B2d 中在注册引擎后适用的标准：即使评估
返回 `compatible`，延期用途仍留在 Legacy；`deferred`、`unknown` 和失败的评估使新会话
选择 Legacy，并使 Managed 恢复准确失败；之后改变评估结果，既不改变已 attach 的会话，
也不改变已持久化 owner 的会话。

## 风险与待解问题

- owner 检查读取头部窗口。写在前 64 KiB 之后的 owner 记录看不到；Managed owner 总是
  最先写入，而且双引擎选择器无论如何都会读取整个 transcript。
- 当最近的会话属于 Managed 时，`qwen --continue` 现在会失败，而不是在 Legacy 上恢复它。
  这是预期的拒绝，但用户能看到。
- Managed 子进程隔离了 daemon，但会增加进程开销，崩溃后也可能遗留后代。M6 之前
  必须验证 daemon 侧物理清理、无关 Legacy 会话与工作区的隔离，以及整个进程树的
  冷启动成本与资源使用，且不得超出现有 daemon 预算。关闭开关时，Legacy 不得有明显
  回退；开启开关但没有 Managed 工作时，不得启动 Managed 宿主或 worker。
- M4 的记录路径和 M5 的 Runtime 工具是最大的两块移植；各自可能需要在其设计更新中
  进一步切分。
- Managed 通道是否应响应预热和保活，暂时沿用 B2c 的规则：两者仍只用于 Legacy。
- 决定 2 遵循 #12737 的子进程宿主决定。M3 不依赖这一宿主形态：选择器和宿主在哪里
  运行，评估就在哪里运行。worker 共享与默认启用需要依据实测结果另行决定，均不属于
  本次后置的首版实现。
- 每个新会话都会读取 settings 各层、`.mcp.json` 和 extension store。其中 settings
  与 `.mcp.json` 的读取是同步的，读取期间会阻塞 daemon 的事件循环。这些读取都在本地
  且数据量小，但慢速文件系统会拖慢会话创建，超出 Bridge 选择预算的选择会使创建失败。
  M6 在会话创建时调用该评估之前，必须把这些读取移出事件循环，或者限制它们的耗时。
- 安装在提交之前中断时留下的 staging 目录，以及日志被恢复隔离的事务在 `staging` 或
  `rollback` 中留下的内容，store 从不清理；其余残留会在下一次 store 操作时由恢复清理。
  在 `qwen extensions install` 期间按一次 Ctrl-C 就足以留下这类残留。这类残留会让会话
  一直留在 Legacy，直到它被删除。M6 在依赖该评估之前，必须在能够确认这类 staging
  目录已被遗弃之后再清理它，或者告诉用户会话为何留在 Legacy。仅凭 store 锁无法确认：
  安装在取锁之前就会创建并填充它的 staging 目录，所以在锁下清理可能删掉仍在进行的
  安装的 staging 目录。
- 另一个 qwen 进程或 daemon 自身同时打开 extension store 时，单次评估可能判为
  `unknown`。M6 必须重试，而不是让 Managed 恢复因此失败。
- 基于文件的自定义命令可以注入 shell 输出（`!{…}`），用户调用命令时会在宿主中运行
  进程。它们不是契约的输入；由 M5 或 M6 决定 Managed 会话拒绝它们，还是由评估将其判为
  deferred。
- Managed 会话的标题与某个活动会话的标题冲突时，取消归档会失败：冲突时的改名是一次
  Legacy 重命名，而它会拒绝 Managed transcript。本地 Managed 日志从 M4 起才会出现，
  因此 M4 或 M6 必须通过会话 authority 改名，或者跳过这次改名。
- owner 检查与 header 检查背后的头部读取以不跟随链接的方式打开 transcript。Windows
  没有这种打开方式，于是它改为证明文件身份，并拒绝没有 inode 编号的卷（FAT、exFAT、
  部分 SMB 共享）上的所有文件。此时检查找不到证据并放行操作，而离线重命名会跟随链接并
  追加写入。因此，经由链接的 Managed transcript，以及 Windows 上位于这类卷上的任何
  Managed transcript，都会绕过 Legacy 拒绝。header 检查在 M1 之前就有同样的缺口。后续
  修改应让证据读取与被守护的操作以相同方式打开文件。
