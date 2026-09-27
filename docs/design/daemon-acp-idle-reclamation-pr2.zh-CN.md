# PR2：准入名额已满时回收空闲 ACP 进程

[English](daemon-acp-idle-reclamation-pr2.md) | [简体中文](daemon-acp-idle-reclamation-pr2.zh-CN.md)

## 1. 状态与交付边界

已在本地实现并完成下述验证，日期为 2026-09-15。源码基线：`88347ccca394902262915dde880499976e596cd7`，即已合并的 [PR1 #11911](https://github.com/QwenLM/qwen-code/pull/11911)。交付跟踪：[#11907](https://github.com/QwenLM/qwen-code/issues/11907)。本次变更包含 PR2 实现与相邻回归测试，运行证据记录在本地 E2E 报告中。

PR1 已交付可选启用的 daemon 全局 ACP 进程数量准入，以及可识别的容量错误。PR2 增加按需回收符合条件的空闲 ACP 子进程。PR3 仍负责自动回收无能为力时，让用户选择关闭 workspace runtime 或取消。上述阶段都不施加建模的单 child 堆上限，也不完成 [#8182](https://github.com/QwenLM/qwen-code/issues/8182)。

**首版只自动回收 live session 数量为零且没有待处理工作的 ACP channel。** 过期且无人使用的 session 继续交给现有 session reaper；不提前其超时，也不因为很久没有生成内容就关闭仍连接着的聊天。现有 reaper 关闭所有 session 后，仍保温的 channel 才能成为候选。

这有意收窄了 proposal 中“按需关闭已加载但空闲的 session”这一更宽的选项。后者需要补充持久化、条件关闭和恢复语义，不属于本 PR2。有 SSE 订阅的空闲聊天受到保护；没有订阅但仍已加载的 session，也要等现有生命周期将其关闭。提交实现时应在 tracker 中同步这个边界，不能宣称已经完整支持驱逐已加载的 session。

## 2. 当前行为与缺口

| 现有行为                                                                                                         | 源码                                                                                            | 对方案的影响                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 所有受管理 factory 都先预留再判断，计入已绑定、已预留及退出中尚未释放的 child。                                  | `packages/acp-bridge/src/spawnChannel.ts`、`process-registry.ts`                                | 保留它作为唯一容量依据，不能用注册 workspace 数或 live channel 数替代。          |
| 满额时，`admit` factory 在 OS spawn 前抛出 `AcpChildCapacityExceededError`。                                     | `spawnChannel.ts`                                                                               | 回收后继续原来的 spawn，不能重放 HTTP 请求或 prompt。                            |
| `channelIdleTimeoutMs` 为零时，空 channel 通常立即关闭；正值超时或已完成的 preheat 可以继续保温。                | `bridge.ts`：`startIdleTimer`、`resolvedChannelIdleTimeoutMs`、`preheat`                        | 一个没有 session 和工作的保温 ACP 仍可能占着最后的名额。                         |
| session reaper 默认空闲阈值为 30 分钟、扫描间隔为 60 秒；检查本地工作、订阅、恢复状态和 child 条件关闭保护。     | `bridge.ts`：`entryIsAutoCloseCandidate`、`startSessionReaper`                                  | 沿用已有行为；PR2 不再实现另一套 session 关闭策略。                              |
| runtime 生命周期覆盖启动、停止、session 工作、恢复、未结算启动、MCP/control 操作及预留。                         | `bridge.ts`：`getWorkspaceRuntimeLifecycleSnapshot`、`hasNoChannelWork`                         | 仅凭 `activePromptCount === 0` 或 `bridge.activeWork === false` 无法认定可回收。 |
| workspace 移除还会 drain 服务、dispose coordinator、shutdown bridge，并可能移除注册。                            | `run-qwen-serve.ts`：`disposeRuntime`；`routes/workspace-management.ts`                         | 回收不能调用 removal、bridge shutdown、kill-all 或 workspace DELETE 路由。       |
| channel 退出后再次 ensure 已支持新 child 和递增 runtime epoch；coordinator 能将旧 epoch 的能力状态标记为 stale。 | `bridge.ts`：`ensureChannel` 与退出清理；`workspace-runtime-coordinator.ts`：`status`、`ensure` | 保留 workspace runtime 和 bridge，仅释放物理 child。                             |

本 PR 不回收注册 workspace 的宿主对象，主要收益是在另一个 workspace 需要名额时提前结束空闲 ACP 的保温。如果所有占用名额的进程都有 live session，PR2 仍返回 PR1 的容量错误；不能保证所有冷启动请求都成功。

## 3. 触发条件与完整流程

只在已经完整接线的受管理 `--child-heap-mode admit` 路径启用回收。`off`、`observe`、单 child 消费方及注入或非托管 bridge 保持原样。不增加环境变量、CLI 模式、公开路由或空闲超时设置。

1. 操作需要一个新的 ACP。已有 child 的复用继续走原来的快速路径，不触发回收。
2. factory 预留名额并执行已有策略；准入通过就正常 spawn。
3. 容量拒绝本次尝试时，在等待任何异步回收前取消该次 reservation，否则等待启动的请求本身会继续虚增占用。
4. 请求 daemon 共享的回收 helper 尝试一次。helper 先检查是否已有其他操作释放名额；如果已有容量，就不选择牺牲者。
5. 读取符合条件的 runtime，排除请求方，按最近使用时间排序，并尝试最旧的候选。每次请求 spawn 最多尝试一个候选。没有候选、候选状态变化、关闭失败或目标正被回收时，本次尝试结束，不连锁尝试其他 workspace。
6. 候选 bridge 核验当前 channel/epoch 和空闲状态，通过现有路径同步标记该 channel 为 dying，并等待正常的被跟踪退出流程。保留 workspace runtime 和 bridge。
7. 退出后重新检查请求取消状态和共享 registry。没有名额就返回原容量错误。不能根据 cold 生命周期、仅根 PID 退出、回调返回布尔值或 workspace 数减少，就推断名额已经释放。
8. 确认存在容量后，重新 reserve，再执行同一准入策略，最后才 spawn。其他请求可能先抢到刚释放的名额；此时正常拒绝，不再回收第二个候选。每次 factory 调用最多有一次回收机会和一次后续准入尝试。

不重试外层 create/load/MCP 操作。同一个待完成的 factory 调用在 child 尚不存在时继续执行，因此不会重放已接受的 prompt、worktree 创建或 rollback。普通传输失败、session 数量上限、初始化错误及过期 owner 错误都不触发回收。

## 4. 候选条件与归属

复用 workspace removal 当前的活动聚合，只把共享读取逻辑提取到一个小的 serve helper，不改变 removal 语义。bridge 的详细最终判断仍留在 bridge 内，由其私有 channel 状态提供权威依据。

| 条件                   | 首版规则                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 归属                   | 受管理、已注册、active 且 trusted 的 workspace runtime，其 factory 使用同一 daemon 进程 registry。按 runtime 身份/workspace ID 选择，不根据猜测的 cwd alias 选择。                                                            |
| 请求方                 | 排除发起请求的 runtime，包括旧 child 正在退出时的替换启动。处理 factory 回调时，不能等待该 runtime 自己的待完成 spawn。                                                                                                       |
| primary 与内部 runtime | primary workspace 满足相同条件时可以回收；不可删除不代表资源必须常驻。首版候选不包含内部 Conversations、scratch/standalone 及其他特殊生命周期 runtime。它们启动时仍受准入控制，也可以请求回收一个符合条件的已注册 workspace。 |
| session                | `sessionCount === 0`。任何已加载 session 都阻止选择，包括空闲但仍连接的 session、运行或排队中的 prompt、permission/用户回答等待、后台任务，以及 child 工作报告未知的 session。                                                |
| bridge 状态            | 存在当前 live channel，没有 starting/stopping 重叠，没有 session spawn/restore、未结算清理、runtime 操作预留、workspace control/MCP discovery/authentication，也不处于 shutdown/quarantine/condemned-channel 状态。           |
| daemon 工作            | 没有 pending session start、ACP connection、memory task、channel worker、voice 活动，以及排队或运行中的 coordinator 管理工作。缺少观测 hook 或不支持回收能力时，不进入候选；缺失数据不是零。                                  |
| 保温                   | 已完成 preheat 的 `keepAliveUntil` 和正值 channel idle timeout 属于软保温，容量请求可以提前结束它们。待完成的 preheat 和初始化仍由工作 reservation 保护。                                                                     |
| 身份                   | 被选 runtime 仍处于 active，且 channel/epoch 与候选一致。已 removed、draining、trust-reconfigured 或被替换的 runtime 直接跳过。                                                                                               |

保留 daemon 持有的 terminal 进程、注册、历史、文件、配置、调度器和服务对象。未来计划执行的任务不应导致这些服务被销毁；其执行时可能需要重新 ensure ACP，并经过同一准入策略。活动条件能观测到的运行工作会阻止回收。不能声称杀掉 ACP 同时释放了无关 terminal 进程或整个 workspace 的 RSS。

这些规则有意优先保护 session，而不是尽可能多地回收。这样无需新增“持久化进行中”信号，也无需定义只有内存状态的 session 如何安全关闭。现有 session reaper 及条件关闭行为保持不变。

已注册且不可信的请求 workspace 不能回收其他 workspace 的子进程。尚未发布到 registry 的内部请求方保留共享回调。请求 workspace 替换进程时，旧进程在 registry 释放前仍占名额；这一重叠可能回收其他符合条件的预热子进程，使其下次使用需要冷启动。初始请求也会在现有启动预算内承担候选进程退出的延迟。

## 5. LRU 与时间策略

使用当前 ACP channel 最近一次实际使用时间，不使用注册时间或状态页面轮询时间。在当前 channel 的内部状态中增加一个 `lastUsedAt`，channel 可用时初始化，在实际 session 活动或 workspace control/preheat 工作接受、完成时更新。内部候选 token 包含 channel 身份/epoch 和该时间戳。不为排序单独增加公开 status 字段。

已有 `bridge.lastActivityAt` 不能完整替代：仅预热的 channel 可能一直为 null，且它不覆盖 workspace 管理调用。保留其已有对外语义，避免悄悄扩展 idle-detection API。周期状态读取、诊断和仅重复未变化状态的 heartbeat 不应让新时间戳一直保持新鲜；实质工作状态变化可以更新时间。

候选按 `lastUsedAt` 升序排列，相同时按 workspace ID 稳定排序。这是内存内排序，不承诺分布式时钟或完美单调时钟。空 channel 满足其他安全条件时不再额外等待新的宽限时间：原有保温是优化，明确的容量需求优先。已有 session idle timeout 和 prompt-settled grace 不变。

## 6. 最小实现接点

| 组件                                            | 建议变更与消费方                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawnChannel.ts`                               | factory options 增加一个可选、供内部接线使用的回收回调。仅在 `admit` 的类型化容量拒绝上调用；等待前取消被拒 reservation，随后最多重新 reserve/decide 一次。所有新路径继续处理取消和清理。                                                  |
| serve 回收 helper                               | 一个 daemon 持有的小 helper 读取 workspace registry 和共享活动事实，排除请求方及不支持的 runtime，排序并调用一次 bridge 回收。它读取共享 registry 计数和策略公布的上限，不维护独立容量模型、第二个 registry、持久队列或 HTTP 重试。        |
| `bridgeTypes.ts` 与 `bridge.ts`                 | bridge 接口增加可选的候选读取和空闲 channel 回收能力，轻量 fake 与注入 bridge 可以省略。重新核对当前身份和已有无工作条件，拒绝 condemned/stopping channel，然后复用被跟踪的退出。维护内部使用时间，并且只清理被退出 channel 的软保温状态。 |
| `run-qwen-serve.ts` 与 `server.ts`              | primary、secondary/dynamic 及受管理内部创建路径通过 factory 闭包绑定请求方身份。共享 helper 使用同一 policy/registry。在 registry/活动接线完成前，回调无法回收，沿用容量错误。独立 `createApp` 构建受管理 factory 时也必须遵循同一契约。   |
| `routes/workspace-management.ts` 与 coordinator | 复用现有活动数据源，保留 removal 行为。不为让 session 可回收而放宽 `hasActiveWork()`，也不调用 `dispose()`。保守的零 session 规则不需要另增只表示管理工作的生命周期 API。                                                                  |
| 测试与文档                                      | 扩展相邻 factory、bridge 空闲生命周期和 serve 接线测试。增加确定性 daemon/API 恢复测试；提交时更新 PR1 运维描述和 tracker；保持双语设计一致。                                                                                              |

回调缺省保留 PR1 行为，直接消费方不会意外开始回收其他 runtime。每个新增选项都必须在实际调用方被读取且得到测试，覆盖动态 factory 和受管理 server 构建，不能只测试启动时的 primary factory。

## 7. 失败、取消与并发

沿用讨论中约定的简单候选检查和已有生命周期保护，不引入新的原子驱逐事务、daemon 全局 drain 协议或驱逐锁。bridge 最终身份/无工作检查与标记所选 channel 为 dying 之间不能插入 await；这是保持原有 channel 关闭约束，不是另建协议。

回收前取消的请求不选择候选。如果取消发生在候选退出已经开始之后，让该自有资源清理完成，但不再启动请求的新 child，也不尝试其他候选。等待受已有 factory startup abort/deadline 与终止预算限制；超时不能让迟到 factory 结果逃脱清理。回收耗时计入原启动超时，不新增无限等待额度。factory 等待回收期间，通过可选启动上下文为 bridge 的 deadline 提供容量错误；bridge 使用该错误取消启动，并保留迟到结果清理。回收结束后立即清除该覆盖，后续无关启动超时保持原有错误。

两个调用方同时选择同一候选时，已有 dying/identity 检查让后者跳过，不能强制关闭两次。刚释放的名额不归任何请求专有；其他请求已启动时，最终 reserve/decide 仍是唯一依据。退出后共享 registry 仍无空闲名额（包括后代仍被跟踪）时继续报告容量不足。registry 已释放名额后的退出错误本身不阻止准入；不能手工减 registry 计数或运行宽泛 kill 命令。

候选观测与外部并发活动不是整个 workspace 的事务快照。首版依赖已有保护，并排除所有 live session；不承诺原子停止每个外部参与者。候选在选择过程中变化可能降低回收成功率，应返回容量失败，而不是强制关闭或无限搜索。

回收无法提供容量时，保留 REST `503`、`acp_child_capacity_exhausted` 和 ACP 错误元数据。保留 PR1 草稿和不自动重试的 UX。回收成功不需要 workspace 删除事件或确认弹窗。继续用已有能力 stale 状态和冷启动状态表达恢复，workspace 选择器留在 PR3。

已有 `refusals` 统计的是被拒绝的 spawn 准入尝试。加入回收后，第一次被拒后可能重试成功，因此不能把它描述成用户最终失败的操作数。记录这个区别，本 PR 不另增一套公开指标。回收尝试与失败使用现有诊断通道，正常 channel-exit 日志记录退出；不增加每次轮询或跳过候选的日志。

## 8. 恢复行为

回收保留 workspace ID、alias、注册意图、trust、runtime 存储根目录、环境绑定和 bridge/coordinator 对象。所选 channel 通过正常清理退出。后续 ensure 或已保存 session 的 load 启动新 channel，协商更高的 runtime epoch；过期 MCP/Skills 状态通过已有准备流程重建。

所选 child 没有需要迁移的 live session。已保存会话继续通过其解析后的 owner runtime 加载。冷恢复可能更慢；如果此时所有名额又被占用，仍可能被准入拒绝。不能回退 primary、在 404 时创建替代会话，也不能宣称迁移了未持久化的内存 session 状态。这个仅针对 child 的操作不改变后台调度器和 worker 服务生命周期。

## 9. 验证与验收

按 `e2e-testing` 工作流，使用隔离 daemon、确定性本地 provider 和测试自有子进程。实现前记录全局 CLI 基线；若已包含后续变更，应记录准确版本，而不是编造预期失败。详细本地计划位于 `.qwen/e2e-tests/daemon-acp-idle-reclamation-pr2.md`，基线和实现验证结果记录在其旁。

1. 单名额下，保温空 A 在 PR1 基线中阻止冷 B。PR2 中同一操作应在 A 被跟踪 child 真正释放后成功，注册和已保存历史不变。
2. 多个保温空候选时回收最久未用者。MCP/control 与 preheat 活动更新顺序，反复查询状态不更新；同时间顺序稳定，只尝试一个候选。
3. A 只要有已加载 session，即使没有运行中的 prompt 也受到保护。分别覆盖运行/排队 prompt、permission/用户回答等待、后台工作，以及断开但尚未被 reaper 关闭的 session。PR2 不发送 session-close 或 kill。
4. 空 channel 的活动条件保护并发 create/load、coordinator 排队工作、MCP discovery/OAuth、voice/channel 服务、ACP 连接和 memory job。归属未知或缺失 hook 时跳过；仅已完成的软保温不阻止回收。
5. 并发启动、根/后代延迟退出、退出失败、请求取消及竞争者先获名额时，已获准但尚未绑定的启动加已绑定/尚未释放的 child 不超过上限。先 reserve 再 decide 会让被拒 reservation 短暂使计数超过上限，但必须在任何 await 前取消，且绝不能 spawn。不泄漏 reservation，不尝试第二个候选，也不重放外层请求。
6. 符合条件的 primary 和 secondary 均可回收；特殊/内部候选保持排除。primary、secondary、动态创建及受管理内部请求方均使用共享回调，并保留各自 owner 错误。启动早期没有候选时仍是正常容量失败。
7. 再进入已回收 A 并加载历史，核验 workspace 身份、环境/存储根目录、epoch 递增、MCP/Skills 刷新和无重复 prompt。terminal、scheduler、服务对象及注册均保留。
8. 默认/off/observe 行为、堆参数、session 上限、零名额验证及 PR1 错误/rollback/UI 行为不变。实现后执行 build、typecheck、定向测试及真实 daemon/进程树检查；不能以 mock 释放替代 Linux/Windows 进程树证据。

### 已执行的验证（2026-09-15）

完整 build、typecheck、bundle、定向 lint 通过。ACP 定向测试 80 项、serve 生命周期/路由测试 696 项、独立 server 接线测试 4 项通过。测试覆盖单候选策略、释放前不 spawn、取消/失败/竞争结果、候选身份与活动保护、软保温、MCP 完成更新时间和状态轮询不更新时间。

macOS、Node 22 上 5 组真实 daemon 测试的 52 项断言通过：空保温回收、旧 PID 退出、原 workspace 冷恢复和 epoch 递增、历史保留与原 session ID 加载、已加载空闲会话及 ACP connection 保护、LRU 顺序、动态注册请求方、注册身份及堆参数不变。测试自有进程全部退出，详细报告位于 `.qwen/e2e-tests/pr2-idle-reclamation/verification-report.md`。

未执行 Linux/Windows 验证、真实后代延迟退出与故障注入、真实模型对话及所有业务服务组合。进程取消/竞争等依赖定向单测证据；这些单测不能替代部署目标上的进程树验证。测试不证明实际 RAM 安全或性能收益。

## 10. 决策与剩余工作

已实现的范围为：回收空的保温 channel，保护所有 live session，只尝试一个候选并重试一次准入，不增加公开 API 或调参项，用户选择留在 PR3。Tracker 当前包含更宽的空闲 session 选项；提交实现时应同步交付范围，而不是悄悄把更宽的选项标记为完成。

实现时必须核验提取出的活动 helper 在各个受管理构建路径都有完整数据源，以及所有实质 workspace-control 入口都更新时间。测试必须通过构建产物证明先释放再启动和恢复正确。本文没有给出已测量的性能收益、RAM 安全保证或跨平台验证结论。
