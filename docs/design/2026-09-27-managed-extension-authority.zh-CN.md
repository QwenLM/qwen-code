# Managed 扩展记录 Authority（H0c）

[English](2026-09-27-managed-extension-authority.md) | [简体中文](2026-09-27-managed-extension-authority.zh-CN.md)

状态：已在本次变更中实现；目前尚无 Stage H domain 开放提交。更新：2026-09-27。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H0c 切片，属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。它建立在 H0a 的任务契约（[设计](2026-09-27-managed-agent-task-contract.zh-CN.md)）和 H0b 的记录契约（[设计](2026-09-27-managed-extension-record-contract.zh-CN.md)）之上。下文的“参考设计”指该提案[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)的第 1、3、11、13 节，以及其 [Session 存储设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md)第 3 节和[私有控制协议](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-control-protocol.md)中的 `OperationGrant`，均以 #12827 固定的提交为准。

## 问题

H0b 定下了 Stage H 各项能力共用的记录，但还没有组件提交它们。在 H1 把 MCP 接入 Managed 路径之前，Session authority 需要提交这些记录以及随之而来的 outbox 与唤醒意图，控制面需要据此重建 `SessionTaskView`。参考设计第 13 节的 H0 门槛是：Java、qwen 与 Runtime 对稳定 ID、代数和未知结果的解释一致，并且重启后能重建任务列表。

为此必须先回答 #12827 的两个问题：记录由谁持有（问题 2），以及由什么承载唤醒意图（问题 3）。H0b 还留下两个问题：`degraded` 如何投影，以及当一个 domain 每个资源各有一条记录时，记录的修订链按什么区分。

## 现状

以下事实基于 `main` 的 `848cf5e6c4`。

- **Authority。** `packages/core` 中的 `LocalManagedSessionAuthority` 是 Session 日志唯一的写入者。`commitDomainRecord` 把 `operationId`、`revision` 与 `previousRecordRef` 合并进它发布的正文，并且每个 domain 只维护一条修订链。`submitInput` 在一个事务中提交 `input.accepted` 和 authority 为它生成的 `wake.requested`。
- **存储。** Hosted Harness 通过 `HttpManagedSessionStore` 把日志写入 Java Session 存储；后者把每个事务存为不透明的记录字节，把每个资源存为经过校验的数据块。事件 payload 引用的资源随提交内联发送；只在另一个资源正文中被引用的资源，仅当该正文是检查点时才会随之发送。
- **契约。** H0b 定义了运行块、monitor 正文与 `OperationGrant`，并由 TypeScript 与 Java 共同回放的 fixture 固定。`monitor_run` 已在 v1 domain 索引中，但未开放提交。H0a 已把任务路由以 `planned` 加入公开契约。
- **Broker。** Runtime Broker 的执行台账有 `PREPARED`、`DISPATCHING`、`EXECUTING`、`CANCEL_REQUESTED`、`SETTLED` 与 `UNKNOWN` 几种状态。Harness 看到的是线上状态：它把 `DISPATCHING`、`EXECUTING` 和 `UNKNOWN` 合并为 `executing`，并以错误 `runtime_broker_execution_unknown` 回应 `UNKNOWN`。目前没有代码把两者映射到物理执行状态线。

## 目标

- 由 Session authority 提交 Stage H 记录修订：每条记录一条修订链，并可在同一事务中提交一个通知输入及其唤醒。
- authority 重新打开时重建修订链与任务列表。
- 在提交日志的同一个 SQL 事务中，于 Java Session 存储里物化记录、任务投影与 outbox，并拒绝共用契约所拒绝的任何修订。
- 依据已提交的记录签发 `OperationGrant`，并在按操作划分的 gate 上安装它们。
- 在两个 API 面上提供任务列表与详情，并在 Session 事件流上宣告任务视图的每一次变化。
- 用一份 TypeScript 与 Java 共同回放的 fixture 文件固定投影、任务身份与 Broker 映射。

## 非目标

- **开放提交。** `monitor_run` 仍不开放提交，也没有其他 domain 获得正文定义。Monitor 由 H3 开放。
- **任务事件与取消。** 这两类路由保持 `planned`：H0c 的任务不产生输出，也还没有能响应取消的 owner。
- **派发器。** 目前还没有组件读取 outbox；派发器由 H4 与 H5 加入。
- **提交时的 grant 校验。** 哪些提交必须出示 grant，由各切片随其阶段决定。
- **Runtime、Harness 与 Broker 路径。** 不改动工具循环、Broker 或 worker。

