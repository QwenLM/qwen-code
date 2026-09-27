# 普通宿主的 Managed 引擎

[English](./2026-09-27-ordinary-host-managed-engine.md) | [简体中文](./2026-09-27-ordinary-host-managed-engine.zh-CN.md)

## 状态

普通 `qwen serve` 宿主的 Managed 执行引擎设计，对应 #12737 中
[双引擎宿主接线](./2026-09-26-paired-engine-host-wiring.zh-CN.md)（B2d，#12828）
留在范围之外的部分，服务于 #12380。基于上游 `302e7d88ef`。本文实现 B2d 设计中的
“Managed 引擎接口”与“配置兼容契约”，并把工作拆成 M1 到 M6 六个切片。M1 是 B2d
设计要求在任何 Managed 会话出现之前完成的前置条件（Legacy 拒绝与用途标记），随本文
一同实现。M2 到 M6 仍是提议，各自落地时更新设计。

参考实现为分支 `doudouOUC/qwen-code:feature/managed-agents-p0-p8` 的
`032392a673`。本文记录哪些内容移植到上游、按什么顺序移植，以及上游移植在哪些地方
有意与参考实现不同。

## 问题与现状

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
- M1 的实现。

范围外：默认启用；把 Hosted 会话放到双引擎 Bridge 上；Managed 分支（仍保持拒绝）；
Stage G 接管；Managed 会话上的 Stage H 扩展（MCP、Hooks、后台 Shell、子 agent）；
Java 承载的 Managed WebShell 产品链路；任何 daemon 路由或 REST 形态的变更。

## 设计方案

### 引擎是什么

每个双引擎工作区 runtime 有一个 Managed `ChannelFactory` 和一个兼容评估，通过 B2d
定义的接口注册。

- **进程内宿主。** 一个通道是一对内存 ACP 流，其 agent 一侧是普通的 `QwenAgent`，
  承载在 daemon 进程中，而不是子进程里。会话保持 Legacy 的会话行为：prompt、权限、
  审批、压缩、模型切换和模型循环。
- **工具在 Runtime 中执行。** Managed 宿主只注册由 Runtime 承载的工具。工具调用在
  宿主中准备并做权限检查，然后由 daemon 为该会话启动、并绑定到其工作目录的本地
  Runtime worker 执行。宿主自己从不执行工具的副作用。首阶段支持 worker 已有的工具
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
2. **进程内宿主。** 工具副作用归 Runtime 而不是宿主所有，所以宿主进程只运行模型循环；
   #12380 把这个循环放在 `qwen serve` 内，并允许多个会话共享它。Bridge 的通道契约已经
   允许进程内通道：`killSync` 在进程内拆除它，`exited` 可以不带退出码地 resolve。因此
   宿主必须把进程全局的影响（stdin 与 stdout、删除环境变量、重定向 console、事件循环
   监视器）留给进程所有者，并显式接收自己的运行时环境。
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

