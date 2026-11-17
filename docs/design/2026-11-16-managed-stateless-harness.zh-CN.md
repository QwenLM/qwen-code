# 无状态 Hosted Harness：空闲 Session 挂起及后续演进

[English](2026-11-16-managed-stateless-harness.md) | [简体中文](2026-11-16-managed-stateless-harness.zh-CN.md)

状态：提案。第一阶段（空闲 Session 挂起）已设计到可实现的程度；第二到第四阶段只定义边界和接口，各自实现前另写设计。第一阶段依赖 [#17521](https://github.com/QwenLM/qwen-code/pull/17521)（Harness 丢弃缓存的 Session 引用后重新 attach），该 PR 尚未合入，等待 CI。

## 问题

Hosted Harness attach 了一个 Managed Session 之后，这个 Session 会一直常驻在该 Harness 进程里，直到被 close 或 delete。控制面从不 detach 普通 Session，所以一个用户一小时前就不再交互的 Session，和正在跑 Turn 的 Session 待遇完全一样。

常驻期间，每个 Session 都在持续产生开销：

- **写租约和 activation 续约。** Harness 通过私有 Session Store 为每个 Session 续写租约和 activation，大约每 `leaseDurationMs / 3`（默认 60 秒租约时为 20 秒）发一次 `/writers:renew`。每次续约是一个数据库事务，粗略计算约 8 到 10 条单行 SQL。开销随常驻 Session 数增长，而不是随活跃 Turn 数增长。
- **Harness 内存和每个 Session 的 owner 状态。** 每个常驻 Session 都持有恢复出来的 journal 状态、模型上下文、MCP 和 Hook 的 owner 状态（配置记录、目录、grant）、wake 调度器和定时器。Harness 把 `attachedSessions` 作为负载指标上报，空闲 Session 占用的是本可以给活跃 Session 的容量。
- **Runtime 侧的连接。** Session 的 MCP 连接和 Hook owner 位于它的 Tool Runtime 中，只要 Harness 还 attach 着这个 Session，它们就一直开着。

项目尚未上线，没有线上数据可参考，也没有需要保护的存量部署。本设计假设部署中有数千个已 attach 的 Session，其中大部分处于空闲状态。挂起功能不设开关：没有配置项，也没有能力协商。

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

- 停掉所有存活的后台 Shell 和 Monitor 观察循环，并结算为 `stop_requested`；
- 在日志关闭前，不经模型，把所有待处理的 monitor、channel、automation、子任务、session message 和 loop 输入都结算为 **cancelled**；
- 释放 Runtime 租约，drain 被持有的 Runtime 工作，并重试 hosted cleanup debt；
- 关闭 Hook 和 MCP（detach 时为非终态关闭：drain Runtime 连接，但保留 owner 可重新获取）；
- 释放 activation 并 seal 写者。

把它用在空闲 Session 上，会取消用户期望执行的排队输入和延时输入。因此第一阶段新增一条独立的挂起路径；第一阶段中的"close 路径审查"一节逐项列出了这个处理逻辑的所有副作用，以及挂起如何对待每一项。

### 已经能容忍"Harness 放手一个 Session"的部分

- **从已 seal 的写者恢复。** `WakeRecovery` 把写者已 seal 或租约已过期的 Session 视为无人持有。它每两秒扫描一次，每轮最多处理 8 个候选 Session，会考虑延时的 `notBefore`，并调用 `recoverForWake` 做被动 load。Harness 崩溃后留下的正是这种状态。
- **重新 attach 失效的引用。** 有了 #17521，Harness 对缓存引用返回 `hosted_session_not_found` 时，普通请求会清掉这条缓存，按缓存为空时的方式重新 attach，并重试一次。
- **closing 是暂时性的。** `hosted_session_closing` 被归为暂时性错误（`HarnessConflictCodes`）；公开路由把它表现为可重试的 503，session message、child result 和 lifecycle 路径也已经把它当作可重试处理。
- **placement 接管。** 写者已 seal 或租约已过期、且 activation 已释放时，placement 可以迁到另一个池成员；写者仍存活时会以 `harness_owner_still_live` 拒绝。

## 目标与非目标

目标：

- Session 空闲达到空闲时长后，释放它的所有 Session 级资源，同时不取消任何输入，也不改变用户能看到的内容。
- 下一次请求、wake 输入或 lifecycle 操作到来时，透明地重新打开被挂起的 Session。
- 不新增配置项，也不做能力协商；Harness 和控制面一起发布、一起升级。
- 定义目标架构（一个在请求之间不持有任何 Session 的 Harness），以及通往它的各个步骤的边界。

第一阶段的非目标：

- 降低冷打开成本。第一阶段接受现有的冷打开成本（journal 恢复、MCP 重新安装和 discovery），由第二阶段解决。
- 把 wake 调度器、审批等待或观察循环移出 Harness。第一阶段中需要这些的 Session 保持常驻。
- 修改写租约协议或 Session Store。
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

每个常驻 Session 在 Harness 中有一个空闲定时器。该 Session 的每个请求、每项内部工作的完成都会把定时器往后推。定时器到点时，Harness 检查 Session 是否空闲；若空闲则挂起它：停掉 wake 调度器但不结算任何输入，按 detach 同样的方式 drain MCP 和 Hook owner，释放 Runtime 租约，释放 activation，seal 写者，并把这个 Session 从内存中移除。待处理的输入仍留在 journal 中。下一个请求到达时，Harness 已经没有这个 Session，于是走现有的冷打开路径重新 attach。

### 空闲时长

- 空闲时长是 Harness 中的一个常量，初始值为 10 分钟。它没有配置项、环境变量或请求字段，Harness 也不为挂起声明任何能力。
- 单元测试通过构造参数设置更短的时长。真实进程的集成测试同样需要较短的时长，因此 Harness 接受一个仅供测试使用的覆盖值，它不属于对外文档化的配置。
- Harness 给每个定时器加最多 10% 的随机抖动，避免同时进入空闲的 Session 同时被挂起。
- 测得冷打开成本后，再重新评估这个常量。

### 空闲判定

定时器到点时，只有以下条件全部满足，Harness 才挂起该 Session；否则重新计时一个完整周期。

- 没有活跃的 Turn，也没有等待 continue 或 cancel 驱动的已恢复 Turn。
- 没有打开的 Turn 事件流（控制面只在一个 Turn 执行期间打开事件流）。
- 没有已到期的输入。`notBefore` 在未来的输入不阻止挂起，因为它们到期时 `WakeRecovery` 会重新加载 Session。
- 没有待处理或恢复中的 MCP / Hook 操作，没有正在安装或刷新的 MCP 配置，没有进行中的 session message 操作，没有正在进行的上下文压缩。
- 没有存活的后台 Shell 或 Monitor 观察循环。
- 没有被 Turn 遗留持有的 Runtime，没有未结算的 Runtime 工作，hosted cleanup debt 为零。
- 没有活跃的 client-files 注册。浏览器的绑定由控制面保存，控制面只在 close 或 delete 这个 Session 时才关闭它；如果 Harness 自行丢掉注册，浏览器会一直显示桥接已连接，而模型实际上已经没有这些工具了。关闭标签页会立即结束绑定，因为它的下行连接随之关闭；之后 Session 就可以挂起。
- 没有进行中的 lifecycle 授权、ownership release 或池成员排空。
- Session 未处于 recovery-blocked 状态。被阻塞的 Session 保持常驻，运维恢复流程保持不变。
- Session 不是配置了 MCP 的公开 Workspace Shell 档位（`hosted-workspace-shell/1`、`hosted-workspace-shell/3` 或 `hosted-workspace-shell/4`）。这类 Session 的普通 detach 需要 lifecycle 授权，会以 `hosted_lifecycle_required` 拒绝，所以第一阶段永远不会挂起它。

判定和"标记为挂起中"在同一段同步代码中执行，因此判定与标记之间不可能有请求被受理。

### 定时器

- Session 进入常驻状态时，以及每次重新回到空闲时启动。
- 该 Session 在 `/session/:id` 路由上被受理的每个请求，以及每个 Turn、wake Turn、MCP 或 Hook 操作、上下文压缩和观察循环的结束，都会把定时器往后推。
- Session close、delete、被挂起或进入 lifecycle 操作时清除。

### 挂起流程

1. 把 Session 标记为挂起中。从这一刻起，`/session/:id` 中间件对它的所有请求都返回 `409 hosted_session_closing`，调用方已经把这个码当作暂时性错误处理。
2. 关闭 wake 调度器，不结算任何输入。
3. 非终态关闭 Hook 和 MCP owner，调用与 detach 相同。这会 drain Runtime 连接，并保留 owner 供下一次 load 重新获取。
4. 用现有的辅助逻辑非终态地释放 Runtime 租约，它会先结清已结算 Turn 欠下的文件历史标记。重试 hosted cleanup debt；如果仍有剩余，放弃本次挂起。
5. 关闭 Shell 和 background lane 的 publisher。此时没有存活的观察循环，没有任何东西在等它们结算，下一次 load 会重新创建它们。
6. 调用 `managed.close()`：停止续约、释放 activation、seal 写者。
7. 把 Session 从常驻表中移除。

seal 之前任何一步失败，Harness 清除挂起中标记、保留 Session 常驻并重新计时，这和 detach 失败后 Session 仍可重试的处理方式一样。seal 已提交之后的失败仍然会移除该 Session：它的持久状态是一个已 seal 的写者，下一次打开会接管它。

挂起跳过 detach 一开始会请求的普通执行授权：挂起不启动任何工作，而 seal 本身就受写者 fencing 保护。下面的审查列出了与 detach 的其余所有差异，每一项都用测试固定。

### close 路径审查

下表逐项列出 detach 和 delete 处理逻辑（`packages/cli/src/serve/hosted-harness-session.ts` 中的 `close`）的所有副作用，以及挂起如何对待每一项。处于 lifecycle protocol 2 操作中的 Session，其资源阶段由控制面驱动完成，之后这个处理逻辑只做 seal；挂起永远不会在 lifecycle 授权下进行，所以适用下面的完整路径。

| 副作用                                                                                                                  | Detach（`POST`）                                                      | Delete                       | 挂起                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| 授权                                                                                                                    | 普通的 `/execution:authorize`                                         | 无                           | 跳过                                                         |
| 等待进行中的 session message 操作                                                                                       | 是                                                                    | 是                           | 不需要：判定条件要求没有                                     |
| `SessionEnd` 和 `SessionDelete` Hook                                                                                    | 否                                                                    | 是                           | 永不                                                         |
| drain 被 Turn 遗留持有的 Runtime                                                                                        | 是，但 reload-stable owner 除外，它们继续运行，释放义务保留（#16579） | 是，全部                     | 不需要：判定条件要求没有                                     |
| 关闭 Hook owner                                                                                                         | 非终态                                                                | 终态，并释放遗留的配置 owner | 非终态，与 detach 相同                                       |
| 关闭 wake 调度器                                                                                                        | 是                                                                    | 是                           | 是，且不结算输入                                             |
| 结清已结算 Turn 欠下的文件历史标记，然后释放 Runtime 租约                                                               | 是，非终态                                                            | 是，终态                     | 是，非终态                                                   |
| 停止观察循环，结算为 `stop_requested` 或 `runtime_lost`                                                                 | 是                                                                    | 是                           | 不需要：判定条件要求没有存活的循环                           |
| 重试 hosted cleanup debt                                                                                                | 是                                                                    | 是                           | 是；仍有剩余则放弃挂起                                       |
| 关闭 Shell 和 background lane 的 publisher                                                                              | 是                                                                    | 是                           | 是                                                           |
| 关闭 MCP owner                                                                                                          | 非终态                                                                | 终态                         | 非终态，与 detach 相同                                       |
| 关闭 client-files 注册                                                                                                  | 是                                                                    | 是                           | 不需要：判定条件要求没有                                     |
| 把待处理的 monitor、channel、automation、子任务、session message 和 loop 输入结算为 cancelled，然后对账 automation 运行 | 是                                                                    | 是                           | 永不：输入留在 journal 中，等待下一次 load 或 `WakeRecovery` |
| 释放 activation 并 seal 写者                                                                                            | 是                                                                    | 是                           | 是                                                           |
| 停止事件流并移除 Session                                                                                                | seal 之后                                                             | seal 之后                    | seal 之后；判定条件要求没有打开的事件流                      |

控制面 close 或 delete 一个 Session 时，生命周期协调器还会关闭浏览器的 client-files 绑定（`closeForSession`）；而 Harness 自行丢掉注册时，没有任何一方会关闭它，这就是活跃注册会阻止挂起的原因。

没有其他按 Session 常驻的定时器。其余的 Session 组件没有自己的 close 或 stop，其中仅有的定时器都是单个操作内部的短暂等待。

### 重新打开

- **普通请求。** 控制面的下一个请求收到 `hosted_session_not_found` 后，清掉缓存的引用，按该请求自己的 attach 解析方式重新 attach（#17521）。挂起过程中到达的请求收到 `hosted_session_closing`，由调用方重试。
- **wake 输入。** `WakeRecovery` 已经会重新加载有待处理或新到期输入的无人持有 Session。transport 路径需要改一处：`activateForWake` 目前只要本进程还缓存着 attachment 就直接返回、不加载。改为：wake fence 显示写者不存活时，清掉缓存的 attachment，然后加载 Session。
- **lifecycle 操作。** 缓存为空时，close 和 delete 通过 lifecycle attachment 加载 Session，和控制面重启后的行为一致。
- **placement。** 第一阶段不改变 placement，因此重新打开会落在同一个池成员上。

### 冷打开准入控制

挂起会把一部分稳态工作变成冷打开的突发。例如一个 automation 计划同时为大量已挂起的 Session 触发，或者某个池成员重启。每次冷打开都要恢复 journal 并重新安装 MCP 配置，其连接和 discovery 各自最多等待 25 秒。

- Harness 限制单个实例的并发冷打开数，初始值为 8，和空闲时长一样是常量。超出限制的打开请求以新错误码 `409 hosted_session_open_busy` 拒绝。
- 这个限制作用于所有冷打开，包括 Harness 重启后的批量重新加载，同时也会把这类批量加载拉平。
- 控制面在 `HarnessConflictCodes` 中把 `hosted_session_open_busy` 归为暂时性错误；在 `HarnessCoordinator` 中把它归为推迟 Turn 但不消耗其准入预算的错误码，与现有的池 ownership 等待码同类。这个归类是前置条件：没有它，一阵集中的拒绝就会耗尽排队 Turn 的准入预算，导致它们失败。
- 控制面现有的限制保持不变：transport wake 的加载线程池，以及 `WakeRecovery` 每轮 8 个候选。
- Session Store 由所有池成员共享，单实例限制管不住 store 的负载。验证中会测量冷打开对 store 的负载，并据此调整这个限制。

### 控制面改动

以下改动都要先于 Harness 改动合入，或与它在同一个版本中发布（见"上线方式"）。

1. 重新 attach 失效的缓存引用（#17521）。
2. `activateForWake` 在 wake fence 显示写者不存活时清掉过期的缓存 attachment。
3. 把 `hosted_session_open_busy` 加入 `HarnessConflictCodes` 和 coordinator 的等待码。
4. 更新 `HarnessCoordinator` 中"控制面从不 detach"的注释。`hosted_session_already_attached` 的预算处理仍然正确，因为已挂起的 Session 返回的是 `hosted_session_not_found`，对它做普通 load 会成功。

### 与 Harness 池的交互

被挂起的 Session 保留 placement。如果它所在的池成员离开了池，下一个请求会接管 placement；placement store 允许这样做，因为写者已 seal 且 activation 已释放。一个之后再也没被访问的已挂起 Session，会让已离开成员的 `hasUnreleasedOwnership` 一直为真，池因此会一直保留该成员的连接器条目。这和现在成员崩溃后留下的状态相同；回收这类 placement 的机制列为待解决问题。

### 可观测性

- Harness：挂起次数、按原因统计的挂起放弃次数、按原因统计的判定未通过次数、冷打开次数及耗时（拆分为 store 恢复和 MCP 重新安装两部分）、`hosted_session_open_busy` 拒绝次数。
- 控制面：收到 `hosted_session_not_found` 后的重新 attach 次数，以及清掉过期 attachment 的 wake 激活次数。

### 故障模式

- **挂起过程中 Harness 崩溃。** 在 seal 之前，写租约过期，Session 的恢复方式与任何一次 Harness 崩溃相同。在 seal 之后，Session 已被干净地挂起。
- **挂起过程中 Session Store 不可用。** seal 或 activation 释放在提交前失败；放弃挂起，Session 保持常驻。
- **迟到的 wake 通知。** 发给已挂起 Session 的通知会遇到 `hosted_session_not_found` 或缓存缺失，随即重新加载 Session。
- **并发请求。** 挂起中标记在判定之后同步设置，因此一个请求要么先到并把定时器往后推，要么后到并收到 `hosted_session_closing`。

### 上线方式

挂起没有开关，Harness 会自行挂起 Session。因此它需要一个能做到以下几点的控制面：重新 attach 失效的引用、在 wake 时清掉过期的 attachment、把 `hosted_session_open_busy` 当作等待处理。如果面对的是旧版控制面，指向已挂起 Session 的缓存引用会一直收到 `hosted_session_not_found`，并且永远不会重新 attach。

- 控制面改动先于 Harness 改动合入，或与它在同一个版本中发布。
- Harness 和控制面一起升级。不支持新旧版本混跑的滚动升级，这与其他 Managed Agent 改动设定的边界一致。
- 无需 schema 变更。
- 要停止挂起，只能回滚 Harness 改动。回滚前已挂起的 Session 仍会像以前一样按需重新打开。

## 第二阶段：由 Runtime 管理 MCP 和 Hook 连接的生命周期

只定义边界；实现前另写设计。

- **现状。** Session 的 MCP 连接和 Hook owner 的生命周期等于它的 Harness attach：非终态 close 会对账每条配置、drain 并派发 `mcp-release`，下一次 load 重新安装配置、重连并重新发现。
- **目标。** Tool Runtime 通过 Broker 在多次 Harness attach 之间保留一个 Session 的连接，并按自己的空闲时长回收。Harness 凭持久化的 owner 身份和签发给新写者的 grant 重新获取这些连接。MCP 设计中已经有：Harness 空闲重载后，先推进配置记录的持久修订、再为新写者签发 grant，同时保持目录和连接 pin 不变。
- **待定义的接口。** Broker 上"挂起 owner"和"释放 owner"的区分；由谁、在什么时候回收连接；Harness 不再负责 drain 之后，结果未知时的名额占用及其配额放在哪里。
- **效果。** 挂起和重新打开不再需要 drain、重连和重新发现，消除了冷打开成本中最大的一部分。stdio MCP server 是 Runtime 里的长期进程，这是这部分归属应该放在 Runtime 的主要原因。

## 第三阶段：wake 调度和后台观察移到控制面

只定义边界。

- **现状。** 每个常驻 Session 在 Harness 中运行一个 `HostedMonitorWakeScheduler`，带延时定时器以及 busy 和 blocked 重试；后台 Shell 和 Monitor 的观察循环也运行在 Harness 中。控制面的 `WakeRecovery` 只是无人持有 Session 的兜底。
- **目标。** 由控制面判断 Session 何时有到期输入，并向任意池成员发送 wake 请求；Harness 执行被请求的输入后再次挂起。后台工作的观察移到 Runtime publisher 和控制面，这样有后台 Shell 或 Monitor 的 Session 也能挂起。
- **已有基础。** `ma_session_head` 中的 wake 字段（`is_wake_pending`、`wake_head_revision`、`wake_retry_at`）、`WakeRecovery` 对延时 `notBefore` 的处理，以及 transport wake activator。

## 第四阶段：审批停靠

只定义边界。

- **现状。** 等待工具审批的 Turn 一直在 Harness 中运行，由 `HostedApprovalWaiters` 挂住，尽管 checkpoint 已经记录了 `await_action` 阶段。
- **目标。** Turn 停在 `await_action`，本次请求结束。审批结果通过现有的 Managed Runtime continue 路径在任意池成员上恢复这个 Turn。

## 风险

- **重新打开的延迟。** 第一阶段每次重新打开都要付出完整的冷打开成本，包括 MCP 重连和 discovery。空闲时长设得太短，会用续约节省换来缓慢的首次响应；初始常量会根据测量结果调整。
- **冷打开突发。** 即使每个 Harness 限制了自己的并发打开数，同步发生的 wake 仍可能压垮共享的 Session Store。
- **与 close 路径的耦合。** 挂起复用了 detach 路径的一部分，以后对 detach 的修改可能悄悄改变挂起的行为。用测试固定"close 路径审查"中的每一行。
- **池中的残留。** 已离开成员上的挂起 Session 在被访问之前一直保留 placement。
- **没有紧急开关。** 挂起出现缺陷时，只能通过回滚 Harness 改动来止损。下面的验证计划就是对此的缓解措施。

## 验证计划

第一阶段：

- **Harness 单元测试。** 每个判定条件都能阻止挂起；定时器在请求和内部工作完成时被重置；挂起流程按顺序执行；"close 路径审查"中的每一行都有测试固定，特别是没有任何输入被结算为 cancelled、没有运行 `SessionEnd` 或 `SessionDelete` Hook、欠下的文件历史标记被结清、Runtime 租约以非终态方式释放；seal 前的放弃会让 Session 保持常驻且可重试；挂起过程中的请求收到 `hosted_session_closing`；超出限制的打开请求以 `hosted_session_open_busy` 拒绝。
- **控制面单元测试。** `activateForWake` 会清掉过期的 attachment；新错误码被归为暂时性错误，推迟 Turn 时不消耗其预算。
- **真实进程和 MySQL 集成测试。** 挂起后发送 prompt：历史完整，Turn 正常完成。挂起后投递 monitor、channel、automation 和子任务输入：分别经由 transport 路径和 `WakeRecovery` 重新加载后执行。延时 loop 输入在挂起后到期并执行。有后台 Shell 运行的 Session 不会被挂起。对已挂起的 Session 执行 close 和 delete。成员离开池后，已挂起 Session 的 placement 被接管。
- **故障测试。** 在 seal 之前和之后分别杀掉 Harness；挂起过程中让 Session Store 不可用。
- **测量。** 测量不同大小、不同 MCP 配置的 Session 的冷打开耗时和 store 负载，据此调整空闲时长和打开数限制。

## 验收标准

- 从未空闲满一个空闲时长的 Session，行为与现在相同，现有测试结果不变。
- 空闲 Session 在一个空闲周期加抖动之内停止续约，并且不再计入 `attachedSessions`。
- 任何挂起都不会把输入结算为 cancelled，也不会停止后台工作；所有待处理输入都会在重新加载后执行。
- 对已挂起 Session 的每个请求，最多经历一次暂时性拒绝和一次重新 attach 后成功。
- 上述集成测试和故障测试在 CI 中通过。

## 待解决问题

1. 回收已离开池成员上的挂起 Session 的 placement。
2. 空闲时长（初始 10 分钟）和打开数限制（初始 8），根据冷打开测量结果调整。
3. 运维恢复流程能重新加载 recovery-blocked Session 之后，这类 Session 是否也应该挂起。
4. 重新加载时把活跃的 client-files 绑定重新注册到 Harness，这样打开着浏览器桥接的 Session 也能挂起。
5. 每个池成员能否访问所有 Workspace 挂载；第二到第四阶段假设任意成员都能打开任意 Session。
6. Turn 的 reload-stable Runtime owner 在 detach 时会继续运行、释放义务保留（#16579）；挂起期间能否也让它们继续运行，从而让这类 Session 也能挂起。
7. 挂起配置了 MCP 的公开 Workspace Shell 档位的 Session，这类 Session 目前的普通 detach 需要 lifecycle 授权。
