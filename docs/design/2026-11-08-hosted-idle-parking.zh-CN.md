# 常驻 Hosted Session 的空闲 parking

[English](2026-11-08-hosted-idle-parking.md) | [简体中文](2026-11-08-hosted-idle-parking.zh-CN.md)

状态：供讨论的提案，尚未接受。本文是 [#16320](https://github.com/QwenLM/qwen-code/issues/16320) 的第 6 步（第 1–5 步已合入），在 [#15082](https://github.com/QwenLM/qwen-code/issues/15082) 下讨论。它扩展 [Kubernetes 共享 Hosted Harness 池](2026-10-21-managed-harness-kubernetes.zh-CN.md)中的无损释放。代码引用基于 `main` 的 `0807f5d391`。只写 `:line`（行号）的引用指最近一次点名的文件。

## parking 要消除什么

Session 留在 Hosted Harness 中加载时，即使什么都没运行，也在消耗平台工作量。#16320 实测每个常驻 Session 每分钟 51–56 条语句。来源如下：

- **activation 续约。** 每 20 s 一次 `/writers:renew`（`managed-session-assembly.ts:60`，60 s 租约的三分之一）。
- **心跳。** Java 每 30 s 发一次 `POST /session/:id/heartbeat`（`ManagedAgentProperties.java:636`）。Harness 的处理器只回显（`hosted-harness-session.ts:12411`）。
- **Harness 内存。** Session 的完整事件日志一直留在 Harness 里（`managed-session-authority.ts:469`）。
- **监听端口。** 跑过 Shell 的 Session 还会一直占着一个 loopback 监听（`HostedShellPublisher`）。

parking 的含义是：Session 空闲后从 Harness 卸载，沙箱保持常驻，下一次输入到来时再加载。

## main 上已有的部分

1. **下一次输入时加载。** Java 发起的动词如果在 attachment 缓存中找不到 Session，会先加载它：
   - prompt，经 `HarnessCoordinator.runClaimed`；
   - 审批与问题的回答（`QwenHostedHarnessConnector.java:1085`）；
   - channel 操作（`:1471`）；
   - automation 运行（`:1186`）；
   - Session 消息与 child 结果。

   另有两个加载器会在 journal 无主后接起已提交的 wake 输入：
   - `WakeRecovery`，适用于 journal 未压缩的 public、active、非 CSI Session，覆盖六种输入来源（`WakeRecoveryStore.java:27-34`、`:69-73`）；
   - MQ wake 路径 `TransportWakeActivator`。

2. **无损释放。** Kubernetes drain 设计（`docs/design/2026-10-21-managed-harness-kubernetes.md`）加入了 `releaseIdleOwner`（`hosted-harness-session.ts:4467`）。它做以下几件事：
   - 检查一组空闲条件；
   - 停止续约并释放 activation；
   - 让 Store 封存 head，并留下一张持久的 `hosted_harness_release` 回执；
   - 丢弃 Session，但不取消已接受的输入。

   Store 侧的两半是 `quiesceOwnership` 与 `releaseOwnership`（`JournalWriterLifecycle.java:437-448`、`:450-546`）。

3. **Runtime binding 不依赖 Harness attachment。** 对非 CSI Session，binding 与 Workspace 准入不查 activation，所以没有 activation 的 Session 照样保有沙箱。CSI 守护的 Session 把两者耦合在一起（`JdbcCsiActivationAdmission`），并且已经拒绝释放（`hosted-csi-session.ts:316`）。

`POST /session/:id/detach` 不是可选方案。它与 delete 是同一个 `close()`（`hosted-harness-session.ts:12794-13066`）：

- 它会 drain 后台运行；
- 它把待处理的 wake 输入取消为 `session_closing`；
- 它释放 MCP Runtime；
- 它封存 writer。

## 为什么这套释放 park 不了今天的常驻 Session

1. **它专为正在 drain 的 pool 成员而建，也只适用于此。**
   - 路由只在 Harness 有 `instanceId` 时存在（`hosted-harness-session.ts:4416-4419`），且实例仍在接收工作时会拒绝（`:4443-4446`）。
   - 释放中 Session 的 POST 闸门（`:7935`）和请求计数（`:4418`）也只在有实例时存在。
   - load 完全没有按 Session 设闸。load 路由（`:7924`）注册在该闸门之前，`open()` 只在整个实例 quiescing 时才拒绝（`:4993`）。
   - Store 要求 pool placement 处于 `QUIESCING`（`JournalWriterLifecycle.java:503`）。回执以 placement epoch 为键（`HarnessPlacementStore.releaseId`，contracts 模块的 `HarnessPlacementStore.java:29-31`），其 schema 要求 `instanceId`、`bootId` 和 `placementEpoch`（`ManagedHarnessReleaseRecords.java:14-24`）。
   - SDK 与 connector 在没有 placement 时拒绝（`QwenHostedHarnessConnector.java:273-275`）。控制面里没有任何地方调用 `releaseOwnership`。
2. **它无法回退。**
   - `session.ownershipRelease` 在待处理输入检查之前就被设置（`hosted-harness-session.ts:4494` 对比 `:4507-4514`），且从不清除。路由拒绝任何其他 `operationId`（`:4448-4451`）。
   - prepare 阶段永久停止 activation 续约循环（`managed-session-assembly.ts:334`），并提交 activation 释放。Store client 的 release 调用永久停止 writer 续约，并拒绝后续写入（`http-managed-session-store.ts:2384-2403`、`:2496-2498`）。
   - 在 pool 里 quiesce 无法撤销。`QUIESCING` 的 placement 拒绝任何新的 active activation（`JournalCommit.java:345-350`），只有 takeover 会把它改回 `ACTIVE`。
   - 正在 drain 的进程会退出，由崩溃恢复接手；而一个继续服务的 Harness 会让这个 Session 一直卡住。
3. **它的空闲判定统计了永远不会被移除的对象。** `heldResources`（`hosted-harness-session.ts:4360-4380`）统计：
   - publisher 是否存在。第一次 Shell 或 Monitor 调用会创建 `shell.publisher`（`hosted-workspace-tool-turn.ts:4903`），publication 模式下第一次后台或 Monitor 调用会创建 `backgroundLane.publisher`（`:4925`）。两者都从不清除；
   - 每个 Monitor 循环。循环只增加（`hosted-workspace-tool-turn.ts:7955`），从不移除；
   - 每个 `heldRuntimeTurns` 条目。只有 `close()` 会移除它们（`hosted-harness-session.ts:12919-12948`），而 load 会从 Broker 的 hold 行把它们重新加回（`:7818`）；
   - `session.mcp` 与 `session.hooks`。只要配置了 MCP server 或 MCP 设置、或 hook catalog，它们就存在（`hosted-harness-session.ts:6414-6427`）。MCP server 跑在 Runtime 里，`HostedMcpSession` 持有该 Session 的 Workspace 挂载。

   最后一点对目标部署影响最大：常驻沙箱要注册 MCP server、安装 Skill 和软件。

   另有三项是实例范围的：`inFlightMutations`、`opening.size` 和 `initialReconciliations`（`hosted-harness-session.ts:4475-4477`）。因此任何其他 Session 的流量，包括心跳，都会挡住释放。

4. **Java 不预期 Harness 会丢掉 Session。**
   - `HarnessCoordinator.java:62-66` 假定 daemon 只在显式 detach 或 delete 时丢弃 attachment。
   - 动词先读缓存的 attachment，再调用 Harness。Turn 派发器把 `404 hosted_session_not_found` 归为终态 `hosted_harness_rejected`（`HarnessCoordinator.java:398-402`），其他动词则把错误原样抛出。
   - #15795 在 drain 期间遇到过这个问题。#15990 修好了 automation 被退役的问题，并让 pool 对没有可接收成员的已释放 placement 回 503，但其他动词没有修。
   - 心跳收到 404 时 SDK 会退役自己的 attachment，但没有任何机制通知 connector。
   - 对没有缓存 attachment 的非初始 Session，`GET` session 报 `operator_required`（`SessionRecoveryService.java:131-135`、`QwenHostedHarnessConnector.java:1789-1795`）。任何一次 Java 重启后已经会这样。

## 提案

**由 Harness 发起 park；Java 把找不到的 Session 当作已 park。**

由 Harness 负责，理由有三：

- 只有它知道 Session 持有什么；
- 控制面可以跑多个节点，Java 侧没有任何锁能防止释放与动词发生竞态；
- Java 里的空闲计时会随 Java 重启丢失，让那些 Session 一直加载着、一直续约。

**Harness 中的 park 顺序。**

1. **空闲计时。** 计时取三个时刻中最晚的一个：Session 最后一次被接受的修改、最后一次 journal 提交、最后一次 `turn.settled`。因此刚结束的长 Turn，或没有 POST 的 wake pump Turn，都会重新开始计时。心跳和只读状态请求不算。节点只要缓存着一个没有活动 Turn 的非初始 Session 的 attachment，`GET` session 就会向 Harness 询问恢复状态（`SessionRecoveryService.java:121-135`、`:160-169`），所以如果只读请求也计入，轮询该 Session 的客户端会让它一直保持加载。超过 `park-after` 后，Harness 尝试 park。
2. **预检。** 先检查 Session 空闲期间不会变化的条件：MCP、Hooks、CSI、pool placement 为 `ACTIVE`、实例仍在接收工作。这样永远不能 park 的 Session 永远不会升起闸门。处于 quiescing 的 Session 归 drain 负责；实例一旦停止接收工作，就不再开始 park。
3. **闸门。** 两种模式下都设一个按 Session 的闸门：
   - 对该 Session 的 POST 回 `409 hosted_session_parking`；
   - 对它的 load 在 `open()` 里等待结果，这个等待中的 load 既不计为 opening，也不计为在途请求。
   - 在 pool 里，被挂起的 load 带着 park 之前的 placement token。回执写入后它会因 `harness_placement_released` 失败（`HarnessPlacementStore.java:195-197`），而 `open()` 会把它报成笼统的 503。所以回执写入后，pool 成员以可重试的 409 回复被挂起的 load，就像 drain 用 `hosted_harness_quiescing` 那样（`hosted-harness-session.ts:4993`）。
4. **有界等待。** 等该 Session 其他在途操作结束；每个操作要跟踪到它自身的工作结束，而不是响应结束。
   - 实例计数器有意等待 `finish`，因为一个断开的响应证明不了它的操作已经结束（`hosted-harness-instance.ts:79-82`）。但这样一来，放弃请求的客户端会让 owner 在整个进程生命周期内都不可释放。drain 能接受这一点，因为它最终走崩溃路径；park 不能。
   - 等待超过上限时，放弃本次尝试并清除闸门。
5. **检查。** 检查其余条件，任何一项不满足就清除闸门。条件是现有列表，把实例范围的三项换成该 Session 自己的请求与 opening，再加上：
   - 完全没有待处理输入。今天允许存在尚未尝试的 wake 输入（`hosted-harness-session.ts:4500-4512`）；
   - drain 闸门放行的那些 Turn 之后的收尾操作都已不再欠着（`:7940-7975`）：channel 回执与投递、消息与 child 操作、automation 对账；
   - 没有打开的 `/events` 流。Java 只在驱动 Turn 时打开它（`HarnessCoordinator.java:868`、`:1384`）；
   - 没有待执行的 channel reply-plan 重试。
6. **暂存。** 进入 authority 的串行队列之前，先暂停续约并等待在途的续约结束。activation 续约本身就在这个队列里运行（`managed-session-authority.ts:3737`），在队列内部暂停会死锁；今天的 `prepareOwnershipRelease` 也是先停续约（`managed-session-assembly.ts:334-335`）。

   然后在队列的同一轮里：
   - 执行待处理输入检查；
   - 把 activation 释放编码为下一个 journal 事务，但不应用；
   - 一直持有队列直到有结果，这样不会有别的东西基于同一个 head 编码。

   Session 正在 park 时，`releaseIdleOwner` 把它视为忙。

7. **提交。** 调用下文的 Store park 动词。
8. **结果。**
   - **不改变 head 和 writer 的拒绝**（lifecycle claim、quiescing placement）：丢弃暂存事务，恢复续约，清除闸门。
     - 只有同时确认了 writer 及其租约的拒绝才算“不改变”。今天的 release 先查 claim 和 `QUIESCING`，后查 writer（`JournalWriterLifecycle.java:502-511`），所以 park 动词必须先查 writer，或在拒绝中附上 writer 的检查结论。
     - 没有这个结论时，例如在一次结果未知之后，拒绝会导致丢弃 Session。
   - **其他所有拒绝都在本地丢弃 Session。** 包括 writer 或 proof 冲突、generation 已变、租约过期。过期由 Store 按数据库时间判定，Harness 不能用自己的时钟判断。在这类拒绝之后恢复续约，会悄悄重新获取 writer（`http-managed-session-store.ts:1281-1285`）。两种可能的 head（已封存，或 active 但租约已过）都能被重新获取。
   - **结果未知时保持闸门。** Harness 重试同一个操作，直到读回回执或拒绝。Store 先查回执再查 writer（`JournalWriterLifecycle.java:487-501`），而查回执之前只有 MAC 校验，所以即使后继者已经获取，原样重试仍能找到回执。
   - **拿到回执后**，停掉该 Session 的所有定时器，包括 channel reply-plan 重试——今天的 release 不会停它们（`hosted-harness-session.ts:6940-6963`），然后删除 Session。

**Store park 动词。** 一个 JDBC 事务完成以下几件事：

- 对暂存的 activation 释放执行 `JournalCommit` 的校验与 head 更新；
- 封存 head；
- 写回执；
- 清除 `is_wake_pending`，并把 `wake_head_revision` 设为新的 revision。只要 `wake_head_revision` 与 `journal_revision` 不同，`is_wake_scan_pending` 也为真（`V1__managed_schema.sql:222`）。

它的 fence 包括：

- writer：`ACTIVE` 的 head、writer id、generation 与 token，以及未过期的租约；
- 对 park 之前 revision、已提交 sequence 和最后 digest 的证明；
- 被释放的 activation id 与 epoch；
- `requireNoLifecycleClaim`，与现有 release 相同（`JournalWriterLifecycle.java:506`）。

在 pool 里它还会把 `ACTIVE` 的 placement 改为 `RELEASED`，并校验 epoch。

回执：

- 以 writer generation 为键，有 placement 时以 placement epoch 为键；
- 带上提交后的 revision、sequence 和 digest，SQL 的 `ready` 视图需要它们。今天的回执照抄请求里的 revision 和 commit proof（`JournalWriterLifecycle.java:481-483`），它们之所以等于最终 head，只是因为 activation 释放在调用之前已经提交（`:511-515`）。park 的请求证明的是 park 之前的 head，所以回执需要在 proof 之外另带提交后的字段：`committedSequence` 必须等于 proof 中的值（`ManagedHarnessReleaseRecords.java:32-34`）。schema 还要求 `instanceId`、`bootId` 和 `placementEpoch`（`:14-24`），单地址模式没有这些值；
- 需要保留规则。每次 park 写一行 resource、一行 record 和一行 ref（`JournalWriterLifecycle.java:527-539`），而今天的回执每个 placement epoch 只有一张。至少保留最新一张，这样原样重试仍能找到它。

该动词应沿用现有的加锁顺序：先 placement guard，再 tenant guard，再 Session root，与 release 一致（`JournalWriterLifecycle.java:465-467`）。

`JournalCommit.commitCsiTerminal`（`JournalCommit.java:483`）是先例：它已经把暂存的 activation 释放与封存 head 放在一起提交。

wake 提示必须清除，因为留着它代价很高：

- head 有主期间，任何接收过 channel、automation、消息、child、Monitor 或 workflow 输入的 Session 都会一直带着 `is_wake_pending`（`JournalCommit.java:361`）。
- 封存的 head 是无主的，而清除提示的扫描要从头重读 journal（`WakeRecoveryStore.java:109-139`）。

这样清除会改变一条不变量。`2026-10-18-hosted-wake-recovery.md` 只在独立重放已提交前缀之后才清除提示，`WakeRecoveryStore.java:243` 也写明：“Only a full prefix at this exact revision may clear the hint”。park 用 writer 自己的断言替代了这道兜底。理由有三点：

- writer 本来就能为同样的输入提交 `turn.settled`；
- 对未压缩的 journal，它内存中的前缀是完整的；
- park 要求任何来源都没有待处理输入，这是扫描所统计的六种来源的超集（`hosted-wake-intake.ts:42-57`、`WakeRecoveryStore.java:27-28`）。proof 对 head 做了 fence。

压缩过的 journal 沿用今天的规则。

**今天的原语都会锁存（一经触发不可撤销），不能原样复用。**

- `prepareOwnershipRelease` 在封存之前就提交 activation 释放（`managed-session-assembly.ts:329-341`）。
- 续约循环的 `stop()` 不可恢复（`managed-session-assembly.ts:111-115`）。
- Store client 的 `ownershipRelease` 拦截之后的所有请求（`http-managed-session-store.ts:2899`），`stopWriterRenewal` 永久停止续约（`:2492`、`:2662`）。
- `prepareOriginalCsiRelease`（`managed-session-authority.ts:3891-3954`）已经能编码一次释放而不应用，交给 Store 与退役一起提交。但它会锁存 authority（`:3343-3349`）。

park 需要这些原语的不锁存版本。被拒绝时 authority 保持一致：只有 `applyCommitted` 会推进它的已提交状态（`managed-session-authority.ts:3578-3618`）。

**单地址模式下的 fence。** 一次写入的 fence 包括：`ACTIVE` 的 head、writer id（即 Harness 的 boot id）、generation、writer token，以及未过期的租约（`JournalFencing.java:288-299`）。

token 分不出不同的 Harness：

- 有 binding key 时，它是每个 Harness 都会拿到的按 Session 计算的 MAC（`WriterCredentialPolicy.java:55-62`）。
- 没有 binding key 时，每个 Store client 自己生成一个随机 token（`http-managed-session-store.ts:1034-1035`）。它能 fence 一个活着的租约，但和 MAC 一样，head 一旦封存就拦不住新的获取。

封存之后，任何 writer 都能以下一个 generation 获取（`JournalWriterLifecycle.java:258-301`）。所以只要 Session 处于 park 状态，旧 Harness 的过期 load 就能重新打开它。

- 今天 detach 或 close 也会封存 head，但控制面只在 lifecycle claim 下 detach，之后普通获取都会被拒绝（`JournalWriterLifecycle.java:186-197`）。所以实际上，这种暴露今天只在租约过期之后才存在。
- 在 drain 期间，pool 的 placement epoch 防住了这一点，而单地址模式没有 placement epoch。问题 2 问的就是这是否可以接受。
- 下一次获取会递增 generation，load 会签发新的 `clientId`。

**Java。** 为准入类动词定一条 connector 规则：prompt、审批与问题的回答，以及 channel、automation、消息和 child 操作。

- 缓存的 attachment 收到 `404 hosted_session_not_found` 时，经被动 load 重试一次。404 来自闸门，或来自处理器在做任何工作之前的身份检查（`hosted-harness-session.ts:1214-1229`）；relay 动词按派生的 command id 重放，所以重试不会把任何事情执行两次。
- 用 compare-and-remove 移除该条目，与 `doSettleLifecycle` 一样（`QwenHostedHarnessConnector.java:357-360`）。只有移除成功时，才同时移除它的 pending recovery 和 `mcpManagementAttachments` 条目。否则一个过期引用的 404 可能抹掉并发的恢复 load 刚刚写入的条目。
- Turn 路径上的 404 走 `recoverManagedRuntime`，这样 `pendingRecovery` 和 `bindRecoveredHarness` 仍然生效。
- 在 pool 里，重试要重新经过 `HarnessPoolConnector.select`，并允许获取。leaf connector 的线程局部 `PoolCall` 仍带着旧的 placement（`QwenHostedHarnessConnector.java:126-137`）。
- lifecycle settle 保持“不存在不能证明任何事”的规则。
- cancel 不适用这条规则，因为它的 404 可能出现在副作用之后（`hosted-harness-session.ts:11743-11745`）。
- `409 hosted_session_parking` 表示等待。对 Turn 路径，它加入 `isPoolWait`（`HarnessCoordinator.java:1694-1703`）。relay 动词也需要同样的等待，因为今天它们会把 Harness 的 409 原样返回。
- 心跳退役 attachment 时，SDK 通知 connector。这样规则之外的动词看到过期引用的时间，每个节点最多一个心跳间隔。这些动词是：rename、读取 context compression、打开 Turn 的 Harness 流、MCP 管理、扩展管理（`applyExtensions`、`continueExtensionOperation`）以及 cancel。
- pool 的动词每次调用都会从 SQL 重新选择（`HarnessPoolConnector.java:245-300`），所以过期引用主要是单地址模式的问题。
- 对于当前 revision 上已封存且带有释放回执、没有未结输入的 head，`GET` session 直接根据 SQL 报 `ready`。

prompt 准入会对照 journal 去重，而已 park 的 Session 没有待处理的 action。这些改动也补上了 #15795 背后那个 drain 时期留下的缺口，所以可以先落地。

**唤醒就是现有的 load。** 只有 writer 会追加，所以 Session 处于 park 状态时不会有任何提交。

已 park 的 Session 会在以下情况重新加载：

- 某个动词缓存未命中；
- 一次会打到 Harness 的读取，例如读取 context compression 或打开 Turn 的 Harness 流（`QwenHostedHarnessConnector.java:858`、`:1009`）。公共事件流由 SQL 提供，不会触发加载；
- park 之后才首次投递的 MQ wake 通知。`TransportWakeActivator` 会加载任何没有活 writer 的 head，而不检查输入是否仍待处理（`TransportWakeActivator.java:133-147`）。`claimWake` 每个 sequence 只认领一次，所以重复投递会被拒绝。第 0 阶段会统计这种情况的频率。

因为 head 已封存，load 会立即接管，不必等租约过期。

**park 期间仍能正常工作的部分**

| 工作                                          | 驱动方                               | park 期间的行为                                                                                          |
| --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| prompt、审批、问题                            | Java                                 | 下一个动词会加载 Session。有待处理的审批或问题意味着有 Turn 在运行，所以该 Session 不算空闲。            |
| cancel                                        | Java                                 | 缓存未命中时走恢复。已 park 的 Session 没有可取消的 Turn。过期的缓存引用会回 404，直到心跳通知把它丢掉。 |
| rename、context compression、MCP 与扩展管理   | Java                                 | 不适用 404 规则。缓存未命中时加载 Session；过期引用最多失败一个心跳间隔。                                |
| close、delete、archive                        | Java lifecycle                       | 先加载 Session，再走现有的关闭路径。                                                                     |
| automation、channel、Session 消息、child 结果 | Java 时钟与 relay                    | 它们会加载 Session。                                                                                     |
| 公共事件流                                    | SQL 与 event hub                     | 不受影响。Harness 自己的事件流随 Session 一起停止。                                                      |
| MQ owner 订阅                                 | `OwnerSubscriptions`                 | Session 没有活的 writer 后就不再订阅，MQ wake 会加载它。                                                 |
| 后台 Shell、Monitor                           | Harness 的 publisher 与 Monitor 循环 | 不可 park：Harness 之外没有任何东西接收它们的输出。                                                      |
| MCP server、Hooks                             | 为 Session 持有的 Runtime Session    | 第 5 阶段之前不可 park。                                                                                 |
| CSI 守护的 Session                            | —                                    | 不可 park。                                                                                              |

## 阶段

0. **先测量，再定默认值。** 首批测量结果见下文，它们改变了后续阶段的顺序。尚未测量的有：
   - 已 park 的 Session 在没有新输入时被重新加载的频率，例如被迟到的 MQ wake 通知触发；
   - 在真实部署中，上述每项阻塞条件各排除了多少常驻 Session。#16320 的 rig 上每个 Session 都跑过 Shell，单是 publisher 一项就把它们全部排除了。
1. **让“持有”只表示仍在运行的工作。**
   - Session 的 publisher 在没有打开的 capture、也没有持有的 Runtime 时关闭。
   - Monitor 循环停止时移除。
   - `heldRuntimeTurns` 条目在 hold 结束时移除，并在 Broker 释放对应的 Runtime Session。否则下一次 load 会从 Broker 的 hold 行把条目加回来，而这些行只有 Runtime Session 的 `RELEASED` 记录才能消除（`RuntimeHoldInventory.java:13-21`）。这会改变 close 需要 drain 的内容。

   这与 #16320 第 7 步的共享 publisher 监听有重叠，两者需要排定先后。

2. **Java 侧的容忍。** connector 规则、心跳通知和恢复视图。即使没有 parking，这些也有用。
3. **降低 load 在每个历史 Turn 上的成本。** Workspace load 至少会把 journal 中的每一个持久引用读一遍，第 0 阶段测得每个历史 Turn 约 43 次读取、870 条语句（见下文）。对于 park 时间不长的 Session，parking 的花费会超过它省下的。可选方案：
   - (a) **每个正文只读一次。** 复用恢复校验已经读到的字节：
     - 把它读到的消息正文放进消息正文缓存，projection 就不必再读一遍；
     - 让 checkpoint、Shell 回执和 tool-result manifest 的检查使用这些字节，而不是再读一次（`hosted-harness-session.ts:2792`、`:2623`、`:3023`）；
     - 对 load 路由先读过、恢复校验又读一遍的 definition、instructions 和 skills 也这样处理；打开 Session 时已校验、恢复校验又重新排队读取的容器类记录也一样（`RESTORE_CONTAINER_KINDS`，`hosted-harness-session.ts:410-429`、`:2683-2686`）。

     这不改变任何安全性质。

   - (b) **批量读取。** 每批引用经一次 Store 调用、在一个读租约下校验并读取，而不是每个资源各走一轮读租约。批量调用保留今天单次读取的全部检查，包括：writer 凭证与读授权，head、退役与 CSI 检查，重新计算 digest（`JournalStoreRows.java:489`），拒绝被隔离的 tool outcome（`:492-501`），tool publication 的 capture 匹配，以及读取之后的租约检查。
   - (c) **跳过干净 park 已覆盖的部分。** 有干净的 park 回执时，跳过重读其 commit proof 所覆盖的引用，改为每个引用在首次使用时再校验。
     - 重建状态仍要读取消息正文和扩展记录的正文，所以这只能去掉其余的读取。
     - 一个永远不会被首次使用的引用，就再也不会被检查。
     - 没有“首次使用”的检查会随这些读取一起被去掉，包括：
       - 引用冲突检查（`hosted-harness-session.ts:2690-2701`）；
       - checkpoint 布局拒绝（`:2794-2798`）；
       - publication 回执的交叉核对（`:2935`），以及 publication 必须有已校验回执的检查（`:3035`）；
       - capture 完整性与内容 digest 校验（`:2952-2987`、`:3038-3040`）；
       - detached capture 的血缘检查（`:3042-3072`）。

       交叉核对所支撑的 `publication_incomplete` load 拒绝（`:7707-7731`）也会一并去掉，除非干净的 park 要求所有 capture 都已完成。

     - 资源丢失时，失败的是某个 Turn，而不是 load 回 `409 hosted_turn_recovery_required`、reason 为 `restore_verification_failed`。

   这些方案都不能让 load 与历史长度无关，因为 Session 需要的状态（它的消息和扩展记录）会随历史增长。它们降低的是每个历史 Turn 的成本。问题 5 问选哪些。

4. **为没有 MCP、Hooks 或活动后台运行的 Session 实现 parking。** 包括：
   - 单事务的 Store park 动词及其回执结构；
   - 不锁存的暂存、续约暂停，以及 Store client 的 park；
   - 空闲计时、按 Session 的条件，以及对 POST 和 load 的闸门；
   - 结果未知时的重试规则；
   - `park-after` 设置，在第 3 阶段之后按 load 成本定出数值之前默认关闭；
   - 测试：输入、load、Java 或 Harness 重启与一次释放之间的竞态。
5. **MCP 与 Hook Session。** 二选一：
   - (a) park 期间继续持有它们的 Runtime Session，load 时接管它，且不把空闲的 hold 算作工作。
   - (b) park 时停掉这些 server，唤醒时再启动。这会释放沙箱内存，但唤醒后的第一个 Turn 要加上它们的启动时间。

不在范围内：

- 回收空闲的 Runtime binding 或 Workspace。`2026-10-15-managed-workspace-resident-runtime.md` §4.5 把它延后了。
- 在 Harness 之外接收后台 Shell 的输出。

## 第 0 阶段结果

**环境。** 使用 #16320 的 rig，在一台 16 核 Linux x86_64 主机上运行，从 `main` 的 `a32684604a` 构建。该构建与引用基准 `0807f5d391` 相比，`hosted-harness-session.ts` 只在 `retryHostedCleanup` 及其 `cleanupRetry` 字段上有差异，读取路径相同。运行的组件：

- Spring exec jar，内嵌 Runtime Broker；
- `qwen serve --profile hosted-harness`；
- Docker 中的 MySQL 8.4.6，跑在 tmpfs 上且关闭了 binlog。所以耗时只是下界，但语句数不受影响；
- 脚本化模型，每个 Turn 发起一次经批准的 `run_shell_command` 调用。

**步骤。**

1. 建立三个 Session，历史分别为 1、40、200 个 Turn。
2. 在每个 Session 仍处于加载状态时测一个 Turn。
3. 优雅停止 Harness，再启动一个新的，并等待 65 s，让旧的写租约过期。
4. 逐个 Session 测量加载后的第一个和第二个 Turn，一次只测一个 Session。

重启后的 Harness 加载 Session 走的是与 park 后唤醒相同的 `open()`：重放 journal、执行 Workspace 恢复校验、从冷的消息正文缓存开始。有两点不同：

- rig 中的 head 是租约已过期的 active head，而不是已封存的 head。两者走同一条接管路径。
- Java 先要接受新的 Harness generation。这花了约 1.7 s，落在第一个被测的 Session 上，所以 1 个 Turn 那一行的 3.3 s 里约一半是重启开销。

|        历史 | 加载状态下的 Turn    | 加载后的第一个 Turn    | 其中 load 请求本身 | 加载后的第二个 Turn |
| ----------: | -------------------- | ---------------------- | -----------------: | ------------------- |
|   1 个 Turn | 2,681 条语句，0.84 s | 5,093 条语句，3.3 s    |             0.37 s | 2,673 条语句        |
|  40 个 Turn | 2,678 条语句，0.84 s | 38,705 条语句，4.5 s   |              3.3 s | 2,682 条语句        |
| 200 个 Turn | 2,713 条语句，1.25 s | 177,992 条语句，18.5 s |             17.2 s | 2,732 条语句        |

因为第 2 步那个加载状态下的 Turn 先跑了，每次 load 之前的历史比“历史”一列多一个 Turn。所以这三次 load 重放的是 2、41、201 个 Turn。

**成本花在哪里。**

- 每多一个历史 Turn，一次 load 大约多出 870 条语句和 85 ms。
- 在 200 个 Turn 时，加载后的第一个 Turn 还用了 14 s 的 Java CPU 和 43 s 的 MySQL CPU；加载状态下分别只要 0.4 s 和 0.3 s。
- 几乎全部花在读取资源上。200 个 Turn 的那次 load 之后，第一个 Turn 走了 8,681 轮读租约，而加载状态下的一个 Turn 只走 32 轮。每一轮约 20 条语句，包括：查询资源行，head 与退役检查，建租约、检查租约、删租约，更新 `last_verified_at`，读时钟，`ma_session` 的 upsert，以及提交。这些合计约占多出语句的 99%。
- 随历史增长的读取发生在 load 请求里。load 本身的耗时每个历史 Turn 增长约 85 ms，而第一个 Turn 的其余部分在各个历史长度下都约为 1.2–1.3 s。对 1 个 Turn 那一行，需扣除 1.7 s 的 generation 接受时间后才成立。读租约次数符合 32 + 6 + 每个历史 Turn 43 次；那 6 次固定的额外读取少到可以忽略。
- 随历史增长的读取来自三处，都经过 Store：
  - 重放 journal 时重建扩展记录并读取它们的正文（`rebuildExtensionRecords`，`managed-session-authority.ts:3112`，在 Session 打开时执行）；
  - Workspace 恢复校验读取 journal 中的每一个持久引用（包括消息正文），并逐一与其 digest 比对（`verifyWorkspaceRestore`，`hosted-harness-session.ts:2666`）；
  - 校验随后对消息做 projection（`:3074`），又把消息正文读一遍，因为 #16337 的缓存只保留它自己读过的正文。

  这些并不是仅有的重复读取。恢复校验自身会把 checkpoint、Shell 回执和 tool-result manifest 各读两遍；会把 load 路由已经读过的 definition、instructions 和 skills 再读一遍；还会把打开 Session 时已校验过的容器类记录重新排队读取。rig 没有记录读取在各处之间如何分布。

- 语句耗时主要花在 `ma_session` 的 upsert 上。在 200 个 Turn 的那次 load 之后的第一个 Turn 中，它占了 82.6 s 语句总耗时中的 69.9 s，每次 8.0 ms；在加载状态下的 Turn 中只有 0.33 ms 和 0.17 ms。
  - 这符合在等这一行的锁。恢复校验一次并发 32 个读取（`RESTORE_READ_BATCH`，`hosted-harness-session.ts:404`），每个读取都会 upsert 同一行 `ma_session`。
  - digest 不记录锁等待时间，所以这只是推断。

**parking 能省下什么。**

- **空闲流量与回本时间。**
  - 每个常驻 Session 的空闲流量是每分钟 51–56 条语句，这是 #16320 测得的数字，本次运行没有测空闲流量。
  - 一个 Session 要 park 足够久，下一次唤醒的花费才会低于它省下的空闲流量；每多一个历史 Turn，这段时间就长约 16 分钟。折算下来，1 个 Turn 的 Session 约 45 分钟，40 个 Turn 的约 11–12 小时，200 个 Turn 的 52–57 小时。
  - 假设空闲时一条语句的开销与加载状态下 Turn 中的一条语句相同，按 MySQL CPU 算情况更糟：在 40 和 200 个 Turn 的 load 中，冷 load 每条语句消耗的 MySQL CPU 约是两倍（1 个 Turn 的 load 为 1.2 倍），rig 没有查明原因。
  - 唤醒还会让第一个 Turn 每个历史 Turn 多出约 85 ms：200 个 Turn 时多 17 s。
- **Harness 内存。** 这些数字只针对 Harness 进程，在强制 GC 之后测得，不含三个 Runtime worker。在重启后的 Harness 中，加载任何 Session 之前，堆为 90.3 MiB、USS 163.3 MiB；三个 Session 重新加载后为 119.8 MiB 和 294.7 MiB。USS 的增长大多是原生内存或保留的分配，而不是堆。消息正文缓存的上限是 64 MiB，但这里它占用不到 1 MiB：external 内存只增长了 0.9 MiB。

  这部分增长并不是卸载能还回的量。重启前，旧 Harness 加载着同样三个 Session，堆同样是 119.8 MiB，USS 却是 334.6 MiB。可见 USS 取决于进程的经历：预热，以及分配器保留的内存。三个 Session 自身的状态合计最多是那 29.5 MiB 的堆增长，其中约 24 MiB 在代码区之外。卸载到底能还回多少，要在同一进程内实际卸载一次才能测出。

所以第 3 阶段要排在 parking 之前。

## 需要达成一致的问题

1. 是否按提案由 Harness 负责触发？由 Java 负责触发，就需要一把所有控制面节点和每个动词共用的按 Session 锁。
2. 单地址模式：只要 Session 处于 park 状态，过期 load 就能重新打开它；在这种情况下，writer fence（boot id、generation、租约）是否足够？还是应该给单地址模式也加一行 placement，让 placement epoch 像在 pool 里那样做 fence？
3. 第 5 阶段：MCP server 是在 park 期间继续运行 (a)，还是在唤醒时重启 (b)？这决定了 parking 能为目标部署省下多少。
4. 已 park 的 Session 是否应在公共 API 中可见，例如在 `ready` 旁加一个字段，还是只体现在指标里？
5. 第 3 阶段：每个正文只读一次 (a) 加批量读取 (b) 是否足够？还是在有干净的 park 回执时，唤醒还应跳过重读回执所覆盖的内容 (c)？方案 (c) 会把资源丢失或损坏的发现推迟到它第一次被使用时，而这一刻可能永远不会到来，并且失败的会是某个 Turn，而不是 load 被拒绝。它还会去掉那些没有“首次使用”的检查，其中包括 publication、capture 与血缘检查，以及 `publication_incomplete` 拒绝，除非干净的 park 要求所有 capture 都已完成。