| 切片                              | 交付内容                                                                                                                                                                                                                                                                                                                                 | 验收检查                                                                                                                                                                                                                                             | 参考                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **M1 — 前置条件**（本次变更）     | Legacy 拒绝 `managed` owner 记录；worktree reset 的用途标记；Live 任务的决定；本设计。                                                                                                                                                                                                                                                   | 见 M1 的验收标准。                                                                                                                                                                                                                                   | `2f00ac26e3`（拒绝，改为只认明确证据）   |
| **M2 — 进程内 ACP 宿主**          | 把 `runAcpAgent` 拆成进程所有者（stdio、删除环境变量、重定向 console、事件循环监视器、退出）和一个宿主；宿主可在任意 ACP 流上承载 `QwenAgent`，并在释放时交还自己拥有的一切而不退出进程。`runAcpAgent` 改用该宿主。                                                                                                                      | ACP 测试套件不变；基于 `createInMemoryChannel` 的宿主能创建会话、发送 prompt、关闭会话，然后释放，且没有泄漏句柄、定时器、MCP 客户端或环境变量改动。                                                                                                 | `bf06117511`、`d63eec71a1`               |
| **M3 — 严格配置快照**             | 对兼容契约中每项配置输入的只读快照：读取各层 settings 时不做迁移写入、备份或重置（迁移只在内存中进行；缺失、不可读、损坏和版本未知的层彼此区分），带错误的 `.mcp.json`，所有来源的 Hooks，不加锁地证明 extension store 为空，转发的 argv，信任状态与 cwd，以及请求选项；外加返回 `compatible`、`deferred` 或 `unknown`（附原因）的评估。 | 读取不改变任何字节或元数据文件；每个输入来源单独都能使配置成为 `deferred` 或 `unknown`；对空的受信工作区评估为 `compatible`。                                                                                                                        | `a836081466`、`306cf17546`、`d48161bc4a` |
| **M4 — Managed Session log 记录** | 宿主的 recorder 在 certified writer lease 下通过 authority 的 record sink 写入；恢复读取 log 的 projection；关闭时封存 log。                                                                                                                                                                                                             | 以这种方式记录的会话恢复后历史相同；Legacy 入口凭 header 拒绝它；在第一次提交之前崩溃，不会留下 Legacy 能运行的 Managed 会话。                                                                                                                       | `e98cda5c95`、`1ed806ca85`、`f501d9694d` |
| **M5 — Runtime 承载的工具**       | 会话独占的本地 Runtime worker，在第一次工具调用时惰性启动并绑定到会话目录；Read、Write、Edit 和前台 Shell 无需等待 worker 即可声明，在宿主中准备并做权限检查，在 worker 中执行；取消能到达 worker 的进程；模型继续之前结果已持久写入 log；结果未知时阻塞而不是重放。                                                                     | 宿主不为工具调用执行任何文件写入或进程启动；取消有物理停止的证据；结果丢失时会话被阻塞。                                                                                                                                                             | `7786edd123`、`5dde5c8dd7`、`174e072ac4` |
| **M6 — 引擎**                     | Managed 通道 factory（M2 宿主、M4 记录、M5 工具、M3 复核、owner 与回执），Bridge 在 Managed 通道上调用的扩展方法（会话关闭、工作区变更确认、用户语言、资源快照），工作区控制的决定，在 `--experimental-paired-engines` 之后注册到三个 daemon 构造点和嵌入式默认 Bridge，以及生命周期（关闭、排空、撤销、代际与环境重载）。               | 在双引擎 daemon 上，受信工作区中配置为空的普通新会话经真实路由在 Managed 上运行：创建、prompt、工具调用、取消、关闭，以及 daemon 重启后的冷恢复。延期配置留在 Legacy，新的 deny 规则送达存活的 Managed 会话，关闭开关后 Legacy 拒绝该 Managed 会话。 | `824e92d84f`、`306cf17546`               |

M2 与 M3 互不依赖。M4 和 M5 依赖 M2。M6 依赖以上全部，也是唯一能让会话选中
Managed 的切片。

### M1：前置条件

#### Legacy 拒绝

明确的 Managed 证据包括原有的 Managed Session header，以及一条完整的 transcript
行，其记录为 `type: "system"`、`subtype: "session_execution_engine"` 且
`systemPayload.engine: "managed"`。消息中的文本不算。Managed owner 总是先于其他内容
写入，因此该检查读取与 header 检查相同的 64 KiB 头部窗口。与 header 检查一样，读取
出错时它放行：无法读取的 transcript 之后会自行失败。

三个现有的拒绝点改用新的检查。每个执行、记录或 fork transcript 的 Legacy 入口都会经过
其中之一：

| 入口                                                                                                          | 拒绝点                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| CLI `--resume` 与 `--continue`                                                                                | `loadCliConfig` → `SessionService.assertLegacySessionExecution`                                               |
| CLI `--fork-session`                                                                                          | 同上，之后 `SessionService.forkSession`                                                                       |
| 未配对宿主上的 ACP 冷 `session/load` 与 `session/resume`，包括 IDE 客户端、channels 和未配对的 daemon runtime | `loadCliConfig` → `assertLegacySessionExecution`，映射为 -32024 和 409 `session_execution_engine_unavailable` |
| ACP 会话 source 复制                                                                                          | 其临时恢复 Config 经过 `loadCliConfig`                                                                        |
| TUI `/resume`（Ink 与 OpenTUI）                                                                               | `assertLegacySessionExecution`                                                                                |
| TUI `/branch`、ACP 分支与 side task                                                                           | `SessionService.forkSession`                                                                                  |
| 不持 writer lease 写入的 recorder                                                                             | `ChatRecordingService` 中的会话文件检查                                                                       |