## 决策

1. **authority 写入，Java 存储物化**（问题 2）。TypeScript authority 仍是日志唯一的写入者，这是存储设计第 3 节的要求：注册 domain 没有第二条写入路径。Java Session 存储是它的持久存储，现在会读取每个事务携带的 Stage H 修订，并在保存日志的同一个 SQL 事务中，把记录索引、任务投影与 outbox 写成可查询的行。它用 H0b 与 H0c 的规则检查每一条修订，只要有一条不通过就拒绝整个提交。这样控制面绝不会持有 authority 不可能提交的记录，而两侧一旦不一致，写入者会停下，而不是悄无声息地继续。控制面由此获得参考设计第 1 节交给它的产品级记录与公开投影，且无需第二个写入者。
2. **唤醒就是 `input.accepted` 加 `wake.requested`**（问题 3）。一条 Stage H 修订可以在同一事务中提交一个通知输入，authority 会像 `submitInput` 那样为它生成唤醒。没有 `WakeIntent` 记录，也没有新的事件类型：按存储设计第 3 节，两者都需要新的 `minimumReader`，而 `wake.requested` 本身就是可重建的调度索引。Session inbox 是用户消息队列，不是唤醒的载体。
3. **每条记录一条修订链，按正文自身的身份区分**（H0b 未决问题 3）。Stage H 修订的资源恰好保存封闭的正文，不合并任何其他内容。修订链按 domain 与正文自身的身份（Monitor 为 `monitorId`）区分，其修订号、上一修订和开启它的操作都来自日志顺序，因而不可能与正文不一致。
4. **第一条修订必须开启运行。** 其运行为 `reserved` 或 `admitted`，执行为空或 `intent`，交付为空或 `planned`；Monitor 还必须尚未写出输出，而没有启动回执它也不可能有观测。H0b 的后继规则只说明一条修订如何接在另一条之后；没有这条规则，一条记录可能一出现就已结算。
5. **`degraded` 就是带恢复原因的运行中或等待中的运行**（H0b 未决问题 2）。这正是 H0b 允许在保障降低的情况下继续进行的状态，例如 Runtime 丢失后重建了观察的 Monitor。
6. **outbox 由交付状态线导出。** 只要记录的交付处于 `planned`、`sending`、`partial`、`accepting` 或 `unknown`，它就在 outbox 中：仍需发送，或需要在不重发的前提下对账。由于 outbox 是已提交运行的投影，它总是与运行一同提交。`accepted` 等待的是模型，而不是派发器。
7. **grant 由已提交的事实导出。** authority 为一条已提交的记录签发 grant：其 operation 是开启该记录的命令，因此一个命令至多开启一条记录；其修订号是该记录当前的修订号；其计划是该修订的资源。owner、Workspace 代数与阶段由调用方提供，生命周期、信任与阶段的检查由登记阶段的切片加入。grant 不需要自己的日志条目，重启后的 authority 会再签发相同的修订。Runtime 的 gate 按 H0b 的替换规则安装它，因此再次签发即为续期，而更换 owner 或范围需要该记录的新修订。gate 绝不重新开启已撤销的修订，被撤销的 grant 仍约束下一个 grant。
8. **任务身份是两侧都能计算的哈希。** 记录键是对 Session ID、domain 与记录身份以 NUL 连接后求 SHA-256，任务 ID 为 `task_` 加上该键。该 ID 满足公开接口 128 字符的上限，且不暴露任何内部标识。
9. **提供列表与详情，不提供事件与取消。** 四条读取路由改为 `partial`，每个 Session 都报告 `capabilities.tasks`，因为每个 Session 都提供这些路由。任务事件保持 `planned`，直到有任务产生输出；取消保持 `planned`，直到有 owner 能停止任务；`PublicCommandOperation.task_id` 与 `WebShellCommandOperation.taskId` 随取消保持 `planned`。因此 H0c 的任务不宣告任何操作，也不带 Artifact。
10. **Runtime 的报告映射到执行状态线。** Broker 记录处于 `PREPARED` 或 `DISPATCHING` 时为 `intent`，`EXECUTING` 或 `CANCEL_REQUESTED` 为 `dispatch_started`，`UNKNOWN` 为 `outcome_unknown`；`SETTLED` 在状态为 `not_started` 时为 `not_started_proven`，否则为 `settled`。Harness 按同样的方式读取线上状态，唯一的区别是把 `executing` 视为已派发：线上无法区分尚未发送的认领和已发送的调用，而把可能已发送的调用当作未发送，可能导致它被执行两次。

