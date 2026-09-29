# Managed coordinator：调度、装配与关闭

更新日期：2026-09-11；核对源码基线 `a8360814668b3dfdff72ad3d99cbcaf26dd009a9`，前一版文档 `4dc4a90dcc`。本文是待实现设计，细化[全局架构](managed-agent-session-harness-runtime.md)的调度与普通接入部分；配合[Harness](managed-agent-harness.md)、[私有协议](managed-agent-control-protocol.md)及[Session 兼容映射](managed-agent-session-method-map.md)。本轮不启动产品、不切换默认入口。

## 1. 控制权与当前差距

coordinator 组合 Session authority、完整 Harness 和 Runtime provider，持有属于具体 Session 的执行绑定及清理责任。它不另写会话历史，不推进第二套模型循环，也不依靠浏览器连接维持 Session。Session 的 engine、Harness 的位置、Runtime 的位置分别决定；换 Harness 不改变 engine。

**存活范围：coordinator 的生命周期是 daemon 进程，不是持久 Session。** 它持有的 Runtime binding 与派发门禁状态在进程内存中（门禁的执行端状态同样在 Runtime 进程内存中），因此“更换 Harness 不丢原调用”只在原 coordinator 与原 Runtime binding 存活时成立。daemon 或 Runtime worker 自身重启后，未决副作用按[恢复与运行专项](managed-agent-recovery-operations.md)保持 recovery_blocked；跨进程接管需要持久 binding 与门禁账本，属于该专项的后续切片，不能由本文的内部接口隐含承诺。

当前 EmbeddedHarnessScheduler 的 handler 返回 Promise<void>，返回后把 activation 标为 completed，异常标 failed；dispose 只发 abort，不等待 handler 排空。FileManagedActivationStore 的 descriptor 只有 user_message/replay_safe，身份键未显式包含 workspace；ManagedPromptService 还假设 activationId 对应一个输入 messageId，并依赖实验成功轮次集合判断 continuation。这些现有契约继续供实验入口使用，不能直接用于普通多 Prompt、持久等待和有副作用恢复。

普通 Managed 的输入、唤醒意图及 activation 的 claim/renew/release 由 **同一个 Session authority** 提交。调度队列是这些事实的可重建索引，不增加第二个决定当前执行 epoch 的日志。首版以 authority 后端适配调度所需的窄接口，复用现有公平选择、内存保护与有界 pump；实验 FileManagedActivationStore 保留其原后端。两者不能同时授予同一普通 Session 的推进权。

租约规则仍是三类：物理 writer 属于 Session authority，activation 执行资格属于被授予的 Harness，Runtime lease 属于原环境绑定。调度槽位 reservation 和共享 host 引用计数是容量管理，不是额外的执行授权。

## 2. coordinator 的最小内部接口

以下为目标职责及方法语义，不修改现有同步 Bridge 方法。首版可作为 daemon 内部组合对象；不新增用户需要选择的服务地址或引擎开关。

| 内部操作                    | 实际调用方                                                     | 提交与返回边界                                                                                                                      |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                   | daemon 完成存储/协议/恢复检查后                                | 建立待唤醒索引、处理原绑定和过期 activation；未决副作用先隔离，不无条件启动模型                                                     |
| `submitInput(command)`      | 普通入口的 admission ticket 适配                               | 经 authority 提交规范化输入和 wake intent；返回持久 accepted 与独立 completed；保留旧 sendPrompt 的同步错误和 onPromptAdmitted 契约 |
| `reconcile(sessionKey)`     | 提交后、工具/审批回执后、启动恢复和受控重试                    | 只由已提交状态生成候选，按 wakeId 去重；运行中的 Session 不创建第二个推进者                                                         |
| `beginDrain(scope, reason)` | workspace reload/remove/撤信任、Session close、daemon shutdown | 同步封住本地新工作，并启动持久封闭/派发撤销；这一调用本身不证明已排空                                                               |
| `drain(scope, reason)`      | 原资源 owner                                                   | 等待实际 Harness/Runtime 工作结算、必要记录提交和自有资源退出；失败保留 retiring owner 与可重试清理，禁止新准入                     |