热 attach 或 live load 复用存活会话，而 Legacy 子进程只会持有 Legacy 会话。只读的
transcript 读取、重放和列表仍然可用。重命名和封存维护 lease 仍只检查 header，读取器
选择 Managed projection 时也一样：它们依赖 Managed Session log 格式（Managed 的标题是
一条已提交的领域记录），而单独一条 owner 记录并不具备这种格式。双引擎宿主不变；
其选择器已经会拒绝没有引擎能运行的 Managed owner。

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

## 文件与消费者

| 切片 | 文件                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| M1   | core `utils/sessionStorageUtils.ts`、`services/sessionService.ts`、`services/chatRecordingService.ts`；CLI `serve/routes/session.ts` |
| M2   | CLI `acp-integration/acpAgent.ts`；acp-bridge `inMemoryChannel.ts`                                                                   |
| M3   | CLI `config/settings.ts`、`config/mcpJson.ts`；core extension store；一个新的 CLI serve 评估模块                                     |
| M4   | core `config/config.ts`、`services/chatRecordingService.ts`、`managed-runtime/*`                                                     |
| M5   | core 工具与调度器；CLI `serve/managed-runtime-*`                                                                                     |
| M6   | CLI `serve/session-execution-engine-selector.ts`、`serve/run-qwen-serve.ts`、`serve/server.ts`；一个新的 Managed 通道模块            |

任何切片都不改动 daemon 路由或 REST 形态。M1 不改变任何公开分类：它的拒绝使用
已有的 `session_execution_engine_unavailable`。

## 验证与验收标准

M1：

1. 未配对的 Legacy 宿主拒绝执行、fork 或记录唯一 Managed 证据是 `managed` owner
   记录的 transcript，并使用已有的分类；transcript 字节不变，也不会创建 fork 目标。
2. 带 Legacy owner、没有 owner 记录、含有无法完整解析的行，或在消息文本或其他记录中
   包含 owner 记录内容的 transcript，不会被当作 Managed：未配对的 Legacy 宿主仍能执行
   它们，带 Legacy owner 的 transcript 仍能 fork。
3. 带 Managed Session header 的 transcript 行为不变，包括拒绝重命名。
4. worktree reset 在 spawn 替代会话时带上 worktree 元数据，双引擎选择器把它视为延期
   用途。
5. build、typecheck 和定向测试通过；对每个拒绝点或 reset 元数据做变异，都会使某个
   测试失败。

整个引擎由 M6 的验收检查判定，并同时满足 B2d 中在注册引擎后适用的标准：即使评估
返回 `compatible`，延期用途仍留在 Legacy；`deferred`、`unknown` 和失败的评估使新会话
选择 Legacy，并使 Managed 恢复准确失败；之后改变评估结果，既不改变已 attach 的会话，
也不改变已持久化 owner 的会话。

## 风险与待解问题

- owner 检查读取头部窗口。写在前 64 KiB 之后的 owner 记录看不到；Managed owner 总是
  最先写入，而且双引擎选择器无论如何都会读取整个 transcript。
- 当最近的会话属于 Managed 时，`qwen --continue` 现在会失败，而不是在 Legacy 上恢复它。
  这是预期的拒绝，但用户能看到。
- 进程内宿主与 daemon 共用进程：Managed 会话中未捕获的失败或内存增长会影响 daemon，
  而 Legacy 子进程是隔离的。M2 必须把宿主故障限制在通道之内；M6 必须决定 Managed
  通道报告什么样的资源快照，因为它的内存就是 daemon 自己的内存。
- M4 的记录路径和 M5 的 Runtime 工具是最大的两块移植；各自可能需要在其设计更新中
  进一步切分。
- Managed 通道是否应响应预热和保活，暂时沿用 B2c 的规则：两者仍只用于 Legacy。