## 提交记录

`LocalManagedSessionAuthority.commitExtensionRecord(command, { domain, record, input? }, actor)` 提交一条修订。

1. domain 必须在 `MANAGED_EXTENSION_RECORD_BODIES` 中有记录正文；目前只有 `monitor_run` 有。
2. 重试的命令在重新发布任何内容之前，返回它已提交的修订，即使该 domain 此后已被关闭提交。同一命令携带不同内容则为冲突。
3. domain 必须已开放提交；`monitor_run` 未开放。
4. 解析并封闭正文。记录的第一条修订必须开启运行，且其命令不能已经开启过另一条记录；之后的每一条修订都必须是最新修订的后继。
5. 解析后的正文作为资源发布；`domain.committed` 事件与给定的输入及其唤醒在一个事务中提交。

其他任何路径若试图为有正文的 domain 提交 `domain.committed` 事件，例如 `appendExecution` 或 `commitDomainRecord`，都会被拒绝，因此没有修订能绕过它的修订链。

authority 打开时，会按同样的规则重放日志中的每条 Stage H 修订，并从资源存储读取每个正文。若某个正文无法读取或无法接上修订链，说明日志或其资源已损坏，打开失败。`extensionRecord`、`taskViews` 与 `extensionOutbox` 暴露重建后的状态，`issueOperationGrant` 依据它签发 grant。HTTP 存储现在也会像处理检查点一样，提交 Stage H 正文中引用的资源，因此正文绝不会引用只有写入者持有的资源。

## 任务投影

任务视图跟随一条记录已提交的修订。每条修订提供运行块和其 `domain.committed` 事件发生的时间。

| 运行状态               | 任务状态                        |
| ---------------------- | ------------------------------- |
| `reserved`、`admitted` | `pending`                       |
| `running`、`waiting`   | 相同状态；带原因时为 `degraded` |
| `settled`              | `completed`                     |
| `failed`、`cancelled`  | 相同状态                        |
| `recovery_blocked`     | `recovery_blocked`              |

| 运行块                                    | Runtime 状态   |
| ----------------------------------------- | -------------- |
| 运行已结束，或没有执行                    | 缺省           |
| 有执行但没有 Runtime 绑定                 | `unbound`      |
| `running_attached`                        | `ready`        |
| 原因为 `runtime_lost`                     | `lost`         |
| 有绑定且为 `intent` 或 `dispatch_started` | `provisioning` |
| 其他执行                                  | 缺省           |

各行按顺序匹配。`draining` 需要停止请求，而运行块不携带它；由 H3 加入。

- `createdAt` 是第一条修订的时间。
- `startedAt` 是运行首次处于 `running`、`waiting` 或 `settled` 的那条修订的时间，因此每个已完成的任务都有它，而待处理的任务从不会有。受阻的运行不设置它，因为它仍可能证明自己从未启动。
- `settledAt` 是结束运行的那条修订的时间。
- 时间不会早于之前的时间：`startedAt` 至少为 `createdAt`，`settledAt` 至少为启动时间，没有启动时间时至少为创建时间。
- `definitionRevision` 是运行所固定的定义修订号。
- 列表按创建时间从新到旧排列，再按任务 ID，两者均为降序。

这些时间取自 authority 在每条修订上记录的 `occurredAt`，而不是服务端时钟，因此从日志重建能得到相同的视图；上述下限约束用于应对写入者的时钟比前一个写入者慢的情况。它们按 H0a 契约的规定为 epoch 毫秒；已提供的 Session 与事件资源报告的是秒，见未决问题 2。

## Java Session 存储

