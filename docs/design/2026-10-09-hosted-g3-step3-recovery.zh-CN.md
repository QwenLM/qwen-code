# Hosted G3 第三步：Harness 替换后恢复停靠的 Turn

[English](2026-10-09-hosted-g3-step3-recovery.md) | [简体中文](2026-10-09-hosted-g3-step3-recovery.zh-CN.md)

状态：已在当前分支实现，2026-10-09；不可变快照 `linux-rebased-gates-3` 的五种限定范围 Linux 打包验收模式全部通过。rebase 后的源码基线为 upstream `main` 的 `4a3b8f3c084a1aa82af6cd75684f26123cdc64be`；快照包含生产提交 `dca809caf4526ade87b12dc46a0797cf744dc0d6`。属于 [#12952][g]，延续已有 G3 原生文件恢复工作。本次不关闭更广的 G 系列或 Q2 fencing 门禁。

当前实现为不含 Hooks/MCP 的原生文件 profile 生产审批计划（打包门禁覆盖 `hosted-workspace-files/1`），为不含 Hooks 的主模型请求保存精确快照，并实现冷恢复流的有界撤回及原生 Turn 清理债务。主模型冷重发仅在不含 Hooks/MCP 时准入。Shell profile 保留现有执行和清理 owner。运行中的前缀 continuation 继续可用，但尚未完成的前缀 continuation 不保存冷重发快照，恢复时明确拒绝。主模型 attempt 已完成且最终回答已提交时，仍可只补终态而不重发推理。超限快照保留明确不支持的边界。协议生产者和读取者在本次工作区一同实现；下文门禁定义所需的验收证据。

精确请求快照由原生 Turn driver 在首次准入、审批恢复和模型 redrive 路径生产。旧 Runtime-only continuation 路由保留现有 G1 恢复行为，不生产这些快照。渠道中断结算对账原 G3 清理债务，并在释放失败时保留仅由清理债务引起的阻塞；请求准备失败时，普通 prompt 和 wake 输入均保持未结算，留待恢复。

## 1. 问题与已有行为

G3 第 1–2 步让仍存活的 Java 控制面能够接纳替代 Hosted Harness。第三步需要在
崩溃发生于模型推理或审批等待时完成原 Turn，并保留已经提交的终态事件。恢复必须
沿用原 Session、Prompt、权限主体与副作用身份。

| 基线行为                                                                                      | 第三步仍需补齐                                                             |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| connector 会重新协商新的 Harness 代数；journal writer fencing 与仅重启 Harness 的门禁已合入。 | 每次恢复写入与新工具准入之前仍需通过该 fencing。                           |
| `await_runtime` / `results_ready` 文件工具恢复查询原执行并消费原结果。                        | 复用已有路径；不得从模型输出重新构造并派发这些调用。                       |
| requested 审批可以附着，resolve 在回答前提交决定。                                            | 替代进程没有原来的内存 waiter，必须在持久等待结束后驱动或结算停靠的 Turn。 |
| `resolveDurableWait()` 把 `await_action` 推进至 `model_output_committed`。                    | 这一 checkpoint 转换不会执行批准后的批次，也不会完成 Turn。                |
| 无工具会话和首轮模型的 drive load 以 `model_start` 拒绝。                                     | 恢复有证据的模型请求边界，不得作为普通新 Turn 启动。                       |
| load 已能补偿可投影的 `turn_settled` checkpoint；Java 更换事件 epoch 时不推进已消费游标。     | 补齐故障与丢响应覆盖，保留现有机制，不另造投影协议。                       |
| cancellation-only load 能结算部分没有未付 Runtime 工作的停靠状态。                            | 覆盖 requested 审批、过期与决定后的崩溃，不认证未经观测的停止。            |

源码定位：`hosted-runtime-recovery.ts` 的 `recoverHostedRuntimeTurn`，
`hosted-harness-session.ts` 的 `executeHostedTurn`、
`settleCancelledHarnessTurn`、load 与 Action resolve 路由，
`hosted-tool-approval.ts` 的 `resolveHostedAction`，
`managed-harness-factory.ts` 的 `resolveDurableWait`，以及 Java
`HarnessCoordinator` 的 `runClaimed`。以上是基线事实，不是新的验收结果。

当前 `model.attempt: output_committed` 在 provider 流结束后、最终 assistant 消息
持久写入前记录，因此不证明答案已经提交。新的模型调用也会把循环从第零轮开始；
第三步必须保留原剩余轮数与绝对的 `input.accepted.deadline`。

## 2. 范围与不变量

本设计覆盖同一个 Java 控制面可连接的先后 Hosted Harness 代数。普通本地
Managed 激活、两个存活的控制面 owner、跨主机接管与 Shell 执行接管仍另行处理。

- 成功 load 意味着停靠 Turn 有已注册的 driver、带过期处理的持久审批等待，或
  可偿付的终态投影。仅让 Session 可读并不足够。
- 模型请求可以重发；可能已经派发的工具、Hook、MCP 调用或子任务不得为了恢复
  进度而重新创建。
- journal 对准入、Action 状态、执行 receipt 与结算具有权威性。Java 拥有公开
  命令投递和已消费事件游标；当前被 fencing 的 Harness 拥有模型与工具编排。
- 保留原 `promptId`、用户记录、Action ID、已提交输出的模型消息 ID，以及已
  prepare 工作的 execution ID。新推理 attempt 使用新 attempt/message 身份，
  不创建新 Prompt。
- 原 Turn 或清理义务仍占有相应资源时，拒绝新 Prompt、undo 和 cwd 变更。状态
  与取消必须如实报告停靠 Turn。
- Store 故障是可重试故障，不是资源或执行不存在的证据。持久证据缺失、损坏或
  冲突时必须 fail closed。
- Managed 失败不回退到 Legacy。Workspace 授权过期、capability/configuration
  pin 改变或 writer 丢失都不能授予执行权限。

## 3. 按证据选择恢复路径，不按 phase 名称猜测

`HARNESS_MODEL_START_PHASES` 是运行准入词汇，不是恢复白名单。
`model_output_committed` 可能表示批准后的工具批次仍待执行；`results_ready`
拥有原 receipt；`turn_settled` 只欠投影。Turn 为 null 的 bootstrap
`before_model` checkpoint 不是当前已接纳模型请求的快照。

| 原 Turn 的持久证据                                                                 | 提议行为                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 已标记提交，但 Java 没有 admission epoch/回答。                                    | 保留 G3 D4 的原命令对账。null epoch 仅证明回答缺失；安全性来自 journal 命令幂等和停靠输入拒绝，不增加第三步重提快捷方式。 |
| 完整主模型请求快照，attempt 尚未完成，没有该请求的已提交输出或未结算副作用。       | fencing 和撤回后，在新 attempt 下重发该模型请求。                                                                         |
| assistant 工具调用消息完整，但批次缺少完整的审批续跑证据。                         | 不重发模型、不进入普通工具入口，保留现有恢复拒绝。                                                                        |
| `await_action`，Action 仍为 `requested`，续跑证据完整。                            | 保留原 Action，恢复 waiter、过期处理和取消 driver。                                                                       |
| Action 为 `decided` 且选择 `allow` 或 `deny`，续跑证据完整。                       | 驱动保存的原批次，应用原决定一次；Deny 写配对的工具拒绝，再按正常路径继续模型。                                           |
| Action 为 `cancelled` / `expired`，或新派发前已有 Turn 取消获准。                  | 证明没有未付副作用后，关闭持久等待并把原 Turn 按取消结算。                                                                |
| Action 决定后有部分 prepare 或 intent 证据。                                       | 先对账原预留并补齐原批次 checkpoint，再进入 G1/G2，不用替代 ID prepare。                                                  |
| 存在完整的 `await_runtime` / `results_ready` 执行证据。                            | 通过 G1/G2 恢复原执行，不用替代 ID 重新 prepare。                                                                         |
| `results_ready`，原工具结果完整。                                                  | 沿用已有结果续跑，不重跑产生工具的模型轮。                                                                                |
| `turn.settled` 已提交但尚未被 Java 消费。                                          | 重绑事件 epoch，从 Java 已消费游标重放，不推理、不执行工具。                                                              |
| `turn_settled` checkpoint 可偿付，但缺少终态记录。                                 | 沿用终态投影补偿，保证幂等写入与重放。                                                                                    |
| Shell 在飞、外部工作结果未知、Hook/MCP/child 证据不完整，或存在多个歧义停靠 Turn。 | 保留已有类型化拒绝/阻塞及相应所有权 fence。                                                                               |

模型与审批需要少量按 producer 定义的持久资源，不新增通用恢复 domain、公开
resume API 或配置矩阵。

## 4. 切片 A：完成审批等待（B2）

### 4.1 发布等待前保存续跑信息

现有 `approval.invocationRef` 保存单个调用的输入，`optionsRef` 标识 Action。
两者都不能单独保留混合批次、先前决定、改写后的输入，以及 Hook 再次询问的阶段。
在 `commitDurableWait()` 之前保存不可变的
`hosted-approval-continuation/1` 资源。提议 Action options 第 3 版通过
`continuationRef` 引用它，`invocationRef` 保持当前含义。

| 续跑内容                                                                                                     | 必要用途                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Session key、原 Prompt、assistant 消息、definition/config/profile/policy pin 与来源 activation。             | 拒绝外部、过期或配置不同的续跑。                                          |
| 有序 call ID、名称、有效输入 ref/digest、tool definition、稳定 `runtimeCallId` 及 prepare 幂等键/reference。 | 重建原批次，不发明参数或 ID。                                             |
| 当前 Action ID、审批 ordinal、位于 PreToolUse 前还是输入改写后的再次审批。                                   | 从正确阶段继续，不把早期审批授予后来的输入。                              |
| 先前决定/拒绝与已完成 permission/Hook 证据引用。                                                             | 保留已经偿付的决定和副作用，不重复 Hook。                                 |
| 原 Runtime owner 身份与已有 prepare/receipt 证据。                                                           | 区分派发前计划与必须转入 G1/G2 的工作。                                   |
| 历史边界和 model/Hook 续跑输入。                                                                             | 从已提交 assistant 调用消息继续，不再写用户记录、不重新推理同一调用批次。 |

Action options、descriptor 及嵌套输入引用必须处在同一持久等待事务中。失败既
不能发布可恢复等待，也不能声称其输入完整。全部 ref 位于同一 Session；沿用已有
资源与事务大小限制。

首份审批快照不一定是最终执行计划：PreToolUse 可能改写输入并分配新
`runtimeCallId`，即使不再次询问审批。在 Hook 和决定全部完成后、file-history
或 prepare 副作用前，发布并通过 journal 引用最新的不可变有效批次 revision。
提议使用窄的 `hosted.batch.planned` 事件，含 `batchId`、`planRevision`、
`planRef`，引用同一 continuation 格式。保存最终 model-call/runtime-call ID、
规范化 payload ref/digest、definition、拒绝/决定、原 owner 和完整 Broker
prepare reference/key。恢复选择该 revision，而非最初审批 descriptor。该持久
链接提交前不允许 file-history 或 prepare 副作用。如果最终计划生成前崩溃，仅从
已证明完成的 Hook/decision 阶段恢复；producer 证据不完整时仍拒绝。

第 3 版保留现有预览策略：只有可提供原生有界预览的工具才含 `inputRef`；
`continuationRef` 是私有恢复数据，不作为公开 Action 字段返回。Java Action
projector 和 TS options reader 都必须先支持 v1/v2/v3，writer 才能输出 v3。

### 4.2 恢复 driver，再服从持久化竞争结果

1. 获取新 writer activation，恢复准确的 Session/profile、原 Runtime owner 与
   续跑证据。在允许新副作用之前检查取消与当前授权。
2. 在 load 回答前注册一个停靠 Turn owner。`/status` 仍报告进行中，`/prompt`
   不能覆盖停靠状态。resolve、cancel、expiry 与重复 load 汇入同一个
   per-Session driver。内存 latch 仅负责单进程调度；journal CAS 与原 dispatch
   ID 才提供跨崩溃幂等性。
3. requested Action 保留原 ID 和 deadline。注册 waiter 和一个过期定时器后再读
   Action，覆盖在注册前已胜出的决定。不为同一输入创建新审批。
4. Allow/Deny 验证原 decision digest、input revision 和 policy revision。
   推进等待一次，恢复保存的执行阶段并继续原批次。有效输入改变时，按适用 policy
   重新判断，必要时取得新审批；保存的 Allow 本身不能授权改写参数。
5. 从原记录恢复已完成 Hook occurrence。只有下一阶段被证明从未开始时才准入新
   occurrence。不确定的 Hook/MCP 结果或已有 tool intent 转入对应恢复路径，不
   创建新调用。缺少完整证据的 producer adapter 拒绝恢复。
   对原生文件，在 prepare 调用之间或 prepare 与 `tool.intent` 之间崩溃，
   需要先对账批次再进入 G1：按保存的 `runtimeCallId`、原幂等键/reference 和
   digest 重试/查询 prepare，恢复匹配的 `PREPARED` 预留，补写缺失的原 intent，
   提交完整的原 `await_runtime` 批次，再进入 G1。Broker prepare 使用
   `dispatch = false`，相同 key 的准确重放返回原 execution receipt。不能调用
   `prepareRequests()` 重建计划，它会生成新随机 ID。冲突或未知预留阻塞；完整
   批次及必要审批/Hook 证据持久化前不能派发。
6. 过期或取消时，通过 CAS 记录 Action 终态、关闭 `await_action`，如实配对已
   提交但尚无回复的调用记录，再写一个取消 Turn 终态。过期采用该取消结果，不
   在重启后再发模型请求。已提交决定赢得 Action 竞争；另外已经获准的 Turn
   cancel 仍阻止新派发，并结算/停止它实际欠下的工作。
7. 只有安全结算后才释放准确的 Runtime lease。释放失败按第 6 节作为可跨再次
   崩溃恢复的持久清理义务保留，不能因工具列表为空就释放不确定的 Hook 或后代 writer。
8. 崩溃后重复 resolve/load/cancel，先读已经提交的决定、checkpoint、原 intent
   与终态；既不再次询问，也不以替代 ID 执行。

resolve 路由继续在回答之前提交决定。Action response operation 可在决定持久
投影后完成，这不声称 Turn 或工具已经完成。决定提交后的失败不能把成功的 Action
回答改写为失败决定。Java 保留原 operation/key 并继续消费 Turn 事件；#13609
这类浏览器终态跟踪是该 operation 的独立消费者。

没有浏览器回答时，过期也必须有效：load 安装 deadline timer，对已经到期的等待
立即处理。每次重新附着都检查同一保存的 deadline，再次进程崩溃不能将其重置。

### 4.3 profile 与旧记录的边界

原生文件是首个验收目标。派发前的私有 Shell、MCP、Hooks 和 child-agent 批次
需要各自明确的续跑与所有权证据；已派发 Shell 保持拒绝。B2 不开启 H3、公开
Shell 或其他 domain。

旧 v1/v2 等待保持可读。只有旧 journal 和 producer 记录证明全部未付副作用
不存在或已结算时，才允许安全取消/过期。缺少完整可恢复批次的旧 Allow/Deny
保留现有拒绝，不通过重建当前内存静默升级。若后续需要兼容性重建，另设验收切片。
完成声明必须注明支持的 producer/profile 版本。

## 5. 切片 B：恢复尚未完成的主模型轮

### 5.1 发送前持久化请求

给主模型的 `model.attempt` 事件增加可选 `recoveryRef`，指向不可变的
`hosted-model-request/1` 资源。事件已有的 `routeRef` 与预算信息保留含义。
Hook-model attempt 不因此变为可重发。不要挪用也描述 tool/approval 输入的
`checkpoint.attempt.routeRef`，不修改 checkpoint schema。

| 请求快照                                                                                                 | 必要用途                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Session、原 Prompt、attempt、来源 activation、request digest 与 journal/history 边界。                   | 证明替换的是哪个已接纳请求。                                      |
| 原有效 Prompt/request Parts，以及规范化的模型可见 history/system instruction ref。                       | 恢复 Hook 改写输入、压缩上下文和已消费结果，不重跑 startup Hook。 |
| 固定的 model route、sampling、definition/config/capability/profile revision 与 tool declaration digest。 | 按原契约重发；pin 改变或不可用时 fail closed。                    |
| Workspace context revision/content ref 与已完成 Hook-context 引用。                                      | 避免读取不同 Workspace 或 Harness 主机的新指令。                  |
| 原 budget 状态、round ordinal 与 request kind。                                                          | 替换后保留 Turn 限制，不重置 16 轮循环或成本预算。                |
| 先前结果与 producer 义务的所有权/续跑证据。                                                              | 证明没有跳过或重新创建未消费副作用。                              |

在 `LlmChat` 的最终逻辑请求边界，用窄的、可等待的 callback 捕获已经准备好的
无鉴权 provider 请求：自动压缩、tool-history 修复和输出 token 调整之后，
generator 发送之前。在 `sendMessageStream()` 之前仅复制 Hosted 层输入不足以
满足要求。Hosted 调用者为每个主请求提供该 callback，普通调用者维持已有行为。
网络请求之前必须完成快照发布与 `model.attempt: started` 提交。把主 attempt
现有的发送前 `started` 写入移到该 callback，以标识实际发送的请求。工具之后，
用持久提交/结算的结果及已完成 Hook 输出生成下一快照。保留现有结果消费时序：
仅在模型成功 `Finished` 后推进，不在该请求之前推进。不保存模型凭据、鉴权 header
或 OAuth token；使用当前凭据解析固定 route。资源引用验证 digest 与长度，并
沿用 inline/transaction 限制。如果 descriptor 或新请求数据不引入分块/存储
机制就无法容纳，将该请求标为不可恢复，写入不含 `recoveryRef` 的旧格式兼容
attempt，维持普通存活进程的推理。崩溃后保留 `model_start` 拒绝，不声称该请求
可恢复。Store 故障不是大小分类，不能静默降级持久化屏障。不增加 OSS spill 或
新的分块机制。

保存规范化 generator 参数、history 状态和原 stream owner namespace。
saved-request 入口按这些参数直接调用固定 generator，跳过
`sendMessageStream()` 的普通 history repair、压缩、context injection 和
Prompt 准备。保留正常响应处理、usage 记录、取消与工具输出验证。该响应提交后，
下一逻辑轮用恢复的 history/budget 回到正常循环。
参数字节等价的 transport retry 可复用快照。fallback 切换 route、reactive
compaction 或 token 调整改变有效请求时，必须在发送前建立新的不可变快照和
attempt 边界，不能覆盖 ref 或把 fallback 请求归到前一个 attempt。这不增加
原逻辑轮 allowance。中断的压缩或 Hook-model 工作缺少完整证据时保持拒绝。

发送前，把每个 attempt 绑定到独立预分配的 stream message ID；将该映射与
保存的 attempt 身份一起记录，与规范化 request digest 分开。恢复时除快照内
budget baseline，还要恢复最新已提交 usage/model-metrics ledger，避免流完成
但 assistant commit 丢失时忘记已记录用量。崩溃 provider 调用的未知用量无法
重建；重复推理可能增加 provider 成本，恢复不保证外部计费上限精确执行。

恢复沿用已经提交的绝对 `input.accepted.deadline`，准备替代请求不能开启新的
`deadlineMs` 时段。如果 admission 已提交但 prepared-request 快照尚未提交，
首个模型切片保持拒绝。覆盖这一更早窗口需要另一个持久初始 Turn preparation
plan，请求快照本身不提供该能力。

### 5.2 只重发保存的未完成请求

1. 找到唯一未结算的原 Prompt 及其最近主模型请求。验证请求身份、引用的历史和
   pin、当前 writer，以及该 attempt 没有已提交输出或未付 producer 副作用。
   `initial` 或 bootstrap checkpoint 本身不能作为证明。
2. assistant 输出/调用消息若已持久提交，则恢复它的待付工作或终态投影。不能
   重发产生该调用批次的模型请求来丢弃已经接纳的批次。
3. 将原 `started` attempt 按原身份标为 abandoned；已经记录流完成状态时保留
   该事实。两种情况下，新请求快照都标识被替换的 attempt。从 journal 恢复它的
   streamed message ID、原 boot/epoch namespace 及有界 delta sequence，结合
   保存的 owner 证据，在新输出前提交必要的
   `message.retracted`。一个新建的空 `HostedTextDeltaStream` 无法撤回前任
   内存中记住的 prefix。
4. 为保存的同一请求开启新 attempt，分配新 message ID，并引用同一 request
   digest。撤回响应丢失或撤回后发送前再次崩溃，通过同一 journal command 重放。
   发送后崩溃可能产生另一轮模型推理，不承诺推理 exactly-once 或再生成答案相同。
5. 使用恢复的 history、request kind、budget 和 round ordinal 调用保存的规范化请求
   入口。不得把普通 `executeHostedTurn` 作为新 Prompt 调用：它可能再写用户
   记录、重跑 Prompt Hook。无工具 Session 使用同一 saved-request 路径，工具
   声明为空。
6. 新模型产生的工具经过正常审批与持久工具准入。先前已提交调用/结果保留在历史
   中并沿用身份。发送前观察到取消则不发送；发送后取消则中断推理，并阻止新工具
   准入。

扩展 journal 撤回：提议在 `message.retracted` 中增加可选 `sourceBootId`、
`sourceEventEpoch`、`throughSequence`，连同已有 message ID 和
`fromSequence` 标识原 namespace 与有界消息范围，并用 journal/owner 证据验证。
撤回已经在原 namespace 投影的 prefix，以及同一 journal message/range 在
后续 attachment namespace 下重放的副本。journal reader 也对该消息应用撤回，
cold replay 不能让它重新出现。现有 in-band 撤回只选择当前 boot/epoch，无法
删除已消费的旧代数 prefix。不能调用会清除旧 Turn/epoch 全部 delta 的
`retractContinuationOutput()`，否则先前已提交轮也被删除。撤回与已消费游标推进
原子且幂等。覆盖已消费、未投影及跨两个 namespace 的 prefix，保留此前全部已
提交轮。

维持现有同代数重试语义。本切片允许在 fencing 证据下进行替代代数的撤回，不让
已经发布的同代数 continuation 自动变为可重放。

尚未完成且缺少 `recoveryRef` 的旧 attempt 保留 `model_start` 拒绝。已完成主 attempt 后若存在持久 final assistant 答案，即使没有请求快照也可仅补偿终态，且不重发推理。新快照 producer
必须覆盖每个被支持的主模型请求；仅增加 reader 或没人填充的 optional parameter
不代表交付。

## 6. 切片 C：闭合终态投影与事件游标缺口

复用 `settleProjectablePromptId` / `runSettleProjection`、sink 的终态身份和
Java 的现有 epoch CAS。首先增加故障覆盖，只对门禁证实的失败修改生产代码。

- 已提交的 `turn.settled` 只重放，不重新计算。仅依据完整、可投影的 checkpoint/
  output 及 producer 证据补偿缺失终态。Action 决定不是 Turn 完成证据。
- 重绑改变 boot ID 和 event epoch，保留 Java 最后**已消费**的 journal sequence。
  attachment tail 只是观测，不是消费 receipt，不能把游标跳到该 tail。
- 撤回先于新 attempt 的 delta 落 journal。Java/公开重放和浏览器刷新删除前任
  prefix、保留替代答案，且只有一个终态事件。沿用现有 `fromSequence` 语义，不
  删除以前已提交轮，不在恢复时伪造 message ID。
- 重放已准入的 prompt/continue/cancel，返回原 admission watermark，不返回
  当前 tail。重复终态投递幂等推进消费者，不再调用模型或工具。
- 终态提交与物理清理是独立事实。lease release、file-history marker retirement
  或 producer cleanup 失败时继续欠付。Java 不能把已完成 Turn 改解释为错误，
  新 Turn 也不能绕过受影响资源的 fence。cold restore 必须找到该义务。

提议一个窄的 `hosted.cleanup` journal 事件，含 `cleanupId`、`descriptorRef`
及 `owed` / `confirmed` 状态，引用不可变 `hosted-turn-cleanup/1` descriptor。
它标识原 Turn、Runtime Session/binding owner，以及适用的原生 file-history
marker ID。这是 Turn 清理记账，不是通用任务 domain。仅在原所有权确实欠付清理
时提交 `owed`；无工具 Turn 不为该协议创建 Runtime Session。在 adopt/acquire 恢复的
lease 之前、terminal/release 路径可能丢失该身份之前提交 `owed`。只有 journal
与 producer 证据证明安全结算后才清理。release 使用原 `runtimeSessionId`；只有
Broker 返回 `released = true` 且全部指定 marker 确认后，才按同一 cleanup ID
提交 `confirmed`。已为 `RELEASED` 的 Runtime Session 可幂等 release，无需
再次 acquire。通过查询/重试原身份对账部分成功和丢失回答。仍有在飞工作、证据
未知、身份缺失或 binding 漂移的 owner 继续 fenced。保存 `owed` 失败则不进行新的 acquire/release；
已提交终态仍具有权威性。

cold load 与 lifecycle-close 对账即使没有 `unsettledPromptId`，也枚举未确认
的 `hosted.cleanup` 事件、恢复原 owner，只重试有资格的清理。确认前保留受影响
Workspace/resource fence。requested 审批仍占有 lease，不能仅因存在 marker
就释放。内存 `runtimeLeaseHeld` / `refusedAdoptions` 可调度重试，但不是持久
证据。旧清理身份缺失或 Hook/后代停止证据不确定时阻塞清理，不重标已提交终态。

## 7. 协议归属与兼容性

不需要新的公开 REST/WebShell 路由。现有私有 load、resolve、cancel、events
路由仍属于 live Session owner；Workspace 和 Runtime 调用仍位于持久 binding
和原执行 owner 内。scope 未解析时，任何路径都不能回退 primary runtime。

最简单的控制面路径是现有 plain attachment 加事件重放：Harness 拥有恢复后的
model/approval driver，Java 消费它们的 journal。不把这些状态伪装成含虚构
execution 的 Runtime recovery report，也不增加通用公开 recovery-kind 开关。
G1 工作继续使用已有 Runtime report/continue/cancel 协议。

Harness 宣告 `hosted_approval_resume_v1` 与
`hosted_model_round_recovery_v1`，Java SDK 暴露协商后的 feature。它们描述支持能力，
不选择新的公开恢复路由。已有 DRIVE load 在 Harness 中检查持久证据；Store 的版本
支持回执与阅读门槛负责格式兼容性。兼容的旧栈保留已有拒绝。一旦 Session 写入第三步
的新记录格式，必须在旧 Harness 附着之前执行阅读门槛，不能
等解析失败再处理。使用已有
`qwen_managed_session_journal_head.storage_version` 作为单调门槛：reader
支持 1 和 2；首次提交 v3 options、最终批次计划、model recovery data、跨代数
有界撤回或 cleanup 的事务与记录一起原子地把 head 提升到 2。
checkpoint schema 仍为 1，改变的是存储 envelope 的阅读契约。

通过一个 HTTP header 传递提议的 `maxReadableStorageVersion` 契约：
`X-Qwen-Managed-Max-Readable-Storage-Version`，省略为 1，新 reader 发送 2。
共享 TS Store client 在全部 head-scoped 请求中携带它：acquire、renew、restore、
transaction 枚举、resource read、commit、publication、recovery 和 lifecycle，
包括绕过 JSON wrapper 的请求。Store 先检查服务器支持的 head 格式，再在授予
lease、读取或写入前检查调用者上限。提升格式的 commit 在 head lock 内检查
ceiling 2，幂等重放前也检查；旧的有效 token 不能绕过门槛。不增加 grant table
或 token capability 状态。重放返回原 commit；
回滚或删除临时模型状态不能降低门槛。在同一提升事务内验证 writer/lease 与 head
CAS。旧 Java 的 `requireHeadScope` 和旧 TS restore 都拒绝非 1 的 storage
version；新协议还必须在旧 Harness 取得 writer lease 前，拒绝它访问新 Java
Store 中的不兼容 Session。即使只宣告一个执行 feature，也先落地全部第三步新格式的
reader/Store 支持，再开启任一 producer。使用已有 SQL 列，不新建表，不猜测
Flyway 预留号。实际冻结契约 revision 随落地基线同步。

Writer acquire/renew 回执声明 `supportedStorageVersion: 2`；TS 客户端把缺失支持视为 1。新格式提交必须取得该回执，并使用 `/transactions:commit-v2`，复用新版 Store 的同一原子提交实现。旧 Store 没有这个入口，即使此前 acquire 请求命中了新服务，也会拒绝此提交。这补齐反向混部署边界：旧 Store 原本会接受任意 model-attempt payload，却不提升 head 的读取版本。续租会刷新该回执。使用 publication token 的 Worker 提交保留其原始 admission 协议。

开启 producer 前，TS/Java validation、snapshot/restore、Hosted-layout
verification、W1b bundle 枚举、W1c profile/layout 检查与 retention reader
必须追踪全部新 ref。维持普通 inline resource 的 64 KiB 和 8 MiB transaction 限制；
共享、缺失、损坏、外部嵌套 ref 不能误通过引用清点。不开启物理 GC 或新存储后端。

## 8. 交付顺序与依赖

| 独立切片         | 交付物与退出条件                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3.3-A，B2       | 先 options/continuation reader，再 producer 与停靠审批 driver。Requested → Allow/Deny/Cancel/expiry、丢响应与决定后崩溃能完成原原生文件 Turn，或如实阻塞；安全清理结算后下一 Turn 与 close 可用。 |
| G3.3-B，模型轮   | 先主请求快照和阅读门槛，再工具/无工具会话的模型重发与撤回。原输入准入一次，先前工具执行一次，两次替换仍保留 budget/history。                                                                      |
| G3.3-C，终态闭环 | 围绕现有投影增加真实进程/游标与清理故障门禁；只有门禁暴露缺口时才落地有界生产修复。                                                                                                               |

C 门禁是 A、B 被接受前的条件，不允许先发布带已知 cursor 或 cleanup 错误的
切片。仅剩独立覆盖或有界已证修复时，才适合单独提交最终 C PR。

全部切片在开启新记录 producer 前可分别评审和回滚。新记录出现后，回滚必须遵守
其阅读门槛；单纯源码 revert 不会让旧 reader 变得兼容。

每个实现都基于实际落地 main。G1 合入后状态/取消/清理修复归 [#13188][g1fix]；
依赖其已落地契约，或明确协调必要重叠，不复制其分支。原生文件/无工具第三步不
等待公开 Shell、H3 开启或普通本地 M6。对应恢复情形才要求 H1/H2/H4 producer
证据。更广的 Q2 binding fencing 是独立门禁，整体 Stage G tracker 继续开放。

## 9. 验证与验收

实现为 packaged-stack runner 增加确定性的 fixture barrier。使用真实
Java/MySQL、Harness、Broker 和 Runtime 操作；model fixture 计数请求与工具，
控制准确的崩溃边界。该 fixture 足以证明编排，不等于真实 provider 验收。先仅
替换 Harness，保留 Spring 与生产 lease/timeout；另行在 Linux 替换两侧 owner。

| 门禁                                                     | 必须观测到的结果                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1 requested approval → Allow / Deny                     | Action/input/decision 身份相同；Allow 派发一次，Deny 对该调用派发零次；原 Turn 结算，后续 Turn 完成。                                     |
| A2 Cancel / expiry / 无浏览器                            | deadline 不重置；等待关闭，一个取消终态及真实配对记录；所有权结算后 `close 202` 与下一 Turn 成功。                                        |
| A3 混合调用与输入改写                                    | 先前决定保留；待付 sibling ID/顺序恢复；再次批准的输入不继承早期 Allow；已完成 Hook 不重跑。                                              |
| A4 决定/load 响应丢失                                    | 原 response operation/key 结算一次；只有一个 driver，不新建审批；重放不重复副作用。                                                       |
| A5 决定、wait 推进、最终计划、prepare 与结果提交后的崩溃 | 各 barrier 恢复正确阶段；最终改写计划、原 ID 与 Runtime status 证据优先于最初审批 descriptor。                                            |
| A5a 部分 prepare / 缺失 intent                           | 按原 ID/digest 对账原生预留；完整批次 checkpoint 先于 dispatch/G1。冲突阻塞，不分配替代 ID、不重复文件副作用。                            |
| A6 MCP/Hook/child 不确定性                               | 缺失或未知 producer 证据阻塞；不重新创建外部调用，不静默释放 Workspace lease。                                                            |
| B1 首轮，有/无工具                                       | 只有一个原 admission 和 user record；新推理 attempt 可以完成；无工具不需要 Broker dispatch。                                              |
| B2 streamed prefix 与两次替换                            | 新 attempt/stream 身份；新 delta 前持久撤回；live view、reload、replay 只保留存活答案和一个终态。                                         |
| B3 先前工具之后                                          | 使用保存的 results/history；各先前 execution 一次；轮数和成本 budget 不重置。                                                             |
| B3a Finished 与持久输出                                  | 流 Finished 后、assistant commit 前崩溃，可在证据完整时重发；assistant commit 后崩溃不再推理。不能用 attempt 状态名称证明输出持久性。     |
| B4 已提交 assistant call 输出                            | 不跨过未付调用重发模型；驱动保存的 approval/batch 或既有 Runtime recovery。                                                               |
| B5 snapshot 故障、pin 漂移与取消                         | ref 缺失/损坏/过大/外部或 config/authorization 漂移不产生新副作用；Store 故障重试；取消阻止新派发。                                       |
| B6 fallback / reactive compaction                        | 规范化参数改变时发送前建立新 snapshot/attempt；等价重试复用快照。saved-request 重发不重新准备或注入 context，逻辑轮 budget 保留。         |
| C1 终态已提交但未投递                                    | boot/epoch 改变，已消费 cursor 不动；终态重放一次；模型/工具调用零次。                                                                    |
| C2 checkpoint 可偿付但缺少终态                           | 崩溃/丢响应下补偿一次；证据损坏时不发明结果。                                                                                             |
| C3 清理失败后再次崩溃                                    | 原清理身份仍可发现且 fenced；重试清偿；已完成 Turn 仍为已完成。                                                                           |
| C4 原 admission 响应丢失                                 | 对账原 command/prompt，不再次准入；重放原 admission watermark。                                                                           |
| R1 冻结旧 writer / 不支持的 engine                       | 旧 writer 不能 append/dispatch；保留类型化 engine 拒绝与不回放 Legacy。这不认证存活旧 Spring 的 binding fencing。                         |
| R2 新旧 reader 与 storage bundle                         | v1/v2 与旧 model attempt 保持可读并如实拒绝；门槛拒绝不兼容 acquire、renew、读取、写入与重放，包括旧 token；bundle/restore 引用闭包通过。 |

每个物理/工具断言都检查实际文件、SQL execution 行、journal ID 和 model fixture
流量。删除 dispatch-count、cursor 或 next-Turn 断言必须让门禁失败；HTTP 200
或单测绿色本身不是验收。保留最初失败的 fixture 运行，报告实际证据边界。
local JSONL/H2 测试是额外覆盖，不是 MySQL/Linux 物理停止证据。

### 9.1 已验证的实现证据

不可变的 `linux-rebased-gates-3` 打包产物在 rebase 和集成修正后，各模式的首次运行中通过 Allow、Deny、Cancel、expiry 和模型续写。环境为 Linux aarch64，Node 22.22.1、Java 21.0.12.1、MySQL 8.4.11。可移植 Node bundle 和 Java JAR 在 macOS 构建后于 Linux 执行。真实 Java 控制面、Broker 和 Runtime Worker 保持存活，仅替换 Harness；推理使用受控的本地 OpenAI fixture。门禁结束后，两端的 1387 个产物 hash 均保持一致，生产源码未变化。此前的 `linux-delivery-gates-2` 结果保留为前一 main 基线的历史证据。

Allow 保留原 Action、prepare key、request digest 和 Runtime binding，产生一个 dispatch generation 为 1 的 settled execution，并写入预期文件内容。Deny、Cancel、expiry 均无 execution、无文件；expiry 沿用原 deadline。模型续写保留原 execution，重发相同的规范化 provider 请求内容，并撤回先前已公开可见的部分输出。每种模式都确认原 owner 清理，完成后续 Turn，观察到两轮合计恰好两个终态，再完成 close 202 准入并达到 Session closed 状态。

定向验证通过 841 条 core 测试和 111 条共享契约测试。扩展后的 CLI 运行通过 779 条，并暴露三条不符合契约的旧审批 fixture 记录；修正 policy、选项标签和资源 kind 后，受影响套件的全部 60 条测试通过。重复的 13 文件运行通过 782 条中的 781 条；未修改的 Hosted 模型集成套件有一次 `ENOTEMPTY` 临时目录清理失败。该套件全部 8 条测试在单独复跑中通过，因此 782 条测试均有分次通过证据；不声称扩展批次全绿。新一轮 Java 验证通过 1522 条 Server 测试、跳过一条，另通过 55 条 SDK 和 159 条 Broker 测试。build、typecheck、bundle、源码 ESLint 和三个 Java 模块的 Checkstyle 均通过。源码 lint 排除生成的 Maven `target` 与测试 `coverage` 产物。此前基线和扩展运行中的失败诊断均保留。

集成回归证明：模型请求准备失败时，普通 prompt 路由和 wake driver 均保留已准入、未结算的输入；渠道中断结算仅在终态与 file-history 退役之后确认原清理 owner。首次释放失败时保留清理 fence，随后 passive resident attachment 释放相同 binding/generation，只新增一次确认，不重复终态。独立 Spring/H2 probe 通过有界撤回与 replay floor 的组合：snapshot 重建期间 reader 保持可用，覆盖范围追平后旧 cursor 再次过期。这项 probe 不属于 MySQL 或进程接管验收。

机器可读报告、manifest 和保留的失败诊断位于 `.qwen/investigations/g3-step3-implementation/`，当前汇总报告为 `packaged-verification.md`。这五种打包门禁不证明上述整个矩阵。首个无工具请求崩溃、两次替换、部分 prepare 崩溃、响应丢失、损坏/外部 ref、快照超限与清理崩溃，仅有定向测试或故障探针覆盖，或仍属于更广的打包验收工作。两侧 owner 重启、真实 provider、真实混版本集群和 Q2 旧控制面 fencing 仍独立处理。

## 10. 实现范围

| 区域                 | 预期路径与职责                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 编排             | `hosted-harness-session.ts`、`hosted-runtime-recovery.ts`：注册停靠 driver、模型恢复入口、cancel/expiry 调度、复用投影与原所有权。                                                                                                                    |
| 审批/原生工具        | `hosted-tool-approval.ts`、`hosted-workspace-tool-turn.ts`：options v3、continuation producer/reader、准确批次续跑，不重放 Hook/参数。                                                                                                                |
| 模型与流式输出       | `hosted-harness-model.ts`、`hosted-text-deltas.ts`、core `core/llm-chat.ts` 及其 call-options 类型：prepared-request callback、saved-request 续跑与从 journal 恢复撤回身份。                                                                          |
| Core journal         | `managed-hook-activation.ts`、`managed-session-records.ts`、共享 schema/fixture、`http-managed-session-store.ts`：主 attempt 可选 recovery ref、最终批次计划、有界撤回、Turn 清理记录、递归引用闭包及逐请求 version ceiling，checkpoint v1 保持不变。 |
| Java 控制面/Store    | `ManagedActionStore`、Session-store validation/reference reader、`QwenHostedHarnessConnector`、`HarnessCoordinator`：v3 投影、阅读门槛与 plain-attach/cursor 契约；`ActionResponseCoordinator` 保留 decision-operation 语义。                         |
| 其他 reader/producer | Hosted layout/W1b/W1c reader；仅在支持续跑证据时修改 Hook、MCP、child 与 file-history adapter。审计每个声明字段的 producer 和全部读取处。                                                                                                             |
| 验证/文档            | 邻接测试、packaged E2E runner/CI、双语设计和 developer event schema；未通过各自验收前，不升级公开契约实现状态、不启用部署。                                                                                                                           |

## 11. 已定决策与实现待验证项

决策：先完成 B2，再扩大模型恢复；重启后保留 requested Action；Allow/Deny
驱动保存的批次，Cancel/expiry 安全结算；仅重发持久主模型请求；使用 plain
attachment 和现有 journal feed；保留 checkpoint v1 与原 Runtime recovery；
不能只因完成这些功能就关闭 Stage G tracker。

每个切片输出新记录前，必须验证持久 storage-version 门槛并补齐 nested-ref
reader。宣称某个 producer 被支持前，证明其保存输入、已完成 occurrence、原 owner
和停止/结算证据。这些是实现门禁，不允许从当前环境补猜缺失证据。真实 provider
验收、多实例 binding fencing、公开 Shell 开启、跨主机停止/所有权证明及生产事件
pruning 都另行处理。

## 12. 引用

- [Stage G tracker #12952][g] 与[架构 proposal #12380][proposal]。
- [已合入的 G3 第 1–2 步 #13174][g3] 与[明确的 B2 后续决定][b2]。
- [G3 第 1–2 步设计](2026-10-02-hosted-replaceable-harness.zh-CN.md)。
- [Actions 设计](2026-09-30-managed-agent-actions.zh-CN.md)。
- [Hosted Hooks 设计](2026-09-30-managed-hooks-runtime.zh-CN.md)。
- [交付账本](managed-agent-delivery-ledger.zh-CN.md)。
- [G1 合入后修复 #13188][g1fix]。

[g]: https://github.com/QwenLM/qwen-code/issues/12952
[proposal]: https://github.com/QwenLM/qwen-code/issues/12380
[g3]: https://github.com/QwenLM/qwen-code/pull/13174
[b2]: https://github.com/QwenLM/qwen-code/pull/13174#issuecomment-6030365600
[g1fix]: https://github.com/QwenLM/qwen-code/pull/13188

### 审阅修正

本机取消立即触发 abort。若持久化追加失败，接口返回 503：当前进程停止，但取消尚未持久化，需要重试后才能依赖替代进程恢复。清理按请求的 Turn 区分其它 Turn 的债务，只有确认原 owner 释放后才清除持有租约标记。wake 输入 ID 使用与普通 acquire 相同的路径安全 Runtime 映射。暂时清理故障继续阻止新工作，直到 attachment 重试成功后解除清理阻塞。

准备请求时，防御性克隆限定为 64 KiB；超限的借用视图由 Hosted publisher 同步序列化并拒绝保存，不予保留。恢复的 generation 配置只在其请求期间生效，历史恢复执行常规 registry 对账。Hosted 引用闭包校验在每个事务中共享一次引用 memo 与已验证资源缓存；引用元数据冲突检查和完整事务 census 仍保持生效。