取消、审批等继续走 authority 的既有领域入口，coordinator 消费其已提交意图。内部触发不以“直接调用 run”跳过准入。协议错误或观察者失败不能使已提交输入被自动删掉。

## 3. 一次 activation 的事务顺序

1. 在普通入口沿用 Session ID reservation、workspace/directory gate、用途和固定 engine 检查。Managed 输入持久提交之前保留容量预留；已提交后即使队列索引写入或 HTTP ACK 丢失，也能从 wake intent 重建。
2. 有空槽位时，从每个 Session 的可运行头部选择候选；保留跨 tenant 的公平轮转和总量限制（v1 的 `tenantId` 是 workspace 派生的本地键，该轮转实际按 workspace 生效，语义见[私有协议](managed-agent-control-protocol.md)§2）。队列项携带完整 sessionKey、turnId、wakeId、原因及所需已提交位置，不携带“无条件 replay_safe”承诺。
3. authority 在单 writer 的条件提交内检查 Session 未关闭、候选仍可运行、没有有效推进者，创建带单调 epoch 的 installing activation。coordinator 对全部相关原 binding 执行 stageGate，关闭旧/新派发并取得已准入工作清单；authority 核对后提交 completeActivationInstall，再由 Runtime enableGate ACK 确认。部分成功按原安装 ID 查询重试；过期 lease 只触发恢复检查，不证明旧工具退出。
4. 通过 HarnessFactory 获取逻辑 handle，校验定义版本、恢复包的 restoreBasis/restoreProofRef/checkpointRef 合法组合与私有协议能力；全部必要门禁 ACK 齐备才提供可运行 grant、Session client 与可信 Runtime dispatcher。能力不足明确失败，不能转回 legacy。没有工具请求时允许不创建 Runtime；首次惰性创建及新增 child 也必须先安装门禁，不能绕过激活检查。
5. Harness `run` 到达明确 boundary。执行消息由 Harness 经 appendExecution 提交，checkpoint/等待边界经 commitCheckpoint 提交；turn_complete 在该命令内与 turn.settled 同事务提交。authority 校验 fence、终态 payload 与引用闭包；coordinator 不代为提交，只读取已提交回执。scheduler 只消费已提交的 boundary 回执，不能从 Promise resolve、host EOF 或 UI idle 推断 turn 完成。
6. durable_wait 按[Harness 专项](managed-agent-harness.md#6-detach-与终结实现约束)的唯一脱离顺序执行：先撤销该 activation 的新派发权并取得执行端 ACK、确认已准入调用与等待 owner 归 coordinator，**然后**由 Harness 提交 checkpoint/boundary，再 detach 逻辑 handle，最后记录 activation 释放并归还实际执行槽位；turn 仍等待。门禁必须早于 checkpoint，否则 checkpoint 提交期间仍可能产生新派发，使其覆盖范围失效。工具/审批回执即使早于释放到达，也由已提交状态对账生成下一候选，不丢唤醒。
7. turn_complete 在正式终态提交后释放 activation；recovery_blocked 保留原调用和原因，撤销派发并停止该 Harness 后才释放可释放的计算资源。若停止/屏障无法证明，继续计入占用或隔离中的工作，不假装空闲。

领取、续租与释放均使用完整 fence 和 commandId；旧 epoch 的普通执行提交被拒绝。过期后重新激活需要新的 epoch，不能复用原 workerId 作为身份。命令幂等重试先按原 ID 查询，不创建第二个 activation。

续租按现有 leaseDuration/3 的调度思路触发，duration 来自受控配置并明确记录在 grant 中；判断以 authority 的时间为准。失去联系或续租失败时，Harness 立即中断自身模型并停止新派发；Runtime 的准入门禁也必须能失效，不能只靠宿主自觉 abort。存储不可用时不继续推进执行。

## 4. 状态与容量分别统计

| 对象                  | 状态/计数规则                                                                                                                           | 不可混同                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Session               | open/closing/closed 与固定 engine；工作状态由 turn 投影                                                                                 | Session 存在不表示有活 host，closed 不代表删除历史                                                         |
| turn                  | queued/running/waiting/settled，另附 recovery_blocked 和 cancellation 状态                                                              | activation 返回或调用方超时不等于 turn 的物理执行已结算                                                    |
| activation            | candidate → installing → active → running → waiting-boundary/terminal-boundary/blocked → released；失租进入 fencing/recovery            | active 是 authority 安装提交；Harness 真正运行还必须取得全部 enable ACK；released 不自动产生 turn_complete |
| Harness handle / host | 每个逻辑 handle 的运行、停止、detach；实际共享 host 单独引用计数                                                                        | detach 一个 Session 不关闭同 host 的其他会话；进程仍存活就继续计入进程/内存                                |
| Runtime binding       | lazy/preparing/ready/draining/released/lost，与原 lease 和调用集合绑定                                                                  | 等待可释放 Harness 槽位，但未决工具、后台工作和 Runtime 内存继续占用                                       |
| 接纳和队列            | 全局、tenant、Session 上限与普通 Bridge 的 ID/Prompt reservation 各自有 owner（v1 的 tenant 上限等同 workspace 上限，不是独立租户配额） | 不因 legacy/Managed 各一套执行器使总限额翻倍；索引补偿不能绕过已接受输入的预算                             |

首版保留当前上限和内存预算来源，不因拆分提高容量。需要分别观测：逻辑 Session、候选数、有效 activation、持有 Promise 等待的旧 handle、可恢复等待、活 host、Runtime、未决 invocation 与 retiring 资源。数据未知保留 unknown；不把 activeWork 的局部覆盖或零工具数当作全局空闲证明。

公平策略只在已符合 Session 顺序和执行安全条件的候选间选择。定时/通知不会越过未结算的原调用；同一等待点的多次通知可以合并唤醒，但所有业务输入与回执本身仍需保留和去重。

## 5. 四处普通 factory 的装配

共享一个构造流程，输入是已解析 workspace、runtimeBaseDir、generation guard、可信环境/argv/trust、预算与已有 registry/存储所有权。先校验完整配置兼容，再发布可用 runtime；selector 的严格空扩展和全来源策略继续由[执行引擎设计](managed-session-execution-engine.md)约束。

| 接入位置              | 当前接缝                                    | 目标装配与验收                                                                                                   |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| primary workspace     | run-qwen-serve 的主 channelFactory / Bridge | 注入成对 `executionEngines: { legacy, managed, select }`，共用 admission、Session owner index 和事件适配         |
| 启动时 secondary      | secondaryChannelFactory                     | 相同构造流程，绑定自己的 cwd/env/trust/storage，不借 primary 的 Config 或 provider                               |
| dynamic / replacement | wsChannelFactory、workspace generation 切换 | 新 generation 通过初始化后才发布；旧 Session 固定 engine，原 binding 保留限权清理通道，失败不复用不明资源        |
| 自有直接嵌入          | server.ts 创建默认 Bridge                   | 未注入 Bridge/registry 时采用相同策略；显式注入的外部实现保留其 ownership，不重复创建 coordinator 或代为 dispose |

Managed 分支使用完整 ACP Harness 适配；legacy 分支继续原 spawn factory。Tool-only worker 不走普通 Harness 工厂，避免递归创建模型 host。只有新会话已被证明兼容才默认 Managed；旧会话、延期能力和未知输入按原固定策略处理。构造接口统一不表示所有组合已通过验收。

普通 Web Shell/REST/ACP/SDK 复用同一命令接缝；Standalone 的目录锁、初始 prompt/仅创建差异与断连清理继续按兼容方案保留。cron、Goal、通知和子任务入口逐项接入；首阶段 Channels/MCP/Hooks 的完整迁移继续后置，不能因为新 coordinator 接受某个 reason 就自动放行该用途。

## 6. detach、close 与 generation drain

| 操作                           | 必须保留的资源                                                          | 允许完成的条件                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 客户端断连 / detachClient      | 按既有引用和后台工作规则保留执行                                        | 解除原 client 引用，保留旧末引用空闲关闭规则；不转换成可恢复 Harness 回收                                            |
| 可恢复 Harness detach          | Session authority、原 Runtime lease、已准入调用、审批和父 history owner | checkpoint 与等待已提交，旧派发门禁关闭，原工作已转交 coordinator，逻辑 handle 停止；共享 host 可继续服务其他 handle |
| Session close                  | writer/provider/回执接收端保持可用直至必要工作收敛                      | 封输入、持久 cancel、取消并核对模型/工具、同步回执/备份、写终态、排空 Harness 与 Runtime、最后封存 writer            |
| workspace remove/reload/撤信任 | 精确旧 generation 的 status/cancel/history/release 资格                 | 不发起新调用；已接纳回执按原绑定结算；只清理该 generation 自有资源，失败仍可由原 owner 重试                          |
| daemon shutdown                | 所有未结算 owner 与共享 registry                                        | 先封全部新工作，再逐层等待；只有 daemon owner 最后关闭共享进程资源。未知进程退出不记为成功释放                       |

当前 AutoLocalProvider 的校验依赖 active registry，beginDrain 后原 runtime 会被活动查询隐藏。目标是 coordinator 持有原 generation 的精确引用及清理凭据；active 和 cleanup 两条校验路径分开。cleanup 只能操作原调用和持久历史，不能用同 cwd 的新 runtime 或 primary 替换，也不能把 allowDraining 扩大成允许 prepare/execute。

Session 与 Harness 初期可同进程承载，仍须分开生命周期；Tool-only Runtime 已使用独立 worker。初期允许原完整 host 的不可序列化等待继续驻留并占槽；仅实现这种过渡方式时，不能宣称跨 Harness 恢复或独立扩缩容完成。

## 7. 故障验收与实施切片

| 编号 | 夹具与观测                                                                     | 必须结果                                                                                                                   |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| C01  | 输入已提交，队列索引/HTTP ACK 丢失，再启动对账                                 | 原 ID 唯一，恢复候选，无重复模型/工具副作用                                                                                |
| C02  | 两个领取者竞争同 Session、旧续租/释放迟到                                      | 唯一有效 grant，旧 epoch 不写状态、不新派发                                                                                |
| C03  | handler 返回 waiting，工具结果在释放前/后分别到达                              | turn 保持等待，唯一后续唤醒意图，重复投递可去重；槽位与 Runtime 占用分别正确                                               |
| C04  | lease 到期但旧 host/命令进程仍运行；另跑一组屏障与原调用安全证明齐备的对照用例 | 无证明时保持 blocked，不只等时钟过期；证明齐备的对照用例必须真的换 handle 继续原 turn 并消费原调用结果，不允许同样 blocked |
| C05  | 多 tenant、多 Session 混合 legacy/Managed，内存压力                            | 共享总限额不翻倍，FIFO 与公平策略生效，不借扩容掩盖泄漏                                                                    |
| C06  | 同一 host 多 handle，detach 其中一个；分别关闭 Session/workspace/daemon        | 其他 Session 不被杀，资源在实际责任层释放，失效清理仍可重试                                                                |
| C07  | 四处普通 factory、直接注入、Tool-only worker                                   | 默认装配一致，外部 ownership 不被接管，worker 不递归；真实工具/final 与固定 owner 可观测                                   |
| C08  | generation draining 时接收迟到回执，注册同 cwd 新 runtime                      | 只结算旧引用，无新调用，无 primary 回退，不清理新资源                                                                      |

**验收的正向门槛。** 上表每条都必须同时给出一个应当成功的对照用例并观测到实际推进：C01 恢复出的候选要真的把该 turn 执行到终态；C02 新 grant 要能继续推进；C03 唤醒后要真的消费结果并继续模型；C04 见该行的对照要求；C06 detach 之后原 Session 必须能由新 handle 继续，不是只验证“没杀别人”；C08 旧引用结算完成后同 workspace 的新会话必须能正常取得 runtime。一个对任何输入都返回 blocked、拒绝或“保持未知”的实现**视为验收不通过**——保守拒绝是未知场景的正确结果，不是全部场景的合格结果。每条验收记录必须写明正向用例的观测点（已提交的 boundary、消费的回执、客户端可见终态），只有拒绝分支的证据不构成通过。

R2.S1 实现 authority activation 事实与队列适配；R2.S2 接完整 Harness 的 boundary 回执与基础 activation 门禁，在 A/D 点先排空旧 handle 再替换；R2.S3 在同一门禁协议上增加在途调用移交、等待/接管和可恢复 detach；R2.1～R2.4 再完成有效配置与四处装配。上述验收本轮未运行，正式实现按仓库流程编写隔离 E2E 计划、建立基线、执行定向测试和真实进程验证。

源码依据：`packages/core/src/managed-runtime/embedded-harness-scheduler.ts`、`managed-activation-store.ts`；CLI `serve/managed-prompt-service.ts`、`managed-agent-channel.ts`、`run-qwen-serve.ts`、`server.ts`、workspace registry 与 provider。精确 DTO 和兼容版本采用私有协议文档，禁止通过原实验 descriptor 的 replay_safe 字段扩大工具重放范围。

## 8. 全量领域工作与恢复

[自动任务专项](managed-agent-automation.md)规定 Channels、手动/自动定时、Goal/Live、子任务和记忆的准入、outbox、去重和取消；coordinator 只消费已提交候选，不再从默认 source 字符串推断普通用途。模型推进使用 ActivationGrant；模型轮结束后的交付、配置安装和历史维护使用[私有协议](managed-agent-control-protocol.md)的窄 OperationGrant，两者不产生竞争的 Session epoch。领域工作引用共享容量、原 Runtime 和同一生命周期 barrier，不在 Harness detach 时被丢弃。

worker/daemon 重启及远端接管按[恢复与运行专项](managed-agent-recovery-operations.md)的持久 phase、认证 attach 和 unknown 分类处理；完整恢复扫描先于任何自动派发。活进程配额与未决结果分别统计，明确退出的进程可释放槽位，但未知结果不能据此当作未执行。全量顺序及 C01～C18 对应见[覆盖表](managed-agent-full-design.md)。

生命周期 prompt Hook 的调度随 R5/F5（Hooks，C09）交付；R2 只让 subject/boundary 分型通过校验，不实现该执行路径，期间无活 turn 的生命周期 Hook 保持原 legacy 行为（同[Harness 专项](managed-agent-harness.md)§8）。其目标设计是：使用统一 ActivationSubject 的 hook_operation 分型，和普通 turn 共用唯一 epoch 与槽位；不能在普通 turn 活跃时并起第二模型推进者。Session closing/deleting 的新准入屏障保留一个窄例外：仅受理该已提交维护操作的固定 Hook occurrence，拒绝用户/Goal/cron 等新工作。它完成原 PromptHookRunner 后按 hook_complete 结算，不创建用户 turn、普通回复或完成通知；Hook request/attempt/phase 不明时保留原 owner 与恢复状态。真正 deleted 只在 Delete Hook、其他物理工作和资源清理都结算后提交，维护 tombstone 保留幂等证明。