Flyway `V16` 新增 `qwen_managed_session_extension_record`：每条记录一行，以 Session 范围键和记录键为主键，保存记录身份、最新修订及其资源、任务投影与交付状态线。`ManagedExtensionRecordStore` 在 `ManagedSessionStore.commit` 中写入它，时机在事务的资源存入之后，并处于同一个 SQL 事务内：

1. 以与 authority 读取器同样严格的方式解析事务的每一行记录，拒绝重复键与尾随内容，并挑出有正文的 domain 的 `domain.committed` 事件。
2. 按 authority 读取器的方式检查每个这样的事件：版本为 1、键封闭且属于本 Session、payload 封闭且其引用指向该 domain 的版本 1 记录。然后从校验过的资源读取正文，检查它与引用一致，并用 `ManagedExtensionRecords` 检查正文。
3. 对照存储中的最新修订检查首修订规则或后继规则，用 `ManagedExtensionProjection` 投影任务视图，然后插入或更新该行。
4. 当视图发生变化且该 Session 有公开资源时，追加一个带 `data.taskId` 与 `data.state` 的 `task.updated` 事件；事件带有去重键，重放的事务不会重复宣告。

被这些规则拒绝的修订返回 `409 managed_session_extension_record_rejected`。正文资源缺失、属于其他 Session 或校验失败时，沿用存储原有的回应（`409 managed_session_resource_missing`、`404 session_not_found`、`500 managed_session_resource_corrupt`）。无论哪种情况，整个提交都会回滚。重放的事务在上述步骤之前就已返回。现在每一行记录都必须是 JSON 对象；authority 一直是这样写的。这些行是持久的读模型：重启后的服务读到相同的列表，而导出它们的日志仍是真相来源。

## 公开契约

OpenAPI 版本升为 `1.18.0`，排在事件重放（#12840）的 `1.17.0` 之后。

- `listSessionTasks`、`getSessionTask`、`queryWebShellTasks` 与 `getWebShellTask` 改为 `partial` 并已映射，它们返回的任务 schema 与枚举也一样。
- 提供 `SessionCapabilities.tasks`。`WebShellSession.capabilities` 改为命名 schema `WebShellSessionCapabilities`，其中 `tasks` 已提供，其余标志仍为 `planned`。
- 列表路由说明了 `task.updated` 事件；事件类型是开放字符串，因此无需改动 schema。
- 列表游标错误为 `400 invalid_cursor`，limit 不在 1 到 100 之间为 `400 invalid_limit`，任务不存在为 `404 task_not_found`。
- `output_cursor` 与 `outputCursor` 随它所指向的任务事件路由保持 `planned`。`TaskActionCapability` 的取值会进入生成类型，尽管 H0c 的任务不宣告其中任何一个，因为枚举值无法带上标记，这一点 H0a 已就 `task_cancel` 说明过。

生成的 WebShell 类型新增两条任务路由、任务 schema 与能力对象。

## 共用 fixture

`packages/core/src/managed-runtime/contracts/managed-extension-projection-v1.fixtures.json` 为两种语言固定 H0c：

- 记录正文、任务状态与 outbox 状态，作为常量；
- 7 个任务 ID 用例；
- 50 个运行起始用例与 31 个 Monitor 起始用例；
- 45 个单修订视图与 11 段运行历史，附带各自的 outbox 归属；
- 2 条 Monitor 修订链，两侧分别通过各自的 authority 或存储提交；另有 8 条两侧都必须拒绝的修订链；
- 9 个 Broker 执行用例与 8 个线上状态执行用例。

标注由一个依据本文编写、独立于两种语言的 Python 实现给出，它与 H0b 一样保存在仓库之外。`managed-extension-projection.test.ts` 与 `ManagedExtensionProjectionContractTest` 回放纯函数用例；authority 测试套件、`ManagedExtensionRecordStoreTest` 与 `ManagedAgentMySqlIT` 提交修订链。

## 涉及文件

