# ACP bridge 控制面 / harness 边界

[English](2026-09-14-acp-bridge-control-plane-harness-boundary.md) | [简体中文](2026-09-14-acp-bridge-control-plane-harness-boundary.zh-CN.md)

状态：生命周期注册表、握手、传输操作与启动四个切片的历史设计及验证记录，2026-09-15。
剩余拆分现已实现；最终组合验收记录在[完成设计](2026-09-15-acp-bridge-completion.zh-CN.md)中。
对应 [#11866](https://github.com/QwenLM/qwen-code/issues/11866)。代码和测试基线
基于 `9efdd898e7`；本地实现与验证结果在下文单独标明。

## 问题与现状

在基线版本中，`packages/acp-bridge/src/bridge.ts` 有 15,358 行，其中
`createAcpSessionBridge` 工厂约占 12,585 行，同时拥有会话策略和 ACP channel
监管职责。问题在于职责和可变状态交织，仅把函数搬到多个文件并不能解决问题。

公共 `AcpSessionBridge` 接口已在 `bridgeTypes.ts` 中定义。`channel.ts` 已有
`ChannelFactory` 和 `AcpChannel`，物理 spawn 已实现在 `spawnChannel.ts`。
复用这些边界。`deriveConfig` 属于 `packages/core/src/config/config.ts`，
不属于这个 bridge，不应搬到这里。

每个 bridge 绑定一个规范化工作区，多个会话复用其 channel。一个 channel
可供 attach，但替代 channel 可以与等待退出的旧 channel 同时存活。
`aliveChannels` 有意保留旧 channel，让同步 shutdown 仍然能够找到它。
`byId` 是会话表，它与 channel 注册表的所有者和生命周期不同。

## 目标与范围

- 为 channel 监管和会话控制建立明确的内部所有权。
- 保持公共 bridge 方法、ACP 消息、HTTP/SSE 行为、错误、遥测、执行顺序和
  工作区隔离不变。
- 按可独立评审的 PR 交付，每一步都有行为验证证据。

本工作不实现 Java 服务、远程传输、`wake(sessionId)`、`getEvents()`、worker
池或外部事件存储。bridge 当前在宿主进程创建 `EventBus` 和 compaction engine。
保留上限不能证明每个空闲会话实际占用相应大小的堆，模块拆分本身也不会减少保留量。

## 所有权与内部边界

| 职责                                           | 抽取后的所有者                                                 | 边界规则                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 工作区选择、信任、环境构造                     | 现有 runtime 调用方                                            | 用已解析的工作区和依赖构造单个 bridge；supervisor 内不得选择兜底 runtime。                                |
| 当前 channel、存活 channel 注册表、启动合并    | Channel supervisor                                             | 区分 attach 可用性与传输/进程生命周期。                                                                   |
| Factory 调用、ACP 握手、存活检测和物理终止     | Channel supervisor                                             | 消费现有 `ChannelFactory`；报告 channel 结果，不修改会话策略。                                            |
| `byId`、默认 attach、会话创建/恢复和归属       | 会话控制面                                                     | 每个会话绑定实际所属 channel；替代的当前 channel 不接管旧会话。                                           |
| Prompt admission/FIFO、mid-turn 提升、终态去重 | 会话控制面                                                     | Supervisor 不拥有队列、终态 latch 或事件发布职责。                                                        |
| Event/journal 状态、权限结算、artifact 转发    | 会话控制面及现有模块                                           | 保留现有持久化和发布顺序；不增加另一条存储或 ingest 路径。                                                |
| Worktree 归属                                  | 会话控制面及现有 worktree 操作                                 | 保留会话级元数据和转移屏障；派发时把所选目录传入 ACP 请求。                                               |
| Idle 和退役策略                                | 会话控制面提供可回收条件；supervisor 执行 channel 生命周期动作 | 判断 idle 前纳入 restore/new-session 结算、runtime reservation、workspace 调用和子进程 active-work hold。 |

`BridgeClient` 当前在 `ensureChannel` 内构造，其回调会访问会话状态并发布事件。
最终拆分中，应在组装处把现有会话查找和处理器接入该适配器，再把得到的 ACP client
交给 supervisor。不要把整个 bridge、`byId` 或通用共享状态对象交给 supervisor。
会话清理应成为具名的控制面 channel-exit 处理器，保留它与注册表清理、订阅关闭之间
的执行顺序。

依赖方向是会话控制面 → channel 操作，同时在组装时显式提供 ACP client 和 exit
处理器。这些都是内部 TypeScript 边界，不是新的远程协议或 package export。

## 首个实现 PR：channel 生命周期注册表

从三个生命周期状态槽开始：`channelInfo`、`aliveChannels` 和
`inFlightChannelSpawn`。在内部 `channel-lifecycle.ts` 模块中封装其修改操作。
初期保持现有 `ChannelInfo` 结构；若避免循环导入需要，可把其声明移至内部类型
模块。不移动 `SessionEntry`，也不把它做成通用注册表框架。

内部接口只提供现有调用方需要的操作：

| 操作                     | 必须保持的语义与当前消费者                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 读取当前槽位             | 保留原始槽位，包括 dying channel；`liveChannelInfo` 保留现有可用性过滤。消费者包括 ACP 回调路由、启动、存活检测和 idle 检查。 |
| 读取或加入正在进行的启动 | 共享一次启动的结果，并在结算时清空槽位，包括拒绝路径。消费者包括 `ensureChannel`、`doSpawn` 遥测、runtime 状态和 shutdown。   |
| 登记、发布和移除 channel | 在等待初始化前登记；仅在现有握手成功位置发布；仅在 exit 时移除。旧 channel 退出时，只有当前槽位仍指向它才清空槽位。           |
| 检查已登记的 channel     | 成员查询和快照供会话所有者查找、结算/存活守卫、状态和两条 shutdown 路径使用。调用方不能通过暴露的可变 set 增删成员。          |

首个 PR 中，启动主体、runtime epoch 分配、`BridgeClient` 构造、exit 副作用、
`isDying` 转换、idle timer 和 shutdown 编排仍留在 `bridge.ts`。启动回调可以
暂时保留现有闭包；这是渐进的所有权抽取，不代表 harness 边界已经完成。shutdown
检查和 idle 取消仍放在启动复用/合并之前的原有位置。保留状态的同步可见性，不增加
额外的异步派发步骤。

逐一审查三个旧变量的所有读写，包括 `channelInfoForEntry`、`doSpawn` 的
`reused`/`joined`/`spawned_on_request` 遥测、
`getWorkspaceRuntimeLifecycleSnapshot` 和 shutdown 对进行中任务的等待。
channel 注册表不得决定 admission、quarantine、runtime trust 或会话终止。
quarantined channel 是否拒绝新会话，与其现有会话能否继续使用该 channel 是两件事。

预期源码范围：`bridge.ts`、新的内部生命周期模块、必要时增加内部 channel 类型
文件，以及同目录/定向测试。预期不改 core、路由、SDK、package exports 或依赖
清单。生产代码改动以几百行为宜；若需要搬走整个启动函数或重写回调接线，应继续拆小。

首个切片现已把 `ChannelInfo` 和 `createChannelLifecycle` 一起放入
`channel-lifecycle.ts`，无需另建类型文件。显式 `ChannelLifecycle` 接口提供
`current`、`starting`、`size`、`has`、`values`、`track`、`publish`、`remove`、
`startSpawn` 和 `finishSpawn`。set 本身保持私有，`values` 保留原有的实时迭代
语义。`startSpawn` 同步返回原始启动 promise，创建者仍在 `ensureChannel` 原有
的 `finally` 中调用 `finishSpawn`。会话清理、握手发布和 shutdown 保留原有顺序。

## 第二个实现切片：握手协议

将同步 ACP initialize 请求构造与能力协商抽取到内部 `channel-handshake.ts`。
其中 `createChannelInitializeRequest` 和 `negotiateChannelCapabilities` 两个函数
只接收私有父进程 capability、已解析的文件读取委托布尔值、initialize 响应，以及
是否要求外部工具执行防护。结果包含协商后的 active-work 间隔/类别和 channel-liveness
支持状态，不包含会话状态、channel 注册表、计时器或传输对象，也不从包中导出。

保持所有声明的元数据、协议/client 标识、文件系统标志、强制 guard 确认错误、版本
检查、间隔限制和类别过滤不变。缺失或不支持的可选能力仍为未协商，不能解释为空闲报告。
私有父进程 capability 必须与传给该 channel 物理 factory 的值一致，替换 channel
时也要保持此对应关系。

initialize 调用、剩余启动预算、超时/传输竞速、遥测 span 和 profile、失败清理、
runtime epoch 及发布继续留在 `bridge.ts`。在原有 span 回调内，同步协商后立即将
解析的 active-work 能力与初始 `seq: 0` 一起赋值，位置仍在 profiler 和返回响应之前。
liveness 支持状态也在此赋值。新增异步边界或把赋值移到 span 外部可能丢失早到的
active-work snapshot，不在本次范围内。

复用已有的 guard、私有 capability、文件能力、active-work、liveness 和启动失败
bridge 测试作为回归证据。补充 bridge 层测试，覆盖不支持的能力版本，以及 initialize
span 完成前已进行协商。在源码抽取前运行这些测试，重新用全局 `qwen` 执行公共
HTTP/SSE 基线，再构建、typecheck、bundle、运行受影响测试并使用本地 bundle 重跑
E2E harness。验收标准是握手 wire 构造/解析由新模块独立拥有，不增加异步跳转，
生命周期和会话行为不变。此切片不代表完成启动监管或整个 Issue。

## 第三个实现切片：传输操作

将物理终止与 channel 不可用竞速移到内部 `channel-transport.ts`。
`terminateChannel(channel, timeoutMs, context)` 接收现有 `AcpChannel` 和已解析的
bridge 初始化超时，立即启动 `kill()` 并限制其完成时间，失败时尝试 `killSync()`。
即使强制信号发送成功，也保留原始拒绝；若两次操作都失败，则保持 `AggregateError`
中的错误顺序。bridge 继续在请求终止前标记 dying 并停止 liveness。

`channelUnavailableReject(channel, context)` 保持为同步函数，返回针对进程退出及
可选传输失败的既有竞速，将 fulfilled 和 rejected 两种结果都映射成
`BridgeChannelClosedError`。不增加异步包装或提前订阅。会话和 workspace-status
缓存仍在 bridge 中，后续命令复用已有的拒绝 promise，并保持实际所属 channel。

把唯一的 `withTimeout` 实现原样移到内部 `with-timeout.ts`，供两个模块直接导入。
保留错误类型、计时器引用、`finally` 清理和不取消底层操作的语义，不引入新的超时
策略或兜底。独立放置该依赖，可以避免传输操作导入会话代码或重复实现计时器。

终止操作的消费者包括 channel kill/idle 退役、pending-empty-channel 回收、迟到
factory 结果清理、连接构造失败、initialize 失败、迟到 shutdown、initialize 期间
退出、无效 runtime epoch，以及 bridge shutdown。不可用竞速的消费者包括
initialize、新会话创建、缓存的会话竞速、缓存的 workspace-status 竞速、restore，
以及 branch-session 清理。保留每处调用原来的 channel、context 和 timeout。
本切片不移动路由、注册表、会话清理处理器或 package export。factory 调用仍在原处，
因为其 abort controller 和启动预算还约束握手及 epoch 失败；现在移动它需要更大的
启动边界。

抽取前补充 bridge 层测试，覆盖挂起终止的 deadline 和强制信号、普通/强制终止同时
失败，以及 prompt 挂起时传输失败 promise 被拒绝。已有测试继续覆盖正常 shutdown、
构造清理、新旧 channel 重叠、握手期间退出、restore、status 和命令超时。重新运行
全局及本地公共 E2E、build、typecheck、bundle 和定向测试。验收标准是传输操作独立，
调度、错误、channel 归属与清理保持不变。

## 第四个实现切片：启动编排

将完整的异步启动主体移到内部 `channel-startup.ts`。
`createChannelStartup` 拥有本地 runtime epoch，仅暴露只读 `epoch` 和 `start`。
生命周期注册表继续合并原始启动 promise；`ensureChannel` 保留 shutdown 准入、
idle 取消、复用，以及创建者的 `finally`。初始 epoch 校验仍在 bridge 构造时执行，
后续 epoch 消费者统一读取启动所有者的值。

把 factory 调用、私有 capability 和 channel ID 生成、共享启动时钟与 abort
controller、构造失败清理、登记、initialize、迟到 shutdown/exit 检查、epoch
校验、发布和 liveness 安装保留在同一个异步函数中。保持每个现有 `await` 的位置。
尤其不能从异步 factory helper 返回后再登记，也不能把初始化结果异步返回 bridge
后再发布。initialize span 仍在 profiling 和返回前赋值 active-work 状态。
所有现有错误、遥测、时间预算和迟到结果清理都保留原有顺序。

bridge 提供同步的 `constructChannelInfo`、
`handleChannelTransportUnavailable` 和 `handleChannelExit` 动作。
`constructChannelInfo` 把 `BridgeClient`、带 guard 的 connection 构造、会话
集合与 active-work 回调接线保留在一起；启动所有者保留外层物理构造失败 catch。
传输动作在启动所有者标记失败并停止 liveness 后清理 extension refresh。
退出动作保留 timer、注册表、会话、prompt 终态、attachments 与事件总线的完整
有序清理。启动仅在原位置注册该动作，不接收 `byId` 或 `SessionEntry`。
现有 `killChannelWithLog` 动作继续作为 liveness 的 fallback，
`isShuttingDown` 读取实时准入状态。其他输入是已解析的 factory、workspace、
环境快照、timeout、telemetry、注册表和 epoch source；外部工具 guard 是否存在
仍在协商时读取。`ChannelLifecycle` 从其内部模块导出，供新增的类型消费者使用；
不增加 package export。

本切片移动启动及其 epoch 的所有权，idle/会话策略和退出清理所有权保持原处。
不新增公共选项、路由、package exports 或跨包依赖。移动生产代码前，补充确定性
bridge 回归，覆盖 factory/initialize 共享 deadline、initialize span 前同步登记
channel，以及发布前发生 shutdown。保留此前的能力协商时序、共享启动、迟到
factory 清理、构造失败和 epoch 测试。先运行全局公共 E2E 基线，再执行 build、
typecheck、bundle、定向测试和不变的本地 E2E。验收要求事件循环顺序、会话与
channel 归属和正常公共行为保持不变；整个 Issue 仍包含后续控制面及 channel-exit
职责拆分。

## 后续 PR 与关联工作

1. 在具名 exit 动作中区分 channel 自身的退出清理与会话清理，再把前者移交
   channel 所有者。只有带齐 busy 和 reservation 输入，才能移动 idle 调度。
   内部接口只按已观察到的消费者需求扩展。
2. 先抽取会话生命周期，再分批抽取 prompt admission/FIFO、mid-turn 处理、终态
   发布和 artifact 转发。保留原工厂作为组装点，公共接口继续作为 facade。
3. 随切片落地，同步更新两种语言的设计，记录实际边界和验证证据。文件行数本身不
   构成验收证据。

[#11867](https://github.com/QwenLM/qwen-code/issues/11867) 可以并行定义和测试
daemon 外部契约。进程数量和 spawn 合并属于 bridge/lifecycle 测试，不属于跨实现
的 wire 契约。[#11868](https://github.com/QwenLM/qwen-code/issues/11868) 负责
事件存储和保留策略变化。与 [#11869](https://github.com/QwenLM/qwen-code/issues/11869)
同步边界，但不把其 Java 实现作为首个内部抽取的前置条件。

## 验证与验收

调查期间，`packages/acp-bridge/src/bridge.test.ts` 的 8 个现有测试通过
（共 940 个，跳过 932 个）。覆盖工作区不匹配、thread scope 的 channel 复用、
混合 scope 并发创建、重叠 channel 的强制终止、同会话 FIFO、single scope 启动
合并、channel-exit 扇出和并发活跃 prompt。这是定向基线，不是全量测试或 E2E
认证。

不要夸大这些测试的覆盖：混合 scope 测试检查会话不同，但未断言物理 factory 调用
次数；single scope 合并测试可能仅靠外层会话 spawn 去重就能通过。
`channel-lifecycle.test.ts` 新增的三个测试已在抽取前通过：独立 thread-scope
调用方共享一次物理启动并获得两个会话；共享启动被拒后可重新启动；旧 channel
退出后，替代 channel 仍能接收新会话和现有会话的 prompt。测试用可控 promise
保持启动和物理终止窗口，不依赖时间延迟。

| 不变量          | 生命周期抽取必须提供的证据                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 工作区隔离      | 不匹配的请求在创建另一个 channel 前失败。                                                                                   |
| 启动合并和恢复  | 独立会话创建加入同一次物理启动；拒绝到达两个调用方；后续调用可以重试。                                                      |
| 发布和启动失败  | 初始化期间退出、factory 超时/abort、迟到 factory 结果清理和 runtime epoch 单调性的现有 preheat 测试继续通过。               |
| 替代和 shutdown | 新旧 channel 可重叠；旧 exit 保留新的当前 channel；同步 shutdown 能找到二者；启动中的 shutdown 不得发布迟到的存活 channel。 |
| 会话行为        | 同会话 FIFO、跨会话并发、共享 channel 的兄弟会话存活和 exit 扇出保持不变。                                                  |
| Idle 条件       | 复用和 timer 取消、pending restore/new session、workspace 操作和 keep-alive reservation 保留现有保护。                      |

修改生产代码前，在 `.qwen/e2e-tests/` 写可执行 E2E 计划，针对公共
create/prompt/SSE/delete 和工作区隔离场景，用全局 `qwen` CLI 进行基线 dry-run。
内部启动/退出竞态使用确定性的 fake channel。每个源码切片完成后，在根目录运行
build 和 typecheck、包内定向测试，并针对本地 bundle 运行受影响的 E2E 场景。
最终拆分还须通过 #11866 要求的全量测试，以及 `AGENTS.md` 要求的连续两轮干净
自审。

最初准备文档时尝试了根目录 `npm run build`；它在现有 core 代码中失败，原因是缺少
`@jitl/quickjs-singlefile-mjs-release-sync` 和 `quickjs-emscripten-core`，
并产生了相应的隐式 `any` 错误。另行运行根目录 `npm run typecheck` 也失败，
除上述错误外还有过时的 workspace 声明：例如 `DAEMON_SUBMITTED_PROMPT_META_KEY`
存在于 bridge 源码中，但本地构建声明中没有。实现前先修复依赖安装、重新构建
workspace：运行 `QWEN_SKIP_PREPARE=true npm ci` 恢复锁定的依赖，未修改 manifest
或锁文件。随后根目录完整 build 和 typecheck 均在生产代码抽取前通过。

全局 `qwen` 0.23.3 E2E dry-run 也在抽取前通过：工作区不匹配返回 400，并发创建
返回不同会话，每个 SSE 收到自己 prompt 的结果和恰好一个终态，删除返回 204，
关闭首会话后兄弟会话仍可继续 prompt。三次模型请求全部使用本地 fake endpoint，
daemon 正常退出且没有测试进程残留。可执行计划和报告位于
`.qwen/e2e-tests/issue-11866-channel-lifecycle.md`。

抽取后，根目录 build、typecheck 和 bundle 均通过，三个源码/测试文件的 ESLint
以及格式检查也通过。五个受影响的 bridge 测试文件共 965 个测试全部通过。同一个
E2E harness 在本地 bundle 上通过；归一化后的 HTTP method/route/status 序列、
三个 prompt 终态、fake model 请求和清理结果均与全局基线一致。这些证据验证首个
切片，不代表整个拆分最终要求的全仓库测试已通过。

第二个切片用 115 行实现了上述两个同步握手函数。新增的三个 bridge 层测试在抽取
前后均通过：未知的数字和字符串能力版本保持禁用；initialize span 返回前接收的
空 active-work snapshot 保留其序号，迟到的旧 snapshot 不能覆盖它。后一个测试
还验证更新的报告能被接受。临时把能力赋值推迟到 span 返回后，会使该测试失败；
该临时改动随后已移除。AST 对比确认 initialize 请求和 active-work 间隔/类别
表达式与抽取前源码一致。根目录 build、typecheck、bundle、ESLint，以及八个
受影响测试文件的全部 981 个测试均通过。

第二个切片的公共 E2E 也在本地 bundle 上通过，HTTP 序列、prompt 终态、模型请求
和清理结果与重新执行的全局基线一致。两次对照运行均正常退出，没有测试进程残留。
更早的一次全局运行虽通过公共断言，却在 shutdown 时退出 1；报告保留了这项间歇性
基线观察，不推断其原因。独立计划和证据记录在
`.qwen/e2e-tests/issue-11866-channel-handshake.md`。

第三个切片新增的四个 bridge 层测试在抽取前后均通过，覆盖精确的终止 deadline
和强制信号、底层操作迟到完成后仍保留该超时、同步和异步 kill 失败与强杀失败的
组合，以及传输信号被拒绝后在进程退出前结束挂起的 prompt。AST 对比验证了三个
抽取函数的函数体、全部九处终止调用的 channel/context/budget 输入、六处不可用
检测调用，以及另外 47 处超时调用。根目录 build、typecheck、bundle、ESLint
以及九个受影响测试文件的全部 985 个测试均通过。

第三个切片的公共 E2E 在 HTTP 结果、prompt 终态、模型请求和清理方面均与其全局
基线一致。两个 daemon 都退出 0；独立的进程和 TCP 检查还确认本地测试进程及监听
端口均无残留，日志中没有 shutdown 错误。独立计划和证据位于
`.qwen/e2e-tests/issue-11866-channel-transport.md`。这些结果验证三个本地切片，
不代表整个 Issue 或全仓库测试已完成。

第四个切片新增的三个 bridge 回归在抽取前后均通过：50 ms 预算中 factory 消耗
30 ms 后，initialize 只剩 20 ms；connection 构造安排的微任务能强杀已登记的
channel；shutdown 等待未完成的 factory，并拒绝发布其结果和分配 epoch。
临时在登记前插入异步边界后，第二个测试因为强杀找不到 channel 而失败；最终验证
前已恢复源码。

独立 AST 比较确认完整 exit 处理器、client/connection 构造、channel 初始状态和
传输错误过滤保持一致。将同步动作调用和实时状态读取作对应替换后，完整启动主体
保持一致；替换启动接线及四处 epoch 读取后，bridge 工厂的其余部分也保持一致。
首次构建发现新注册表消费者所需的内部类型尚未导出；补充该导出后，完整 build、
typecheck、bundle 和 ESLint 全部通过。十个受影响测试文件的全部 988 个测试通过。
此前生命周期、握手和传输代码/测试除这一类型导出外均未变化。

独立审查发现，shutdown 等待回归原先只等待一个微任务，可能漏掉提前完成的
shutdown。测试现改为在 factory 仍挂起时等待一个事件循环轮次。移除启动等待后，
旧断言仍通过，新断言则失败，确认加强后的测试能发现漏掉等待的回归。生产代码的
临时改动已恢复；本次修正只改变测试，并重新执行最终验证及两轮自审。

第四个切片最初的公共 E2E 在 HTTP 结果、prompt 终态、模型请求和清理方面均与其全局
基线一致。两个 daemon 都退出 0；独立的进程和 TCP 检查确认本地测试进程及监听
端口无残留，日志中没有 shutdown 错误。报告和证据位于
`.qwen/e2e-tests/issue-11866-channel-startup.md`。这些结果验证四个本地切片，
不代表整个 Issue 或全仓库测试已完成。

后来一次审查后的本地 sanity 虽通过全部公共断言，daemon 却退出 1：子进程在
约五秒后需要 SIGKILL，daemon 报告关闭未完成。harness 本身退出 0，且无进程或
监听端口残留。该运行属于公共行为一致、shutdown 不一致，已在启动 E2E 报告中
单独保留。其生产源码指纹与此前成功的本地运行相同。更早的全局握手基线也曾出现
类似失败，但这些观察既不能证明根因相同，也不能排除启动抽取的影响。随后不改变代码和 harness，串行重跑全局与本地，两次均匹配原基线并退出 0，
独立进程和端口清理检查也通过。这些成功重跑不覆盖退出 1 的记录。关闭异常根因
尚未确定，本次抽取不声称修复它。

后续调查在未修改的全局版本中，使用隔离用户配置下的 32 个合法技能，两次复现
退出 1，其中一次完全没有诊断插桩。插桩失败样本表明，Config shutdown 关闭
workspace 监听器时同步阻塞在 macOS FSEvents 中，直到父进程五秒 TERM 等待
到期。这确认了一种不依赖本次抽取的原生监听器关闭故障，但不能追溯认定所有
早期失败都卡在同一操作。独立复现脚本现会在 daemon 实际非零退出时失败。
使用已有的 `CHOKIDAR_USEPOLLING=1` 启动设置后，同一夹具在全局与本地版本
均通过公共检查并退出 0，进程和端口清理也已确认。轮询是已验证的临时缓解方式，
没有成为默认设置，也不属于永久修复。生产代码保持不变。证据和限制记录在
`.qwen/issues/issue-11866-shutdown.md` 和
`.qwen/investigations/issue-11866-shutdown/journal.md`。

首个 PR 的验收条件是三个生命周期槽位只有一个所有者、不暴露可变注册表、可观察
行为不变，并提供上述证据。整个 issue 的最终验收还要求 supervisor 不再捕获或
修改会话注册表、队列、终态 latch 或事件存储。两级验收都不包含公共 wire/type
变化或新增行为。

## 风险与剩余决策

主要风险是回调时序变化、丢失 dying channel、把旧会话路由到替代 channel、遗漏
shutdown waiter，以及把空会话表误判为 runtime 无工作。每个 PR 都要对照实际
源码版本审查这些消费者。

启动现已使用显式同步的构造与清理动作，但 `ChannelInfo` 仍包含现有策略使用的
会话字段。后续 exit/idle 抽取必须分离这些职责，不能把这一过渡类型视为最终
transport 接口。它不冻结未来面向 JVM 的 ABI。worktree 执行仍是会话级的，
后续 harness 接口必须携带该归属，且不能重新绑定 workspace。
