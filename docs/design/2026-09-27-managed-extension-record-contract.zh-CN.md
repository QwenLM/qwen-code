# Managed 扩展记录契约(H0b)

[English](2026-09-27-managed-extension-record-contract.md) | [简体中文](2026-09-27-managed-extension-record-contract.zh-CN.md)

状态:契约已定义;自 H0c 起由 Session authority 提交这些记录([设计](2026-09-27-managed-extension-authority.zh-CN.md)),目前尚无 Stage H domain 开放提交。H0c 在尚无任何生产方之前补充了一条规则:`running` 或 `waiting` 的运行不能建立在从未开始的执行之上,并附带四个手工标注的拒绝用例;[#13300](https://github.com/QwenLM/qwen-code/issues/13300) 的 H0c 后续随后映射了本页描述的"从未被认领"的 `cancelled` 结算。更新日期:2026-10-04。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H0b 切片,属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。下文的"参考设计"指该提案[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)的第 3、10、12、13 节,并包括其[私有控制协议](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-control-protocol.md)中的 `OperationGrant` 与[Session 存储设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md)中的 domain 索引,版本为 #12827 固定的提交。

## 问题

H 阶段把七项能力接入 Managed 路径:MCP、Hooks、后台 Shell 与 Monitor、子 Agent/workflow/team、Channels 以及自动化。在这条路径上 Runtime 可能被回收,Harness 也可能被替换,因此参考设计要求每项异步能力都是"持久资源加触发意图",具备稳定身份、回执和统一的任务投影。如果每个切片各自定义运行状态、维护授权、失败原因和身份规则,Java、qwen 与 Runtime 对"unknown"或"settled"的理解就会各不相同,任何投影都无法把它们合并。

与 attestation、Tool v2、`managed-context/1` 和 `managed-tool-result/1` 契约一样,H0b 在任何组件提交这些记录之前,先定下七项能力共用的记录。之后由 H0c 随 Session authority 提交它们,并据此重建任务列表。

## 现状

以下事实基于 `main` 的 `88d881491b`。

- **domain 索引。** `packages/core/src/managed-runtime/managed-session-records.ts` 有一份包含 32 个名称的封闭 domain 索引。`domain.committed` 携带 kind 为 `managed-<domain>`、schema 版本为 1 的 `recordRef`。只有 `goal_state`、`session_metadata`、`file_history`、`session_source` 开放提交。存储设计的 v1 列出了 33 个名称,缺少的是 `monitor_run`,其 validator 被划给 H0。
- **domain 记录。** `LocalManagedSessionAuthority.commitDomainRecord` 发布记录正文时在调用方内容外加上 `operationId`、`revision` 和 `previousRecordRef`,并且每个 domain 只保留一条修订链。
- **fence。** `ManagedActivationFence` 已存在于 activation store、Session inbox 和内嵌 Harness 调度器中。代码中没有 `OperationGrant`、`WakeIntent`、outbox 或 `SessionTaskView`。
- **Java。** 控制面的 Session Store 把 authority 日志作为不透明的事务记录保存,没有 domain 记录。在 Runtime Broker 中,每个 `RuntimeBindingRecord` 对应一个物理 Runtime 代:替换时获得新的 binding ID 和下一代 generation。Broker 的工具执行账本有一条同类的状态线:`PREPARED`、`DISPATCHING`、`EXECUTING`、`CANCEL_REQUESTED`、`SETTLED` 和 `UNKNOWN`,但并非逐步对应。`EXECUTING` 在 Runtime 收到调用之前就已进入,因此它对应 `dispatch_started`。被取消的 `PREPARED` 调用,以及在发送前就看到取消请求的 `DISPATCHING` 调用,都未经发送即以 `cancelled` settled;发送后才被取消的调用也可能依据 Runtime 自己的结果以 `cancelled` settled。因此,`SETTLED` 且为 `cancelled` 的记录既可能是从未发送的调用(对应 `not_started_proven`),也可能是已发送后被取消的调用(对应 `settled`)。记录台账自身就能区分从未发送的情况:`ToolExecutionRecord` 要求被认领派发的代数为正,因此一条状态为 `cancelled`、且 `dispatchGeneration` 为 0 的 `SETTLED` 记录就证明调用从未被认领。(这一证明由 #13300 的 H0c 后续落地:这样的记录映射为 `not_started_proven`——与上文 `Contract.` 各条一致的过去时;`dispatchGeneration` 为 0 的 `PREPARED` 或 `ABANDONED` 记录映射到别处。)但没有字段记录已认领的调用是否进入过 `EXECUTING`,因此已认领后以 `cancelled` 结算的调用保持 `settled` 映射;要区分这部分残留,需要 settled 记录之外的证据,由接入该映射的切片提供。映射仍然不能把无法证明未发送的调用映射为 `not_started_proven`:契约会拒绝 `intent → settled`,却发现不了记录无法证明的 `not_started_proven`——`cancelled` 或 `failed` 的 monitor 运行会接受它,MCP 也明确允许这一组合,但 `child_run` 要求一个 `cancelled` 的运行其执行状态为 `settled`,而执行线从 `intent` 到不了 `settled`——而这种映射会把可能已经执行的工作说成从未开始。
- **Legacy Monitor。** `MonitorRegistry` 在内存中保存 monitor,状态为 `running`、`completed`、`failed`、`cancelled`。`MonitorTool` 把 `max_events` 上限定为 10,000、`idle_timeout_ms` 上限定为 600,000,并记录 monitor 停止的原因:spawn 错误;启动之后的非零退出码、信号、二进制输出或流错误,这些同样以 `failed` 结束;自然退出、达到最大事件数或空闲超时;或被请求停止。

## 目标

- 定义 `OperationGrant`,以及 Runtime 的按操作门禁何时可以用一个 grant 替换另一个。
- 定义三条状态线(逻辑运行、物理执行、交付与接收)、各自允许的单步迁移以及把它们联系起来的规则,作为每条 H 阶段记录都内嵌的一个运行块。
- 定义运行可以携带的恢复原因与配额原因。
- 定义稳定身份(`executionCallId` 或 `effectId`、`dispatchId`、`deliveryId`)与 Runtime 绑定,以及它们可以如何变化。
- 定义 `definitionRevision` 固定及其一致性规则。
- 定义 `monitor_run` 的记录正文及其修订规则,并登记该 domain 但不开放提交。
- 用一份 TypeScript 与 Java 都回放的共享 schema 和 fixture 文件固定上述全部内容。

## 非目标

- **提交。** 没有 authority 提交这些记录,也没有 outbox、`WakeIntent` 或 `SessionTaskView` 投影。这些由 H0c 完成。
- **开放提交。** `monitor_run` 加入索引但仍不开放提交;开放某个 domain 的提交仍是单独、显式的一步。
- **其他正文。** 其他 H 阶段 domain 的记录正文,以及各 domain 登记的 phase,属于 H1–H6。
- **公开 API。** 任务资源及其错误属于 H0a。
- **运行路径。** 不改动 Harness 循环、Broker、worker 或路由。

## 决策

1. **`monitor_run` 加入封闭的 v1 索引**(#12827 的问题 1)。在固定提交的存储设计中,它是 33 个 v1 名称之一,只把它的 validator 留给 H0。由于该 domain 仍不开放提交,也没有代码写入它,任何 v1 reader 目前都不会遇到 `monitor_run` 记录,因此索引保持原版本。原本只有 `commitDomainRecord` 检查 domain 是否开放:authority 通用的 `appendExecution` 与 `appendExecutionEvent` 接受 `trusted_entry` actor 提交的、索引中任何名称的 `domain.committed` 事件;H0c 现在已把这项检查执行到提交 domain 记录的每条路径上——domain 记录只能通过 `commitExtensionRecord` 提交,而在此路径与通用追加路径上,未开放的 domain 都被拒绝提交。本变更之前的 reader 会拒绝这个名称,因此 H3 开放该 domain 时,含有这类记录的 Session 必须把这些 reader 挡在外面,例如提高其 `minimumReader`。该名称按设计中的顺序放在 `memory_job` 之后。
2. **一个运行块,由每条记录内嵌。** 共用的状态线、原因、身份、绑定和固定组成每条 domain 记录内的一个封闭 `run` 对象,而不是单独的 domain。H0c 据这些运行块重建 `SessionTaskView`。
3. **Java 消费方位于控制面。** 参考设计第 1 节把产品级记录和任务投影交给 Java。无论由哪一侧提交记录(问题 2),Java 都要读取它们来构建投影,因此 `ManagedExtensionRecords` 放在 `managed-agent-server` 中,并像该模块其他代码一样读取 Jackson 树。
4. **每次修订每条线最多前进一步。** 后一次修订可以让每条状态线保持不变,或前进一个允许的单步;执行线从 `intent` 进入,交付线从 `planned` 进入。这样每一步及其依据的证据都在下一步行动前已经提交。若接受任何可达状态,`unknown → sending` 就能以 `unknown → partial → sending` 的名义通过,而部分交付从未被记录,这正是参考设计禁止的重发。

本文不决定 #12827 的问题 2 和 3,它们关乎 H0c。对于问题 4,H0b 不改变任何运行路径,可以先于支持工具的 Hosted 回合合入。

## 取值规则

| 规则        | 取值                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| id          | Managed Session 稳定 ID 规则:非空字符串,至多 512 个 UTF-8 字节,格式良好,采用 NFC,不含 C0、DEL 或 C1 字符。         |
| count       | 0 到 2^53−2 的 JSON 整数,即 Managed Session 序号规则。                                                             |
| revision    | 从 1 开始的 count。                                                                                                |
| time        | UTC Unix 毫秒,0 到 8.64 × 10^15 的 JSON 整数。                                                                     |
| generation  | 1 到 2^63−1 的规范十进制文本,即 W0a 对 `workspaceGeneration` 的规则。generation 按数值比较,从不按文本比较。        |
| digest      | 64 个小写十六进制字符。                                                                                            |
| durable ref | `DurableRef` 的五个字段:`resourceId` 与 `kind` 为 id,`schemaVersion` 与 `byteLength` 为 count,`digest` 为 digest。 |
| phase       | `[a-z][a-z0-9_]{0,63}`,即恢复设计中 phase 名称的形式,例如 `send_segment`。                                         |

下面的每条记录都是封闭的 JSON 对象:每个键都必需,可以为空的键取值 `null`。小数部分为零的数字(例如 `1.0`)视为与之相等的整数,这与 JSON Schema 的 `integer` 和 JavaScript 的处理一致;生产方仍写普通整数。数字按默认 JSON 解析器得到的 IEEE-754 double 判断:即 JavaScript 的解析器,或 Java 中 Jackson 的默认 mapper;超出 double 范围的数字不是整数。NFC 按各运行时自带的 Unicode 数据判断,JDK 21 支持 Unicode 15,Node 22 支持更新的版本,因此对 Unicode 15 之后才分配的字符两者可能结论不同;标识符必须限于 Unicode 15 已分配的字符。

## 操作授权

`OperationGrant` 让已受理操作的 owner 在没有模型 activation 的情况下完成计划中的 phase:回合结束后的 Channel 发送、配置安装、历史维护步骤、Monitor 重建。它从不授权模型调用或新业务,也不是第二个 Session epoch。

| 键                    | 规则                                                 |
| --------------------- | ---------------------------------------------------- |
| `sessionKey`          | `tenantId`、`workspaceId`、`sessionId`,均为 id       |
| `operationId`         | id                                                   |
| `domain`              | v1 domain 索引中的 33 个名称之一                     |
| `operationRevision`   | revision:authority 对该 grant 的控制版本             |
| `ownerId`             | id:持有该 grant 的 owner                             |
| `workspaceGeneration` | generation                                           |
| `resourceScope`       | `recordRef` 与 `phases`,见下文                       |
| `leaseDurationMs`     | 1,000 到 300,000,即持久 Session 存储写者租约的上下界 |
| `expiresAt`           | time                                                 |

- **范围。** `recordRef` 是保存该操作计划的已提交 domain 记录。其 kind 必须是 `managed-<domain>`、schema 版本必须为 1,这与 `domain.committed` 已有的配对要求相同,因此 grant 不能指向其他 domain 的计划。`phases` 列出该 grant 准入的、该计划中 1 到 16 个互不相同的 phase。一个 domain 有哪些 phase,在 H1–H6 中随其正文登记;H0b 只固定它们的形式。
- **没有 activation 字段。** 记录是封闭的,因此 `epoch` 或 `activationId` 会被拒绝:grant 不是 activation。
- **替换。** Runtime 的按操作门禁只有在以下条件下才可以用 grant `b` 替换 grant `a`:两者都有效,指向同一个 Session、操作和 domain,并且满足其一:
  - `b` 续租 `a`:修订号相同,除更晚的 `expiresAt` 外所有字段都相同,phase 顺序也相同;或
  - `b` 是更晚的修订,其 `workspaceGeneration` 不比 `a` 的旧。更晚的修订可以更换 owner、范围和租约。

  更早的修订已经过期,没有延长租约的续租同样无效。完全相同的 grant 不替换任何东西:在门禁上重复安装是幂等的,门禁给出与之前相同的回答。

  该规则只比较两个 grant,看不到门禁的历史,因此撤销是保存在该规则之外的门禁状态。按照控制协议的要求,门禁永远不会重开已撤销的修订:它拒绝该修订的续租,重新安装同一 grant 后该修订仍处于撤销状态;只有更晚的修订才能重开该操作。H0c 把这一状态与门禁保存在一起。

## 状态线

一次运行由三条相互独立的线描述,任何一条都不能冒充另一条:运行已 settled 不能证明其进程已排空,结果已被接收不能证明模型已消费,模型回合已完成不能证明 Channel 已送达回复。

**逻辑运行**:业务是否已准入、是否已结束。

| 当前状态                         | 允许的下一状态                                                  |
| -------------------------------- | --------------------------------------------------------------- |
| `reserved`                       | `admitted`、`failed`、`cancelled`                               |
| `admitted`                       | `running`、`waiting`、`failed`、`cancelled`、`recovery_blocked` |
| `running`                        | `waiting`、`settled`、`failed`、`cancelled`、`recovery_blocked` |
| `waiting`                        | `running`、`settled`、`failed`、`cancelled`、`recovery_blocked` |
| `recovery_blocked`               | `running`、`waiting`、`settled`、`failed`、`cancelled`          |
| `settled`、`failed`、`cancelled` | 无                                                              |

**物理执行**:Runtime、进程或远端调用实际发生了什么。

| 当前状态                                   | 允许的下一状态                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `intent`                                   | `dispatch_started`、`not_started_proven`、`outcome_unknown`、`corrupt`            |
| `dispatch_started`                         | `running_attached`、`settled`、`not_started_proven`、`outcome_unknown`、`corrupt` |
| `running_attached`                         | `settled`、`outcome_unknown`、`corrupt`                                           |
| `outcome_unknown`                          | `running_attached`、`settled`、`not_started_proven`、`corrupt`                    |
| `settled`、`not_started_proven`、`corrupt` | 无                                                                                |

Runtime 在任何副作用之前拒绝的派发,证明没有开始执行。未知结果只能依据证据离开 `outcome_unknown`:重新 attach(包括在更晚 generation 下重建的 Monitor watch)、原系统的结果,或原系统关于该工作从未执行的证明。`corrupt` 是终态,因此其运行保持 `recovery_blocked`:参考设计没有定义出口,用户仍可查询它、请求取消或关闭 Session。

**交付与接收**:结果是否到达 Channel 或父 Session,以及是否被模型消费。

| 当前状态                                         | 允许的下一状态                                 |
| ------------------------------------------------ | ---------------------------------------------- |
| `planned`                                        | `sending`、`accepting`、`cancelled`            |
| `sending`                                        | `delivered`、`partial`、`unknown`、`rejected`  |
| `partial`                                        | `sending`、`unknown`                           |
| `accepting`                                      | `accepted`、`unknown`、`rejected`              |
| `accepted`                                       | `consumed`                                     |
| `unknown`                                        | `delivered`、`partial`、`accepted`、`rejected` |
| `delivered`、`consumed`、`rejected`、`cancelled` | 无                                             |

交付有一个目标。`channel` 交付使用 `planned`、`sending`、`partial`、`delivered`、`unknown`、`rejected`、`cancelled`;`session` 交付使用 `planned`、`accepting`、`accepted`、`consumed`、`unknown`、`rejected`、`cancelled`。`consumed` 只属于接收:Channel 没有模型来消费回复。未知的交付永远不会回到 `sending` 或 `accepting`;重发是带新 `deliveryId` 的新交付。`partial` 回到 `sending` 只是为了发送已证明未发出的分段。

## 运行块

每条 H 阶段记录都内嵌一个封闭的 `run` 对象。

| 键                | 规则                                                           |
| ----------------- | -------------------------------------------------------------- |
| `state`           | 一个逻辑运行状态                                               |
| `reason`          | null、一个恢复原因或一个配额原因                               |
| `definition`      | null 或一个定义固定                                            |
| `executionCallId` | null 或 id:由工具启动的运行在 `tool.intent` 中的身份           |
| `effectId`        | null 或 id:domain phase 的效果身份                             |
| `dispatchId`      | null 或 id:派发到另一个 Session                                |
| `deliveryId`      | null 或 id:一次外部交付                                        |
| `execution`       | null 或一个物理执行状态                                        |
| `runtime`         | null,或 `runtimeBindingId`(id)与 `generation`(generation)      |
| `delivery`        | null,或 `target`(`channel` 或 `session`)与该目标的一个 `state` |

**身份与绑定。**

- 一次运行至多有一个物理身份:`executionCallId` 或 `effectId`,两者不能同时存在;只要 `execution` 有值,就必须有其中之一。
- `runtime` 要求有 `execution`:只有物理执行才有绑定。没有绑定的执行运行在 domain 适配器中,例如 Channel 发送方。
- `deliveryId` 恰好在交付目标为 Channel 时设置。Session 交付不需要自己的 ID:运行标识它,跨 Session 时再加上其 `dispatchId`。

**状态。**

- `reserved` 的运行没有执行也没有交付:准入之前不派发任何东西。
- 执行处于 `outcome_unknown` 或 `corrupt` 时,运行必须是 `recovery_blocked`,因此无法证明的结果永远不会被当作结果。
- `settled`、`failed` 或 `cancelled` 的运行没有执行,或其执行已被证明结束:`settled` 或 `not_started_proven`。`settled` 的运行,其执行不能是 `not_started_proven`;`running` 或 `waiting` 的运行也不能,因为已经没有可运行的内容。
- `session` 交付一旦越过 `planned` 或 `cancelled`,运行就必须已经结束:父方只有在结果存在之后才能接收它。

**原因。**

| 状态                                           | `reason`                           |
| ---------------------------------------------- | ---------------------------------- |
| `recovery_blocked`                             | 必须是恢复原因                     |
| `running`、`waiting`                           | null,或恢复原因:运行以降级方式继续 |
| `failed`                                       | null,或配额原因                    |
| `reserved`、`admitted`、`settled`、`cancelled` | null                               |

- `outcome_unknown` 要求执行处于 `outcome_unknown`;原因恰好在执行为 `corrupt` 时是 `execution_corrupt`;`runtime_lost` 要求有它失去的 `runtime`,因它而阻塞的运行不能是 `running_attached`;`dispatch_unknown` 要求有 `dispatchId`。

**修订。** 同一运行的后一次修订必须满足以下全部条件:

- 每条状态线保持不变或前进一个允许的单步。执行首次出现时为 `intent`,交付首次出现时为 `planned`;一旦出现,两者都不能回到 null,交付也保持其目标。
- `executionCallId`、`effectId`、`dispatchId`、`deliveryId` 和 `definition` 可以设置一次,之后不再改变。与 `runtime` 一样,`definition` 只有在前一次修订的执行为 null 或 `intent` 时才可以首次出现,因此运行不会在一个事后才固定的定义下执行。
- `runtime` 随派发记录:只有在前一次修订的执行为 null 或 `intent` 时,它才可以首次出现。只有当 `outcome_unknown` 的执行在严格更晚的 generation 下重新变为 `running_attached` 时,它才会改变;此时 binding ID 也可以改变,因为 Broker 为每一代分配一个 binding ID。
- 已结束的运行只能改变其交付,外加首个 Channel 交付的 `deliveryId`,以便运行 settled 之后仍能转交结果。

## 原因

| 恢复原因              | 含义                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `outcome_unknown`     | 工作已派发,其结果无法证明。                                                                                                  |
| `execution_corrupt`   | 物理账本或回执已损坏。                                                                                                       |
| `runtime_lost`        | 拥有该工作的 Runtime 绑定已丢失。阻塞的运行未能重新 attach;运行中或等待中的运行在重新 attach 后继续,间隔期间的结果可能缺失。 |
| `dispatch_unknown`    | 已向另一个 Session 发出派发,其准入情况未知。                                                                                 |
| `handler_unavailable` | 已登记的处理器(例如 function Hook)无法重建。                                                                                 |

| 配额原因           | 对应参考设计第 12 节中的限额                          |
| ------------------ | ----------------------------------------------------- |
| `count_limit`      | 连接、绑定、在途操作、进程、monitor、并发子任务、积压 |
| `rate_limit`       | 每时段触发次数、事件速率                              |
| `depth_limit`      | 子任务深度                                            |
| `byte_limit`       | 日志字节、暂存字节                                    |
| `budget_exhausted` | 模型与工具预算                                        |
| `duration_limit`   | Runtime 时长                                          |

准入之前的容量拒绝不会产生记录;配额原因用来说明一次已准入或已预留、随后因限额而失败的运行。

## 定义固定

定义固定由 `definitionId`(id)、`definitionRevision`(revision)和 `definitionDigest`(digest)组成:运行实际使用的不可变定义,例如某个 schedule、Hook catalog、MCP server 或 AgentBundle 的修订。`definitionId` 与 `definitionRevision` 都相同的两个固定必须有相同的 digest,因为一个修订永远不会对应两份内容。运行最迟在派发时固定定义,并保持不变,因此定义更新只影响之后的运行。

## Monitor 运行

`monitor_run` 记录正文的 kind 为 `managed-monitor_run`、schema 版本为 1,恰好包含下列键,覆盖参考设计第 10 节列出的内容。这是 domain 记录携带的内容;`commitDomainRecord` 目前会在内容外加上 `operationId`、`revision` 和 `previousRecordRef`,由 H0c 决定如何把这层封装与内容分开。

| 键                    | 规则                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `monitorId`           | id                                                                                       |
| `ownerScopeId`        | id:拥有该 monitor 并接收其通知的 activation 作用域                                       |
| `commandRef`          | durable ref:启动调用的 `argsRef`,其中保存命令及其目录;其 digest 即命令/目标 digest       |
| `maxEvents`           | 1 到 10,000                                                                              |
| `idleTimeoutMs`       | 1 到 600,000                                                                             |
| `debounceMs`          | 0 到 600,000:Runtime 把输出聚合为一个观测的时间窗口;过滤逻辑属于 `commandRef` 指向的命令 |
| `startReceiptRef`     | null 或 durable ref:当前 watch 的物理启动回执                                            |
| `observationSequence` | 不超过 `maxEvents` 的 count:已接受的有意义观测数,而不是原始行数                          |
| `lastObservationRef`  | null 或 durable ref:最后一次观测的摘要                                                   |
| `notifiedThrough`     | 不超过 `observationSequence` 的 count:通知水位                                           |
| `stopReason`          | null,或 monitor 结束的原因                                                               |
| `outputRef`           | null,或 `managed-tool-result-manifest` 版本 1 的引用:输出 Artifact                       |
| `run`                 | 运行块                                                                                   |

- **运行。** 运行只指明启动调用的 `executionCallId`:没有 `effectId`、`dispatchId`、`deliveryId`、`delivery` 或 `definition`。Monitor 通过其水位通知,而不是通过交付。
- **观测。** `lastObservationRef` 恰好在 `observationSequence` 大于 0 时设置。
- **通知。** v1 的通知策略是固定的,因此不需要自己的字段:每个已接受的观测都应被通知,一条通知可以覆盖其中多个观测。可以设置的只有进入接受之前的环节:命令中的过滤,以及 `debounceMs`。Legacy Monitor 工具同样没有策略参数:通过其固定节流(一次至多 5 行,之后每秒 1 行)的每一行都会被通知,并报告丢弃了多少行。`debounceMs` 内的聚合取代了节流,一个观测聚合了什么属于其摘要;规划中的 `SessionTaskView` 没有丢弃行数。只通知部分已接受观测的策略,例如每 n 个观测通知一次,会改变记录正文,因此需要新的记录版本。
- **启动回执。** watch 启动后即设置:只要有观测,或执行处于 `running_attached`。执行为 null、`intent`、`dispatch_started` 或 `not_started_proven` 时,它为 null。启动回执需要签发它的运行 Runtime 绑定。
- **停止原因。** 恰好在运行结束时设置,并且必须与状态相符:`settled` 对应 `exited`、`max_events` 或 `idle_timeout`;`failed` 对应 `start_failed`、`watch_failed` 或 `quota_exceeded`;`cancelled` 对应 `stop_requested`。`settled` 的 monitor,其执行为 `settled` 且有启动回执,因为它的每个停止原因都需要一个运行过的 watch。`max_events` 要求 `observationSequence` 等于 `maxEvents`。`start_failed` 要求执行已被尝试且没有启动回执;`watch_failed` 表示 watch 运行后失败,要求有启动回执。停止原因恰好在运行原因是配额原因时为 `quota_exceeded`。
- **修订。** 后一次修订保持 `monitorId`、`ownerScopeId`、`commandRef`、`maxEvents`、`idleTimeoutMs` 和 `debounceMs` 不变;其运行块是前一个的后继;`observationSequence` 与 `notifiedThrough` 从不减少;只有当前后任一修订的执行为 `running_attached` 时 `observationSequence` 才能增长,因为丢失或已结束的 watch 不会产生观测;`lastObservationRef` 只随新观测改变;`outputRef` 可以随 manifest 的新修订改变,但从不被移除;`startReceiptRef` 只设置一次,新的 Runtime 绑定必须带来新的启动回执,除此之外它不会改变。monitor 结束后只有 `notifiedThrough` 还能前进,以便最后一条待发通知仍能送达。
- **重建。** Runtime 丢失的 watch 处于 `recovery_blocked`,原因为 `runtime_lost`,执行为 `outcome_unknown`。纯观察、且能够从持久定义重建的目标会在更晚的 generation 下回到 `running` 与 `running_attached`,获得新的启动回执,并从已提交的水位继续;运行可以保留 `runtime_lost` 作为原因,表明间隔期间的观测可能缺失。其他目标都不能重建,因为再次运行其命令可能重复结果未知的副作用:它们保持阻塞,要再次观察只能启动新的 Monitor。只有已知为只读的命令才算纯观察。重建是 `OperationGrant` 下的维护 phase:其 intent 与派发提交在该 phase 的物理账本中,以 Session、效果、phase 和效果修订为键,monitor 记录只提交结果,即在新 generation 下的 attach。如果重建的结果未知,monitor 保持阻塞,也不会再启动另一个 watch。重建只从 `outcome_unknown` 开始,从不从已 settled 的执行开始。Monitor 的执行描述的是它的 watch,重建会在更晚的 generation 下延续这个 watch,而不是旧 generation 的那个进程;因此得知该进程随 Runtime 一起丢失,不会排除重建:在目标仍可重建时,H3 不会依据这一证明 settle 执行。执行在 watch 本身结束时 settle,例如命令自行退出或失败、达到限额或被请求停止;或者在无法重建的目标被证明已不存在时 settle。此后这样的目标保持 `recovery_blocked`,直到 monitor 结束;H3 永远不会把它改回 `running` 或 `waiting`,尽管记录契约并不拒绝这一步(开放问题 5)。已结束的 monitor 永远不会被重建。
- **重建与新 Monitor。** 重建在 grant 下继续同一个 monitor,不需要模型 activation:它保留 `monitorId`、启动调用、命令与限额,从已提交的水位继续,只替换 Runtime 绑定和启动回执。新 Monitor 是 activation 下的一次新的启动调用,有自己的身份、限额与水位,也要经过自己的准入、审批和配额。

## 共享 schema 与 fixtures

`packages/core/src/managed-runtime/contracts/managed-extension-record-v1.schema.json` 和 `.fixtures.json` 保存本契约,与其他 Managed Runtime 契约放在一起。

- domain 索引、限额、kind、状态线、交付目标、原因和 Monitor 停止原因,作为常量。
- 一个规范的 grant、定义固定、运行块和 monitor 运行。
- 568 个用例:grant(140,其中每个 domain 各有一个有效 grant)、grant 替换(22)、定义固定(25)、定义固定对(7)、运行块(152)、运行修订(61)、monitor 运行(118)和 monitor 修订(43)。每个无效用例都针对一条规则。

schema 固定每条记录的结构,以及它能清晰表达的所有规则,包括全部状态、原因和停止原因规则。它无法表达 UTF-8 字节上限、NFC、格式良好的 UTF-16、可读的 2^63−1 上界、由另一字段推导出的记录 kind,或依赖另一字段的上界;TypeScript 测试列出 schema 与模块结论不同的用例。它的正则表达式遵循 ECMA-262,这是 draft 2020-12 的规定;采用其他正则语义的 validator(例如 Java 的默认实现)可能接受末尾的换行,而两个模块都会拒绝。一个依据本文编写、独立于两种语言的 Python 实现为每个用例标注了结论,它与 `managed-tool-result/1` 的做法一样放在仓库之外,生成器在它与标注不一致时停止。为 [#12887](https://github.com/QwenLM/qwen-code/issues/12887) 第 1 项新增的十个用例、以及在同一 runtime 绑定下重新隔离的 monitor 后继用例,改由一个新编写的 Python 参考标注,原生成器未取得:它只覆盖这十一个用例与其正向控制,没有重新审计其余 557 条标注,也只解释部分 schema,因此语料的 schema 权威仍是下文列出的 Ajv 校验。

- **TypeScript。** `packages/core/src/managed-runtime/managed-extension-record.ts` 解析 grant、定义固定、运行块与 monitor 运行,并检查 grant 替换、定义固定对和修订。自 H0c 起,Session authority 的记录与投影模块都在导入它。
- **Java。** `managed-agent-server` 中的 `ManagedExtensionRecords` 在 Jackson 树上实现同样的规则。一个测试回放每个用例,检查每条线上的每一对状态,固定常量,并用 schema 校验 fixtures。

## 受影响的文件

- `packages/core/src/managed-runtime/contracts/managed-extension-record-v1.schema.json` 和 `.fixtures.json`(新增)。
- `packages/core/src/managed-runtime/managed-extension-record.ts` 及其测试(新增)。
- `packages/core/src/managed-runtime/managed-session-records.ts` 及其测试:`monitor_run` 加入 v1 索引。
- `packages/sdk-java/managed-agent-server` 中的 `ManagedExtensionRecords` 与 `ManagedExtensionRecordContractTest`(新增)。
- 本设计文档的两种语言版本(新增)。

authority、存储、Harness、Broker、worker、路由和 CI workflow 均无改动。

## 验证计划

- **TypeScript:** 用严格模式的 Ajv 按 schema 校验 fixtures;每个用例通过模块回放;每条线上的每一对状态都与 fixture 中的迁移表比对;schema 与每个记录用例比对。
- **Java:** 每个用例通过 `ManagedExtensionRecords` 回放;检查每一对状态;固定常量;用 networknt validator 按 schema 校验 fixtures。
- **变异检查:** 依次变异 TypeScript 模块中的每个失败分支、提前返回、比较与逻辑运算符,Java 类中的每个 `require` 与提前返回,以及两者中每个检查单个字段的调用,并重跑同一语言的测试。

## 验收标准

- 在两种语言中,fixtures 里的每种畸形结构和每个非法迁移都被拒绝,每个有效用例都被接受。
- schema 与模块只在列出的、JSON Schema 无法表达的规则上结论不同。
- `monitor_run` 位于 v1 domain 索引中,且提交时仍被拒绝。
- 现有行为除一处解析变化外都不变:`parseManagedSessionEvent` 以及基于它的每条路径(例如 authority 的 `open` 与 `appendExecution`,以及存储扫描)现在都接受 domain 为 `monitor_run` 的 `domain.committed` 事件,而之前会拒绝它。追加这样一条事件仍会碰到 H0c 新增的两道拒绝:domain 记录只能通过 `commitExtensionRecord` 提交——`commitDomainRecord` 提交该 domain 时仍会拒绝——而开放检查会在通用追加路径上拒绝未开放的 domain。

## 开放问题

1. **phase。** grant 只检查 phase 的形式。各 H 切片应在本契约中登记其 domain 的 phase,还是随各自的记录正文登记?
2. **降级。** 已由 H0c 的决策 5 回答:运行中或等待中的运行若携带恢复原因,恰好投影为 `degraded`。
3. **修订链。** 已由 H0c 的决策 3 回答:每条记录一条修订链,按记录正文自身的身份区分(Monitor 按 `monitorId`),并把提交时加上的封装与它发布的封闭正文分开。
4. **损坏的执行。** 执行为 `corrupt` 的运行保持 `recovery_blocked`。后续切片是否应增加一个显式的运维命令来关闭这类运行,它又应记录什么证据?
5. **不经重新 attach 离开阻塞。** 执行在 `recovery_blocked` 期间已 settled 的运行,按契约仍可迁移到 `running` 或 `waiting`,尽管没有任何东西在运行。契约是否应拒绝这一步?在任何 H 阶段 domain 开放之前这样做,不需要升级记录版本。
6. **通知内容。** 正文只保存最后一个观测的摘要,因此覆盖多个观测的通知无法指向其他观测的摘要。H3 应从 `outputRef` 指向的输出中获取它们,还是每次修订只提交一个观测?两者都不需要新字段。

## 后续工作

| 切片  | 范围                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| H0c   | 随 Session authority 提交 domain 记录、outbox 与唤醒意图;签发并安装 grant;重启后据运行块重建 `SessionTaskView`。              |
| H3    | 在各自的准入、回执、取消、配额与恢复检查下开放 `monitor_run` 与后台 Shell,并让 H0b 之前的 reader 远离含有这些记录的 Session。 |
| H1–H6 | 其他 domain 的正文及其 phase,每条都内嵌运行块。                                                                               |