- `packages/core/src/managed-runtime/managed-extension-projection.ts` 及其测试，`managed-operation-grant-gate.ts` 及其测试（新增）。
- `packages/core/src/managed-runtime/managed-extension-record.ts`：起始规则。
- `packages/core/src/managed-runtime/managed-session-authority.ts` 与新增的 `managed-session-authority.extension.test.ts`。
- `packages/core/src/managed-runtime/http-managed-session-store.ts` 及其测试。
- 上述 fixture 文件（新增）。
- `packages/sdk-java/managed-agent-server` 中：`ManagedExtensionProjection`、`ManagedExtensionRecordStore`、`ManagedTaskService` 与 `V16__managed_extension_record.sql`（新增）；`ManagedExtensionRecords`、`ManagedSessionStore`、`ManagedAgentService`、`ApiModels` 与两个控制器；OpenAPI 规范；`ManagedAgentApiContractTest`、`ManagedAgentMySqlIT` 与三个新测试。
- `packages/web-shell/client/components/managed/generated/managed-agent-api.ts`（重新生成）。
- 本设计的两种语言版本，以及 H0a 与 H0b 设计的状态行。

## 验证计划

- **TypeScript：** 回放 fixture；authority 测试套件覆盖修订链、拒绝、重放、通知与唤醒、绕过防护、未开放的 domain、冷重建、正文缺失与 grant；gate 对照 H0b 的替换用例与撤销语义；HTTP 存储覆盖嵌套资源与经 HTTP 的冷重建。
- **Java：** 回放 fixture；通过 `ManagedSessionStore` 覆盖修订链、拒绝、重放与宣告；API 契约测试覆盖每条已映射的路由与每个记录；MySQL 集成测试在 MariaDB 10.11 与 MySQL 8.4 上运行，并证明被拒绝的修订不会留下任何资源、资源引用或日志行。
- **生成类型：** WebShell 生成器测试。
- **变异检查：** 依次对投影规则、起始规则与存储检查逐一做变异，每次都有测试失败。

## 验收标准

- 对每个 fixture 用例，TypeScript 与 Java 得出相同的任务 ID、任务视图、outbox 归属与执行状态，并拒绝相同的修订链。
- 被拒绝的修订在两侧都不提交任何内容。
- 重新打开的 authority 与重启后的服务报告与之前相同的任务列表。
- 没有映射任何 planned 路由；对于没有 Stage H 记录的 Session，除了空的任务列表和 `capabilities.tasks` 之外没有任何变化。
- `monitor_run` 仍被拒绝提交。

## 未决问题

1. **重建开销。** 重新打开的 authority 会读取每条 Stage H 修订的正文。一个 Monitor 最多可提交 10,000 次观测，因此 H3 在开放它之前应当限制这部分开销，例如让 authority 的视图挂在检查点上。
2. **时间戳的单位与来源。** H0a 契约规定任务使用 epoch 毫秒，本变更也照此执行；但已提供的 Session 与事件资源报告的是秒。后续的 D 切片应统一公开接口。H0a 还说服务端用自己的时钟填写任务时间；H0c 改为取自日志，原因见“任务投影”一节。
3. **嵌套资源。** HTTP 存储会把 Stage H 正文引用的每一个资源随提交一并列出，因此若正文引用了 Session 并未持有的资源，例如只保存在 Runtime 或工具结果存储中的启动回执或输出清单，Java 存储的资源检查会拒绝它；Java 存储本身并不遍历正文。H3 要么把这些资源发布为 Session 资源，要么让它们的 kind 不进入闭包。若引用的资源与已暂存资源的元数据不一致，提交会在发送之前失败，并且与事件 payload 中引用不一致时一样，会使写入者停止；H3 应在发布正文之前检查这些引用。
4. **逻辑启动与物理启动。** H0b 允许运行在执行已处于 `running_attached` 时仍停在 `admitted`，此时任务显示为 `pending`，Runtime 状态为 `ready`，且没有启动时间。收紧这条规则属于对 H0b 契约的修改。
5. **重放的 domain 记录。** `commitDomainRecord` 会在发现命令是重放之前就发布新的正文，并返回这个正文的引用，而不是已提交的那个。`commitExtensionRecord` 先检查重放；旧方法留待单独修复。

## 后续工作

| 切片  | 范围                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- |
| H1–H2 | MCP 与 Hooks 的正文和阶段；决定哪些提交需要出示 grant，并在提交时校验。                                 |
| H3    | 开放 `monitor_run` 与后台 Shell；任务事件与输出；`draining`；限制重建开销；让旧读取器远离相关 Session。 |
| H4–H5 | 子任务与 Channel 的正文；排空 outbox 的派发器；任务取消。                                               |
