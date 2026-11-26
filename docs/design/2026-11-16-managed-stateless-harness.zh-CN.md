# 无状态 Hosted Harness：空闲 Session 挂起及后续演进

[English](2026-11-16-managed-stateless-harness.md) | [简体中文](2026-11-16-managed-stateless-harness.zh-CN.md)

状态：第一阶段（空闲 Session 挂起）正在 [#17690](https://github.com/QwenLM/qwen-code/pull/17690) 中实现；下文的恢复前置条件、故障测试和测量通过之前，不能启用。第二到第四阶段只定义边界和接口，各自实现前另写设计。两份补篇承载本文只设门槛的第一阶段细节：[恢复视图](2026-11-18-managed-suspension-recovery-view.zh-CN.md)，以及回答待解决问题 8 的[有界恢复](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)。

本文写成之后，Java 前置工作已部分落地：[#17521](https://github.com/QwenLM/qwen-code/pull/17521)（仅准入操作的 404 恢复、按引用身份的 attachment/marker 原子更新、池重新选择）、[#17680](https://github.com/QwenLM/qwen-code/pull/17680)（无 epoch 重提分支中驱动 continuation-ready 停靠）、[#17681](https://github.com/QwenLM/qwen-code/pull/17681)（SDK 心跳失效通知、`hosted_session_open_busy` / `hosted_session_teardown_blocked` 分类，以及等待老化上限，现名 `WAIT_CHURN_BUDGET_FACTOR`）。剩余项列在"控制面改动"一节。现状声明已对照 `main` 上 `326818aa28` 的代码核对，本次更新的段落另对照 `78f8bfb1dc` 复核。

## 与空闲 parking 提案的关系

[空闲 parking 提案](2026-11-08-hosted-idle-parking.zh-CN.md)已通过 [#16564](https://github.com/QwenLM/qwen-code/pull/16564) 作为文档合入，其中已经定义了由 Harness 触发的空闲释放。它仍然是提案，其中的测量是历史结果，不代表某个实现已通过验收。本文以那份文档的空闲计时、按引用保护的 Java 恢复、每 Session 并发控制和结果未知处理为基线，再扩展到长期的无状态目标。两份文档的阶段编号对应不同的计划。

| 决策                 | 本提案的选择                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空闲计时与并发       | 采用早先提案对活动计时的排除项、teardown 前的有界等待，以及覆盖 load 和内部工作的闸门。                                                                                                                                   |
| Java 恢复            | 采用其条目与标记的原子更新、仅准入操作的 404 恢复、Turn 恢复、池重新选择和心跳失效通知。在任何自主挂起之前落地。                                                                                                          |
| Store 协议           | 先使用现有 seal 协议，保留 placement，不改 schema。这要求失败或结果未知的 teardown 保持闸门关闭；超时不能成为立即重新打开的依据。如果现有协议无法证明有界自动恢复，早先提案的原子 park 事务、回执和租约计数仍是备选方案。 |
| MCP、Hook 和延时工作 | 保留更广的目标，但只挂起已证明 teardown 可行的配置。有任何待处理输入（包括 `notBefore` 在未来的输入）的 Session 保持常驻，直到第三阶段把 wake 调度移到控制面。其他不支持的情况也保持常驻。                                |
| 默认值与成本         | 保留协调升级、不设配置开关的选择。10 分钟和最多 8 个并发冷打开都是候选值，启用挂起前必须测量。限制并发不会降低每次恢复的成本。                                                                                            |

无状态目标和第二到第四阶段保持不变。复用早先的正确性规则，不要求照搬其整个 Store 事务，也不代表其五个待决问题已经被接受。

## 问题

Hosted Harness attach 了一个 Managed Session 之后，这个 Session 会一直常驻在该 Harness 进程里，直到被 close 或 delete。控制面从不 detach 普通 Session，所以一个用户一小时前就不再交互的 Session，和正在跑 Turn 的 Session 待遇完全一样。

常驻期间，每个 Session 都在持续产生开销：

- **写租约和 activation 续约。** Harness 通过私有 Session Store 为每个 Session 续写租约和 activation，大约每 `leaseDurationMs / 3`（默认 60 秒租约时为 20 秒）发一次 `/writers:renew`。早先提案记录的历史 rig 数据是每个空闲 Session 每分钟 51–56 条 SQL。当前语句数必须重新测量；开销随常驻 Session 数增长，而不是随活跃 Turn 数增长。
- **Harness 内存和每个 Session 的 owner 状态。** 每个常驻 Session 都持有恢复出来的 journal 状态、模型上下文、MCP 和 Hook 的 owner 状态（配置记录、目录、grant）、wake 调度器和定时器。Harness 把 `attachedSessions` 作为负载指标上报，空闲 Session 占用的是本可以给活跃 Session 的容量。
- **Runtime 侧的连接。** Session 的 MCP 连接和 Hook owner 位于它的 Tool Runtime 中，只要 Harness 还 attach 着这个 Session，它们就一直开着。

Managed Agent 尚未发布首个正式版本，其 schema 策略也体现了这一点。本提案假设部署中有数千个已 attach 的 Session，其中大部分处于空闲状态；这是目标，不是实测负载。保留 Harness 与控制面协调升级、不设受支持的配置项和能力协商的选择。这些选择不能替代下文的恢复和测量门槛。

## 现状

### Harness 为每个 Session 持有的状态

| 状态                                                                               | 持久来源                                                                 | 由什么释放                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 对话历史、上下文、领域记录、MCP 和 Hook 配置记录                                   | 私有 Session Store 中的 Session journal（从 native snapshot 加尾部恢复） | 无需释放，冷打开时恢复                                              |
| MCP 和 Hook owner 身份                                                             | 每次 load 都由持久化的配置 ID 确定性地推导                               | 每次 load 重新计算                                                  |
| Tool Runtime 中的 MCP 连接和 Hook owner                                            | 配置记录写明原 `runtimeSessionId`                                        | 非终态 close 会对每条配置做 drain，并通过 Broker 派发 `mcp-release` |
| wake 调度器（`HostedMonitorWakeScheduler`），包括最早一个未来 `notBefore` 的定时器 | 输入已提交到 journal；控制面的 `WakeRecovery` 也跟踪延时的 `notBefore`   | 只在进程内存中                                                      |
| 等待工具审批的 Turn                                                                | Harness checkpoint 有 `await_action` 阶段                                | `HostedApprovalWaiters` 把 Turn 挂在进程内存中                      |
| 后台 Shell 和 Monitor 的观察循环                                                   | 它们的记录已提交；循环本身运行在 Harness 中                              | 只有 Session close 会停掉它们                                       |
| 写租约和 activation                                                                | `ma_session_head` 以及 journal 中的 activation 记录                      | `managed.close()` 释放 activation 并 seal 写者                      |

### detach 是结束 Session，不是挂起 Session

现有的 detach / delete 处理逻辑（`packages/cli/src/serve/hosted-harness-session.ts` 中的 `close`）是按"结束一次 attach"来写的：

- 停掉所有存活的后台 Shell 和 Monitor 观察循环，并结算为 `stop_requested`；Session 被阻塞、held drain 失败或无法证明时结算为 `runtime_lost`；
- 在日志关闭前，不经模型，把所有待处理的 monitor、channel、automation、子任务、session message 和 loop 输入都结算为 **cancelled**；
- 释放 Runtime 租约，drain 被持有的 Runtime 工作，并重试 hosted cleanup debt；
- 关闭 Hook 和 MCP（detach 时为非终态关闭：drain Runtime 连接，但保留 owner 可重新获取）；
- 释放 activation 并 seal 写者。

把它用在空闲 Session 上，会取消用户期望执行的排队输入和延时输入。因此第一阶段新增一条独立的挂起路径；第一阶段中的"close 路径审查"一节逐项列出了这个处理逻辑的所有副作用，以及挂起如何对待每一项。

### 已经能容忍"Harness 放手一个 Session"的部分

- **从无人持有的写者恢复。** `WakeRecovery` 每两秒扫描一次，每轮最多处理 8 个候选，并调用 `recoverForWake` 做被动 load。它识别已 seal 的写者和已过期的活跃租约；崩溃可能留下后者。其 SQL 筛选仅覆盖符合条件、journal 未压缩的活跃 public Session。延时输入处理专门保留未来的 loop 输入及其 wake 提示。它不保证及时：一次 claim 把该 Session 的下一次尝试推迟 30 秒，每次尝试最多证明 32 个 journal transaction；缓存的证明如果跳过了未来的 loop 输入，该输入到期后要从第一个 transaction 重新证明。因此在有 201 个 transaction 的 journal 上，wake 至少比输入到期晚三分钟。它是崩溃兜底，不是适用于所有 Session 或所有 `notBefore` 的通用持久调度器。
- **重新 attach 失效的引用。** #17521 已落地仅准入操作的 404 重试、按引用身份的 attachment/marker 原子规则与池重新选择；#17680 补上了无 epoch 重提分支的 continuation 驱动。普通 load 仍可能被常驻 Session 拒绝，因此"重新打开"一节的规则仍是契约。
- **closing 是暂时性的。** `hosted_session_closing` 被归为暂时性错误（`HarnessConflictCodes`）；公开路由把它表现为可重试的 503，session message、child result 和 lifecycle 路径也已经把它当作可重试处理。
- **placement 接管。** store 只在两条路径上允许接管：placement 已 `RELEASED` 且存在释放回执、head 已 seal；或者写者租约已过期且 activation 已知并已释放、吊销或过期。单纯 seal 不会缩短 `writer_lease_until`，所以第一阶段挂起（保留 placement、不写回执）之后，Session 只有在租约自然过期后才可被接管，最长为 60 秒默认值。在此之前请求以 `harness_owner_still_live` 被拒，而池 ownership 等待码已把它归为等待。
- **drain 释放。** `packages/cli/src/serve/hosted-harness-session.ts` 中的 `releaseIdleOwner` 已经能在不取消输入的前提下释放 Session，但只用于正在 drain 的池实例：实例仍在接收工作时它直接返回。只要任一忙碌检查成立（其中一部分是实例级的），或者某个待处理输入不是 wake 输入、或已被 wake 尝试过，它就拒绝释放。之后它停止续约、释放 activation，并通过 Store 回执释放 placement（`quiesceOwnership`、`prepareOwnershipRelease`、`releaseOwnership`）；释放失败时 Session 保持 attach，并用同一个 operation id 和 commit proof 重试。最后关闭 wake 调度器、事件流、本地 Store client 和 client-files 注册，并移除 Session。它不关闭 Hook 或 MCP owner，也不释放 Runtime 租约。

## 目标与非目标

目标：

- 释放符合条件的空闲 Session 的 Session 级资源，不取消输入，也不丢失历史。
- 下一次请求、wake 输入或 lifecycle 操作到来时，重新打开已干净挂起的 Session。挂起失败应表现为需要恢复的工作，不能静默重新打开结果未知的写者。
- 不新增受支持的配置项，也不做能力协商；Harness 和控制面一起发布、一起升级。唯一的覆盖手段是下文所述仅供测试使用的空闲时长。
- 定义目标架构（一个在请求之间不持有任何 Session 的 Harness），以及通往它的各个步骤的边界。

第一阶段的非目标：

- 重新设计 journal 恢复。第一阶段在启用挂起前测量当前成本；成本门槛不通过时，先做针对性的 load 改进。第二阶段消除 MCP/Hook 重连部分，不会消除所有随历史增长的恢复成本。
- 把 wake 调度器、审批等待或观察循环移出 Harness。第一阶段中需要这些的 Session 保持常驻。
- 在没有证据表明现有协议无法满足故障验收门槛时，照搬早先提案的 Store park 事务或修改写租约协议。
- 释放被挂起 Session 的 placement。

## 目标架构

最终状态是：Harness 只在有工作时才持有一个 Session，工作包括一次请求、一个正在运行的 Turn，或一项进行中的 Runtime 义务。请求之间它什么都不持有，因此任何池成员都可以打开这个 Session，粘性 placement 从"必须满足的约束"变成"缓存亲和"。

journal 和 Session Store 仍是唯一的权威。正在运行的 Turn 仍然只能有一个 owner，因为两个 Harness 同时推进一个 Session 会导致状态分叉、副作用重复。因此写租约仍然保留，只是持有时间从"一次 attach 期间"缩短为"一次请求期间"。

这就是 Claude Managed Agents 的形态：session 是位于 harness 之外的 append-only 日志，harness 无状态，任意 harness 都能通过 `wake(sessionId)` 接手一个 session，工具在每个 session 各自的沙箱中运行（[Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)）。在我们这里更难的原因是：我们的 Harness 负责每个 Session 的 MCP 和 Hook 生命周期，放手一个 Session 前必须先 drain。第二阶段把这部分归属移到 Runtime。

| 阶段 | 变更                                       | 效果                                                |
| ---- | ------------------------------------------ | --------------------------------------------------- |
| 1    | 空闲 Session 挂起                          | 空闲 Session 停止续约，释放 Harness 和 Runtime 资源 |
| 2    | 由 Runtime 管理 MCP 和 Hook 连接的生命周期 | 挂起和重新打开不再需要 drain、重连和重新发现        |
| 3    | wake 调度和后台观察移到控制面              | 有延时输入或后台工作的 Session 也能挂起             |
| 4    | 审批停靠                                   | 等待审批的 Turn 不再把 Session 钉在 Harness 上      |

完成第四阶段后，空闲时长可以逐步缩短到零，也就是无状态的最终形态。

## 第一阶段：空闲 Session 挂起

### 概述

每个常驻 Session 有一个按实际活动计时的空闲定时器。到点后，Harness 检查资格、升起闸门、等待在飞工作，然后再次检查。随后停止本地调度、drain 符合条件的 owner、释放 Runtime 所有权并关闭写者，全程不取消输入。只有清理得到确认后，才允许正常重新打开。teardown 一旦开始，失败也不能把部分关闭的对象重新投入普通服务。

### 空闲时长

- 候选空闲时长是 Harness 中的一个常量，初始值为 10 分钟。它没有受支持的配置项或请求字段，Harness 也不为挂起声明任何能力。
- 单元测试通过构造参数设置更短的时长。真实进程测试单独启动的 Harness，从仅供测试使用的变量 `QWEN_E2E_IDLE_SUSPEND_MS` 读取更短的时长，做法与 `QWEN_E2E_DROP_LOAD_REPLY` 等现有 E2E 故障注入变量相同。Harness 只接受小于该常量的值，因此这个变量无法关闭挂起；部署环境从不设置它。
- Harness 给每个定时器加最多 10% 的随机抖动，避免同时进入空闲的 Session 同时被挂起。
- 启用挂起之前，依据测量选定发布常量；10 分钟不会因为写在这里就成为已接受的默认值。

### 空闲判定

定时器到点时，只有以下条件全部满足，Harness 才挂起该 Session；否则重新计时一个完整周期。

- 没有活跃的 Turn，也没有等待 continue 或 cancel 驱动的已恢复 Turn。
- 没有打开的 Harness 事件流——该 Session 的流集合为空。这既覆盖 Turn 自己的流，也覆盖任何只读观察者，teardown 会把它们都切断。
- 没有待处理的输入，包括 `notBefore` 在未来的 loop 输入。常驻的 wake 调度器会在这类输入到期时投递；SQL wake 恢复在长 journal 上会投递得很晚（见“现状”）。第三阶段把 wake 调度移到控制面后，这类 Session 才能挂起。
- 没有待处理或恢复中的 MCP / Hook 操作，没有正在安装或刷新的 MCP 配置，没有进行中的 session message 操作，没有正在进行的上下文压缩。
- 没有存活的后台 Shell 或 Monitor 观察循环。
- 没有已安排或正在运行的 channel reply-plan 重试，没有欠下的 Turn 后投递或对账，也没有结果未定的 journal append 或 activation 续约。
- 没有被 Turn 遗留持有的 Runtime，没有未结算的 Runtime 工作，hosted cleanup debt 为零。
- 没有活跃的 client-files 注册。浏览器的绑定由控制面保存，控制面只在 close 或 delete 这个 Session 时才关闭它；如果 Harness 自行丢掉注册，浏览器会一直显示桥接已连接，而模型实际上已经没有这些工具了。关闭标签页会立即结束绑定，因为它的下行连接随之关闭；之后 Session 就可以挂起。
- 没有进行中的 lifecycle 授权、ownership release 或池成员排空。
- Session 未处于 recovery-blocked 状态。被阻塞的 Session 保持常驻，运维恢复流程保持不变。
- Session 不是配置了 MCP 的公开 Workspace Shell 档位（`hosted-workspace-shell/1`、`hosted-workspace-shell/3` 或 `hosted-workspace-shell/4`）。这类 Session 的普通 detach 需要 lifecycle 授权，会以 `hosted_lifecycle_required` 拒绝，所以第一阶段永远不会挂起它。

升起闸门前先检查长期阻塞条件。在同一个同步段中重新检查资格并标记 Session，与池 drain 和 lifecycle 所有权协调。被阻塞条件排除的 Session 因此继续正常服务，不会周期性地返回 closing 拒绝。

判定条件以 `releaseIdleOwner` 的忙碌检查为起点，但按 Session 而不是按实例判断，并且对输入更严格：drain 路径可以留下尚未尝试的 wake 输入，因为后继 owner 会加载它们；第一阶段只在没有任何待处理输入时挂起。挂起不直接调用 `releaseIdleOwner`，因为它只在正在 drain 的实例上运行，并且会释放 placement，而第一阶段保留 placement。

### 定时器

- 取最近一次已准入变更、非续约 journal 提交、Turn 结算、load 完成，以及可回退挂起尝试被放弃的时间中的最大值。长时间运行的 Turn 和由读取触发的 load，都在完成后获得一个完整常驻周期。
- 心跳、只读轮询、activation 续约和被拒绝的请求不重置计时。内部工作产生上述活动事件时才计入，单纯安排任务不计入。
- 预检查失败或有界等待失败后，重新计时一个完整周期。teardown 失败进入下文的恢复状态，不再走普通空闲重试。
- close、delete、挂起或交接给 lifecycle 时清除空闲定时器。teardown 成功后停止所有 Session 级定时器和 publisher，包括 channel reply-plan 重试。

### 准入闸门与在飞工作

single-address 和 pool 两种模式都按完整 Session 范围建立闸门；清理结果未知时，即使移除了 resident 对象，闸门仍然保留。它覆盖所有普通 Session 路由，以及所有 `open()` 路径中获取写者或复用 resident 之前的位置：create、普通 load、被动 load、驱动式恢复和 MCP-management load。load 路由注册在现有 Session 中间件之前，所以仅靠中间件无法保证这一点。私有 teardown 对账仍可在捕获的写者身份下完成；普通 lifecycle load 不能绕过闸门。

闸门仍可回退或 teardown 仍在收敛时，被闸门拦下的调用返回可重试的 `409 hosted_session_closing`。teardown 达到重试上限、等待运维恢复后，闸门改为返回 `409 hosted_session_teardown_blocked`。这个错误码不是暂时性的：调用方不再等待，lifecycle close/delete 在其 authority 下对账或接管。对已准入的异步工作计数，直到工作自身的 `finally`，包括 HTTP 调用方已经断连的工作。响应结束和实例级请求计数都不能证明某个 Session 的工作已经结算。wake pump、reply planning 和其他内部变更源遵守同一个闸门。有界等待之后再次检查判定条件。只有 teardown 尚未开始，超时或检查失败才允许清除闸门。停止续约时，必须在 authority 串行队列之外等待在飞续约，避免在队列内部等待该队列自身。

### 挂起流程

1. 按上述规则升起闸门、等待已准入工作并重新检查资格。此处失败时对象仍完好，可以清除闸门并重新计时。
2. 关闭 wake 调度器但不结算输入，从这里开始不可回退的 teardown。从第一次 teardown 调用起，即使调用抛错，也不能把对象重新投入普通服务。
3. 非终态关闭 Hook 和 MCP owner，调用与 detach 相同。这会 drain Runtime 连接，并保留 owner 供下一次 load 重新获取。
4. 用现有的辅助逻辑非终态地释放 Runtime 租约，它会先结清已结算 Turn 欠下的文件历史标记。对账 hosted cleanup debt。仍有剩余或结果未知时，Session 保持闸门关闭，不能算挂起成功。
5. 关闭 Shell 和 background lane 的 publisher。此时没有存活的观察循环，没有任何东西在等它们结算，下一次 load 会重新创建它们。
6. 停止续约并等待在飞工作，释放 activation，然后 seal 写者。`managed.close()` 提供的是现有关闭行为，不是可回退事务；挂起需要一个本地辅助逻辑，暴露各步骤的结果，并保留对同一次 seal 进行对账的能力。
7. 资源清理、activation 释放和 seal 都得到确认后，永久停止旧 client 及所有剩余回调，移除 resident 并清除闸门。下一次请求才可以冷打开它。

### teardown 失败或结果未知

可回退的边界是第一次 teardown 调用，而不是 seal。`managed.close()` 永久停止 activation 续约，即使 activation 释放失败也会尝试 seal。seal 成功但 activation 释放未确认时，仍然是需要恢复的工作，不是干净挂起。清除一个标记，不能恢复部分关闭的 Hook/MCP owner、publisher 和调度器。

越过该边界后，普通工作和 load 都保持闸门关闭。对账原操作，保留其 writer id、generation、token 和资源 owner 身份。只重试现有协议允许精确重试的操作，采用退避、抖动和明确的次数或时间上限。达到上限后停止自动尝试，返回 `hosted_session_teardown_blocked`，并将阻塞的清理暴露给运维恢复；保留闸门及完成清理所需的证据。不取消待处理输入，不丢弃持久清理义务。停止普通续约和业务回调，但原 client 仍需对账 seal 时不能调用 `stopLocal()`，因为它也会禁止这些请求。

seal 超时不能证明操作没有发生。租约仍有效时，使用相同 Harness boot id 和 token 的新 client 可能获取到相同 writer generation；迟到的旧 seal 随后仍能封掉新 attachment。按本地时钟等待一个租约周期也不能作为证明，因为 seal 校验写者身份和 generation，但不要求租约尚未过期。正常重新打开必须满足以下之一：旧 teardown 已确认完成；或者 Store 证明确有后继 generation 能 fence 住所有旧操作，并接管剩余恢复义务。独立修改 writer id、使其不同于 Harness boot id，也不能作为绕过方式。实现必须证明这个转移；如果现有协议无法提供所需的自动恢复，启用挂起前应重新讨论早先提案的 fencing 机制。

新的 Harness 进程使用已有崩溃恢复路径及新的 boot 身份，仍然必须遵守 writer fencing 和清理义务；重启不代表干净挂起。与失败挂起竞争的 lifecycle close/delete，必须在已有 authority 下对账或接管，不能经由未设闸门的普通 load 进入。

挂起跳过 detach 一开始会请求的普通执行授权：挂起不启动任何工作，而 seal 本身就受写者 fencing 保护。下面的审查列出了与 detach 的其余所有差异，每一项都用测试固定。

### close 路径审查

下表逐项列出 detach 和 delete 处理逻辑（`packages/cli/src/serve/hosted-harness-session.ts` 中的 `close`）的所有副作用，以及挂起如何对待每一项。处于 lifecycle protocol 2 操作中的 Session，其资源阶段由控制面驱动完成，之后这个处理逻辑只做 seal；挂起永远不会在 lifecycle 授权下进行，所以适用下面的完整路径。

| 副作用                                                                                                                  | Detach（`POST`）                                                      | Delete                       | 挂起                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| 授权                                                                                                                    | 普通的 `/execution:authorize`                                         | 无                           | 跳过                                                       |
| 等待进行中的 session message 操作                                                                                       | 是                                                                    | 是                           | 不需要：判定条件要求没有                                   |
| `SessionEnd` 和 `SessionDelete` Hook                                                                                    | 否                                                                    | 是                           | 永不                                                       |
| drain 被 Turn 遗留持有的 Runtime                                                                                        | 是，但 reload-stable owner 除外，它们继续运行，释放义务保留（#16579） | 是，全部                     | 不需要：判定条件要求没有                                   |
| 关闭 Hook owner                                                                                                         | 非终态                                                                | 终态，并释放遗留的配置 owner | 非终态，与 detach 相同                                     |
| 关闭 wake 调度器                                                                                                        | 是                                                                    | 是                           | 是，且不结算输入                                           |
| 结清已结算 Turn 欠下的文件历史标记，然后释放 Runtime 租约                                                               | 是，非终态                                                            | 是，终态                     | 是，非终态                                                 |
| 停止观察循环，结算为 `stop_requested` 或 `runtime_lost`                                                                 | 是                                                                    | 是                           | 不需要：判定条件要求没有存活的循环                         |
| 重试 hosted cleanup debt                                                                                                | 是                                                                    | 是                           | 是；仍有剩余或结果未知时，teardown 保持闸门关闭            |
| 关闭 Shell 和 background lane 的 publisher                                                                              | 是                                                                    | 是                           | 是                                                         |
| 关闭 MCP owner                                                                                                          | 非终态                                                                | 终态                         | 非终态，与 detach 相同                                     |
| 关闭 client-files 注册                                                                                                  | 是                                                                    | 是                           | 不需要：判定条件要求没有                                   |
| 把待处理的 monitor、channel、automation、子任务、session message 和 loop 输入结算为 cancelled，然后对账 automation 运行 | 是                                                                    | 是                           | 永不：判定要求没有待处理输入，之后的输入会重新打开 Session |
| 释放 activation 并 seal 写者                                                                                            | 是                                                                    | 是                           | 是                                                         |
| 停止事件流并移除 Session                                                                                                | seal 之后                                                             | seal 之后                    | teardown 确认完成后；清理结果未知时保留闸门                |

控制面 close 或 delete 一个 Session 时，生命周期协调器还会关闭浏览器的 client-files 绑定（`closeForSession`）；而 Harness 自行丢掉注册时，没有任何一方会关闭它，这就是活跃注册会阻止挂起的原因。

定时器审查包括 idle 和 wake 定时器、activation 和 writer 续约、channel reply-plan 重试以及事件流回调。回调不能在被闸门拦住或已经移除的对象上重新启动工作。实现还需逐项检查其余 owner 和 publisher 清理路径，不能假定 close handler 已经穷尽所有定时器。

### 重新打开

- **准入操作。** prompt、审批/问题回答、channel、automation、message 和 child 准入操作，在所用引用返回精确的 `404 hosted_session_not_found` 后重试一次。边界是准入操作，不是整个操作族：取消和 committed-stop 操作保留已有恢复语义。符合条件的非 Turn 准入使用被动重新 attach；Turn 路径重新进入 `recoverManagedRuntime` 和协调器的恢复处理，包括 `pendingRecovery`、`bindRecoveredHarness` 与事件水位。叶子 connector 不能丢弃返回的恢复快照后直接重发 prompt。保留租户、Workspace 和各操作自己的授权；给所有新工作 load 设置 passive 不能替代这些检查。
- **引用和标记的归属。** 发布、移除和标记更新，在每个 attachment key 上用一个原子步骤完成，并核对被修改的引用。该规则适用于每条 connector 路径，不只是新增的 404 handler。不要在 map 的 `compute` 中执行网络 I/O。旧引用迟到的 404 或心跳通知，不能影响新引用及其标记。`mcpManagementAttachments` 同样按引用身份处理；不能退回另一张缓存表中已知过期的条目。
- **其他操作与心跳失效。** cancel、rename、Harness stream、上下文压缩读取、MCP/client-files 管理、extension 和 runtime-skill 读取，不纳入统一的 404 重试。SDK 在心跳移除引用时通知 connector，由 connector 使用同一原子规则处理。心跳正常周期运行时，过期失败的持续时间受该通知约束；禁用心跳则没有这个上界。保留带错误码的拒绝，不把驱逐后的不可加载 resolver 转成一个本地异常。lifecycle settlement 保留“缺失不能证明完成”的规则。
- **wake 输入。** 挂起的 Session 没有待处理输入，因此 wake 通常针对挂起之后才准入的输入。但并非必然：transport activator 只校验通知的 sequence 已提交且没有活跃写者，所以在 resident 已消费该输入并挂起之后才送达的通知，仍会把 Session 加载一次。这类重载要测量，不能假定不存在。wake fence 证明没有活跃写者时，`activateForWake` 只移除它当次观察到的那个引用及其标记，再执行恢复 load；并发发布的更新 attachment 会保留，该动词随即报告已 attach。MCP 管理缓存持有自己的引用，按同一按 key 身份规则移除。transport 通知丢失时，SQL wake 恢复只在其支持的 Session 范围内兜底，延迟见"现状"。不能根据内存中的空闲判定直接清除 wake 提示。
- **lifecycle 与状态。** close/delete 使用已有 authority 和恢复路径，等待挂起闸门时不消耗 lifecycle 重试预算。恢复/状态响应不能因为缓存条目缺失就报告成功，也不能把缺失直接当成需要运维处理的失败：应确定持久 writer/activation 状态并遵守[恢复视图补篇](2026-11-18-managed-suspension-recovery-view.zh-CN.md)。仅"已 seal"不构成该证明——被拒绝的 load 也会同样关掉写者——而且该视图会投影到每一次普通 Session 读取上，不只是运维接口。
- **池选择与错误。** 即使第一阶段成功挂起后保留 placement，重试也必须重新经过允许获取归属的 `HarnessPoolConnector.select`，取得新的 `PoolCall`。保留 `hosted_session_closing`、`hosted_session_open_busy` 和 placement 等待的暂时性语义（受"冷打开准入控制"一节的等待上限约束），不用原始 404 覆盖它们。`hosted_session_teardown_blocked` 是拒绝，不是等待。generation 变化、结果未知和终态恢复失败保留各自的分类。
- **409 不只有一种含义。** `create()`、`channelAttachment()`、`automationAttachment()` 只有在错误码表明 Session 已在那里（`hosted_session_already_attached`、`managed_session_already_exists`）时才可回退到被动 load。其余每个 409 都保留自己的错误码并上抛给调用方：在 closing 闸门、冷打开名额已满或 teardown 楔住之后再 load 一次，等于为一个等待多花一次准入；而在 `hosted_session_open_busy` 之后 load，加载的是被拒 create 从未写过的 journal。

### 冷打开准入控制

挂起会把一部分稳态工作变成冷打开的突发。例如一个 automation 计划同时为大量已挂起的 Session 触发，或者某个池成员重启。每次冷打开都要恢复 journal 并重新安装 MCP 配置，其连接和 discovery 各自最多等待 25 秒。

- Harness 限制单个实例的并发冷打开数，候选常量为 8。超出限制的打开请求以新错误码 `409 hosted_session_open_busy` 拒绝。
- 这个限制作用于所有冷打开，包括首次 create（即使没有 journal 要恢复，它也会安装 MCP 与 Hook owner），以及 Harness 重启后的批量重新加载，同时也会把这类批量加载拉平。被名额拒绝的 create 不发布任何资源，也不留下 unresolved-opening 债务。
- 控制面已在 `HarnessConflictCodes` 中把 `hosted_session_open_busy` 归为暂时性错误；在 `HarnessCoordinator` 中把它归为推迟 Turn 但不消耗其准入预算的错误码，与现有的池 ownership 等待码同类（#17681）。没有它，一阵集中的拒绝就会耗尽排队 Turn 的准入预算，导致它们失败。
- 免于扣减预算的等待仍需要上限，而这个上限对不同调用方含义不同。#17681 把该上限重命名为 `WAIT_CHURN_BUDGET_FACTOR`，并同时作用于 generation 等待与池等待：超过之后 **Turn** 以其所处阶段的 unavailable 错误码失败。**lifecycle** 操作则改为以拒绝自身的错误码发布 `recovery_blocked` 并继续被重驱，因为放弃会把它欠下的资源搁死。**relay 是剩余缺口**。#17681 豁免了 command-execute 与 child-stop 两个分支，#18149 的阶段 3 豁免了普通 session message 投递的每个步骤，其 closing 等待由 Harness 升级为 `hosted_session_teardown_blocked` 来设上限；child result 投递与 automation fire 仍把这些等待计入自己的尝试预算。由于 transport wake 与 SQL wake 恢复都只覆盖 public Session，被挂起的子 Session 完全依赖这些 relay，一次冷打开突发就可能把它的消息结算成 cancelled 或 unknown。补齐这个缺口是第一阶段前置条件，不是后续项。
- 控制面现有的限制保持不变：transport wake 的加载线程池，以及 `WakeRecovery` 每轮 8 个候选。
- Session Store 由所有池成员共享，单实例限制管不住 store 负载，也不会减少恢复总工作量。启用挂起之前，测量空闲 SQL、随历史大小变化的冷打开 SQL/延迟/CPU、MCP 重连成本、回收的内存，以及读取或迟到 wake 通知引起的重载频率。在多个池成员下比较常驻与挂起负载，记录负载模型和接受的延迟/store 预算；候选默认值不满足预算时，调整常量或降低加载成本。早先的每分钟 51–56 条 SQL 和 200-Turn 加载测量，是需要复现的基线，不是当前保证。

### 控制面改动

以下改动都要先于 Harness 改动合入，或与它在同一个版本中发布（见"上线方式"）。已落地项已标注，其余仍是欠项。

1. **已落地（#17521、#17680）。** 上述准入/恢复契约：仅准入操作的 404 恢复、会检查请求参数的 Harness mock、恢复快照与水位处理（含无 epoch 重提分支）。缓存引用失效和 Session 完全不在内存中，是两种不同情况。真实双控制面接管测试仍是欠项。
2. **已落地（#17521、#17681）。** 所有 attachment/marker 更新纳入按 key 的归属规则，以及 SDK 心跳失效通知。
3. **部分落地（#17681）。** 重试时重新选择池 placement；coordinator 与 lifecycle 处理中保留 closing、open-busy 和 ownership 等待，按"冷打开准入控制"一节设置等待上限，且不在 `hosted_session_teardown_blocked` 上等待。普通 session message 投递自 #18149 阶段 3 起已获得豁免。**仍欠：** 对该节指出的 child result 投递与 automation fire 给予同样的豁免与上限。
4. **部分落地（#17690）。** wake 缓存失效处理已改为在两张缓存中各只移除当次观察到的引用。**仍欠：** 证明延时输入资格与持久提示，以及在真实 MySQL 上验证[恢复视图补篇](2026-11-18-managed-suspension-recovery-view.zh-CN.md)的恢复/状态行为。
5. **已落地（#17690）。** `create()`、`channelAttachment()`、`automationAttachment()` 对非"已在那里"的每个 409 保留其自身错误码，不再重新 load。
6. 只有上述行为及测试落地后，才更新 coordinator 对永久常驻的假设。仅有 mock 重试测试通过，不能证明这些条件成立。

### 交付顺序

先落地 Java/SDK 前置改动，这些改动在没有挂起功能时也有用。随后实现 Harness 计时、准入闸门和 teardown 状态，配套确定性的竞争与故障测试。启用自主挂起前，执行真实进程/MySQL 恢复检查和当前版本成本测量。将这些工作保持为可独立审阅的改动；#17690 承载 Harness 切片与剩余的 connector 修复，测量与真实 MySQL 门禁仍是欠项。第一阶段达到验收标准后，再推进第二到第四阶段。

### 与 Harness 池的交互

被挂起的 Session 保留 placement。如果它所在的池成员离开了池，下一个请求会接管 placement——但要等写者租约过期之后，因为第一阶段不写释放回执，而 seal 不会缩短租约（见"现状"）。在此之前接管会遇到 `harness_owner_still_live` 并等待。一个之后再也没被访问的已挂起 Session，会让已离开成员的 `hasUnreleasedOwnership` 一直为真，池因此会一直保留该成员的连接器条目。这和现在成员崩溃后留下的状态相同；回收这类 placement 的机制列为待解决问题。

### 可观测性

- Harness：干净挂起次数、可回退放弃次数、闸门保持关闭的失败/结果未知 teardown 及其持续时间和原因、判定未通过次数、冷打开耗时（拆分为 store 恢复和 MCP 重新安装）、`hosted_session_open_busy` 拒绝次数。失败 teardown 不计为干净挂起。这些计数从进程启动起累计，在实例的 `/internal/hosted-harness/v1/metrics` 接口中以 `suspension` 字段返回。
- 控制面：准入重新 attach、心跳失效、保留下来的恢复快照、池重新选择、清掉过期 attachment 的 wake 激活次数，以及达到上限的等待次数。

### 故障模式

- **挂起过程中 Harness 崩溃。** 已有崩溃恢复会 fence 旧写者并对账持久义务。仅有 writer 已 seal，不能证明资源清理和 activation 释放均已完成。
- **挂起过程中 Session Store 不可用。** teardown 前可以放弃尝试；teardown 开始后保持闸门关闭并对账。失败或超时的请求不能证明 Store 没有提交。
- **迟到的 wake 通知。** 发给已挂起 Session 的通知会遇到 `hosted_session_not_found` 或缓存缺失，随即重新加载 Session。
- **并发请求或内部工作。** 闸门前准入的工作被跟踪到完成，并再次检查；后续工作，包括 load 和定时器回调，都不能进入。只有有意义的活动才重置空闲计时。
- **失败尝试之后迟到的 seal。** 保留旧写者的闸门，直到完成或证明后继 fencing 已建立。相同 boot id 的新 client 不能充当这一证明。

### 上线方式

挂起没有开关，Harness 会自行挂起 Session。因此它需要一个能做到以下几点的控制面：重新 attach 失效的引用、在 wake 时清掉过期的 attachment、把 `hosted_session_open_busy` 当作等待处理。如果面对的是旧版控制面，指向已挂起 Session 的缓存引用会一直收到 `hosted_session_not_found`，并且永远不会重新 attach。

- 控制面改动先于 Harness 改动合入，或与它在同一个版本中发布。
- Harness 和控制面一起升级。不支持新旧版本混跑的滚动升级，这与其他 Managed Agent 改动设定的边界一致。
- 初始设计不改 schema。如果故障/恢复证明需要 Store fencing 改动，启用挂起前应明确评审该改动，不能为了保留这一偏好而削弱闸门。
- 停止挂起需要按协调部署流程回滚 Harness 改动。干净挂起的 Session 按需重新打开；失败或结果未知的 teardown 仍需受 fencing 保护的恢复。回滚不能重新开放旧的进程内对象，也不能丢弃恢复证据。

## 第二阶段：由 Runtime 管理 MCP 和 Hook 连接的生命周期

只定义边界；实现前另写设计。

- **现状。** Session 的 MCP 连接和 Hook owner 的生命周期等于它的 Harness attach：非终态 close 会对账每条配置、drain 并派发 `mcp-release`，下一次 load 重新安装配置、重连并重新发现。
- **目标。** Tool Runtime 通过 Broker 在多次 Harness attach 之间保留一个 Session 的连接，并按自己的空闲时长回收。Harness 凭持久化的 owner 身份和签发给新写者的 grant 重新获取这些连接。[MCP 设计](2026-09-28-managed-mcp-runtime.zh-CN.md)中已经有：Harness 空闲重载后，先推进配置记录的持久修订、再为新写者签发 grant，同时保持目录和连接 pin 不变。
- **待定义的接口。** Broker 上"挂起 owner"和"释放 owner"的区分；由谁、在什么时候回收连接；Harness 不再负责 drain 之后，结果未知时的名额占用及其配额放在哪里。
- **效果。** 挂起和重新打开不再需要 drain、重连和重新发现，消除了冷打开成本中的这一部分；其占比必须测量，journal 恢复成本仍需单独处理。stdio MCP server 是 Runtime 里的长期进程，这是这部分归属应该放在 Runtime 的主要原因。

## 第三阶段：wake 调度和后台观察移到控制面

只定义边界。

- **现状。** 每个常驻 Session 在 Harness 中运行一个 `HostedMonitorWakeScheduler`，带延时定时器以及 busy 和 blocked 重试；后台 Shell 和 Monitor 的观察循环也运行在 Harness 中。控制面的 `WakeRecovery` 只是无人持有 Session 的兜底。第一阶段让所有有待处理输入的 Session 保持常驻。
- **目标。** 由控制面判断 Session 何时有到期输入，并向任意池成员发送 wake 请求；Harness 执行被请求的输入后再次挂起。后台工作的观察移到 Runtime publisher 和控制面，这样有后台 Shell 或 Monitor 的 Session 也能挂起。
- **已有基础。** `ma_session_head` 中的 wake 字段（`is_wake_pending`、`wake_head_revision`、`wake_retry_at`）、`WakeRecovery` 对延时 `notBefore` 的处理，以及 transport wake activator。

## 第四阶段：审批停靠

只定义边界。实现前设计见[审批停靠](2026-11-21-managed-action-parking.zh-CN.md)；它经 G3 第三步的审批续跑 driver 恢复 Turn，而不是下文所说的 Managed Runtime continue 路径。

- **现状。** 等待工具审批的 Turn 一直在 Harness 中运行，由 `HostedApprovalWaiters` 挂住，尽管 checkpoint 已经记录了 `await_action` 阶段。
- **目标。** Turn 停在 `await_action`，本次请求结束。审批结果通过现有的 Managed Runtime continue 路径在任意池成员上恢复这个 Turn。

## 风险

- **重新打开的延迟与总成本。** 第一阶段每次重新打开都要付出当前恢复与 MCP 重连成本。候选常量必须在发布前通过成本门槛；可能仍需先改进 journal 加载。
- **冷打开突发。** 即使每个 Harness 限制了自己的并发打开数，同步发生的 wake 仍可能压垮共享的 Session Store。
- **与 close 路径的耦合。** 挂起复用了 detach 路径的一部分，以后对 detach 的修改可能悄悄改变挂起的行为。用测试固定"close 路径审查"中的每一行。
- **teardown 失败后的可用性。** 使用现有 seal 协议时，结果未知且达到重试上限后，Session 可能保持闸门关闭并需要运维恢复。实现必须证明安全收敛，或明确修改 Store 协议，才能承诺有界自动恢复。
- **池中的残留。** 已离开成员上的挂起 Session 在被访问之前一直保留 placement。
- **没有紧急开关。** 挂起出现缺陷时，只能通过回滚 Harness 改动来止损。仅供测试的空闲时长变量只接受更短的时长，因此也不是开关。下面的验证计划就是对此的缓解措施。

## 验证计划

第一阶段：

- **Harness 计时与闸门。** 心跳、轮询和续约不能推迟挂起；已准入变更、Turn 结算和 load 完成会重置计时。每个阻塞条件都让 Session 继续正常服务。强制触发 load、池 drain、reply-plan 定时器，以及 HTTP 已断连但工作仍在执行的竞争。所有 load 模式和内部准入都经过闸门，工作被跟踪到完成，可回退等待有上限，不发生续约与串行队列死锁。
- **Harness teardown。** 固定 close 审查中的每一行：不取消输入、不触发 `SessionEnd`/`SessionDelete` Hook、非终态释放资源、不留下回调。让每个 teardown 步骤失败，验证只有 teardown 之前的失败能恢复原对象。测试 seal 已确认但 activation 释放失败、seal 结果未知、重试达到上限，以及 `stopLocal()` 的调用顺序。迟到的旧 seal 绝不能影响重新打开的 attachment。
- **控制面恢复。** 强制触发旧 404 与新引用、迟到心跳与新引用的交错，断言新的恢复快照保留。mock load 要像真实 Harness 一样拒绝对常驻 Session 的普通 load。覆盖 coordinator 的恢复 Turn 和水位处理、placement 改变后的池重新选择、两张 attachment 缓存，以及准入操作和不重试操作之间的边界。closing/open-busy 等待保留错误码且不消耗重试预算。持续遇到 `hosted_session_open_busy` 或挂起闸门的 Turn，在达到等待上限时以其阶段的 unavailable 错误码失败；`hosted_session_teardown_blocked` 永远不被当作等待。
- **wake 与状态。** 没有活跃写者的 fence 只使本次观察到的过期 attachment 失效。任何待处理输入（包括未来的 loop 输入）都让 Session 保持常驻。挂起之后准入的输入经 transport wake 重新打开 Session；通知丢失时，符合条件的 Session 经 SQL 恢复重新打开。保留 wake 提示，并验证干净挂起、结果未知的 teardown 和真正恢复失败时的恢复/状态响应。
- **真实进程和 MySQL 集成测试。** 两个控制面共享一个 Harness，恢复过期引用。挂起后提交 prompt，历史完整；monitor、channel、automation、message 和 child 输入分别经过 transport 与符合条件的 SQL 恢复执行。测试 lifecycle close/delete、禁用心跳的行为、池成员离开和重试期间 placement 改变。这些用例必须在要求的 CI 层级中运行；跳过 Hosted 或 MySQL 门禁不能算验收。
- **故障测试。** 在每个不可回退边界前后杀掉 Harness；Store 提交后丢失响应；把旧 seal 延迟到新 load 之后；让 lifecycle claim、续约完成与 teardown 竞争。验证证据保留、fencing 和收敛，不重放副作用。
- **测量。** 按历史大小、MCP 配置和池规模比较常驻与挂起负载。记录空闲及恢复 SQL、延迟、CPU、回收内存、不必要的重载，以及 wake 通知丢失后 SQL 恢复按 journal 长度的延迟，并依据明确预算选定发布常量。

## 验收标准

- 从未空闲满一个空闲时长的 Session，行为与现在相同，现有测试结果不变。
- 依赖健康且判定条件满足时，空闲 Session 在一个空闲周期加抖动后开始 teardown；确认完成的 teardown 在实测的清理预算内停止续约，并将其移出 `attachedSessions`。失败 teardown 单独上报。
- 挂起不会把输入结算为 cancelled，也不会停止活跃后台工作。有任何待处理输入（包括 `notBefore` 在未来的输入）的 Session 不挂起；挂起之后准入的输入会重新打开它。
- 符合条件的准入操作遇到引用失效时，在该次调用内最多执行一次恢复重试。健康且干净挂起的 Session 能重新打开；暂时性等待可以跨多个 dispatch，在等待上限之内不耗尽准入预算。其他操作遵循心跳失效契约，不承诺所有请求都在一次调用内成功。
- 旧引用或心跳永远不能擦掉新恢复标记；重试不复用旧 placement；旧 teardown 不能修改后继 writer 或 owner。
- 部分关闭的对象绝不恢复服务。失败或结果未知的操作，要么经已证明的恢复收敛，要么保留义务并以可见的闸门关闭状态等待运维恢复，此时返回 `hosted_session_teardown_blocked` 而不是暂时性等待。
- 规定的真实进程、MySQL 和故障检查在 CI 中通过，当前版本测量证明发布常量合理。文档、mock 测试和被跳过的门禁不能满足此项标准。

## 待解决问题

1. 回收已离开池成员上的挂起 Session 的 placement。
2. 发布的空闲时长和打开数限制（候选值为 10 分钟和 8），以及接受的延迟/store 预算，在启用前依据当前版本测量选定。
3. 运维恢复流程能重新加载 recovery-blocked Session 之后，这类 Session 是否也应该挂起。
4. 重新加载时把活跃的 client-files 绑定重新注册到 Harness，这样打开着浏览器桥接的 Session 也能挂起。
5. 每个池成员能否访问所有 Workspace 挂载；第二到第四阶段假设任意成员都能打开任意 Session。
6. Turn 的 reload-stable Runtime owner 在 detach 时会继续运行、释放义务保留（#16579）；挂起期间能否也让它们继续运行，从而让这类 Session 也能挂起。
7. 挂起配置了 MCP 的公开 Workspace Shell 档位的 Session，这类 Session 目前的普通 detach 需要 lifecycle 授权。
8. **已由[有界恢复补篇](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)回答：** 达到重试上限、结果仍未知的 teardown，只要两条续约都已停止，并经过超过写者租约加 Store 请求超时的等待，即可自动恢复，不改 schema、不改 Store 协议。该候选常量启用前仍需测量，恢复/状态证明仍是第一阶段交付门槛。
9. 冷打开限制是否需要按租户公平分配。等待上限会让饿死的 Turn 失败，但不能阻止一个租户的打开请求挤占另一个租户的名额。
