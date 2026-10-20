# FG11e：托管事件流中的 stream gap

[English](2026-10-20-automation-stream-gap.md) | [简体中文](2026-10-20-automation-stream-gap.zh-CN.md)

状态：提案。尚无可用门禁；本文定界该门禁必须钉住什么，以及动手前必须先定位什么。

Issue：#14446，FG11 tracker。`e` 行把事件流中的缺口记为审计点名的第二个洞，
生命周期门禁（FG11d）与发布门禁（FG11f）都没有覆盖它。

## 为什么

其余 FG11 切片故障的是 automation **做了什么**——丢应答、存储失败、崩溃、
发布。它们都假设客户端读到的事件 journal 是连续的。已有三道门禁覆盖其它流的
连续性——FG6e 的 `sse-gap` driver、FG8e 的断开续传用例、FG12f 的
`HostedMcpStreamGapIT`——因此 FG11e 是它们没有覆盖的 automation journal 切片。
它们都没有回答的是：这份 journal 不连续时会怎样——一个已处理到序号 `N` 的
消费者，下一次收到 `N + k`，中间的事件就丢了；而恢复路径恰恰是「重复的副作用」
与「重放」无法区分的地方。

这对 automation 尤其重要，因为它的工作由 journal 驱动。被悄悄抹平的缺口会丢掉
一次 `fire_run`；过于激进的重放会让同一个 occurrence 触发两次——正是 FG11a 与
FG11b 从相反方向钉住的失效形态。

## 这里的 gap 是什么

三种形态，只有第一种在链路可见：

- **投递缺口。** 客户端读到的流跳过了序号。代理、丢失的 SSE 帧、被杀掉的连接
  都会产生它。
- **投影缺口。** `ma_event_stream` 上的 `covered_sequence` 越过了从未投影进可读
  记录的事件。客户端看到的是一份自洽但缺历史的记录。
- **认领后激活丢失。** `wake_covered_sequence` 是去重水位，不是完成水位：
  `TransportWakeActivator.onWake` 先认领序号再提交 load，提交被拒时认领仍然
  保留，并把该 wake 留给 SQL wake recovery。因此延迟或乱序的 wake 是正常的；
  故障更窄——认领已提交而激活从未执行（进程退出、load 被丢弃）。性质是独立的
  SQL wake recovery 仍能找到已提交且未消费的输入，且认领水位绝不当作进度读。

## 来自 tracker 的范围

tracker 的 FG11e 行点名三个场景；前两个不被上面的 journal 形态覆盖，因此在此
定界而不是丢弃：

- **task 流续传。** 在 `fire` 与 `settle` 之间断开该 run 的 task 事件流，再续传，
  断言投递序列：断开前收到的前缀与续传后收到的后缀拼接起来，必须与 task 持久化
  的状态事件序列逐项、按序一致，无重复、无缺失。`ManagedTaskEventStore.read`
  按 task 自身的 sequence 严格续读，这正是该拼接可核对的前提。终态恰好一次是
  附加检查，而非契约：重放重复一条 running 迁移时，终态仍只交付一次。
- **列表游标稳定。** 在插入新 run 的同时翻页 Session 的 runs 列表，断言跨页边界
  没有条目被跳过或重复。
- **Session SSE 续传。** 用 `Last-Event-ID` 续传 Session 流；这首先需要确认
  automation 事件在该流上是否可观测，若不可观测，则把该场景记为延期，并把该
  检查写成前置条件。

## 门禁会依赖的机制

- `ma_event_stream` 每个 Session 携带 `last_sequence`、`replay_floor_sequence`、
  `covered_sequence`、`wake_covered_sequence`，以及 `current_snapshot_id`、
  `snapshot_stale_since`。
- `TransportConsumerStore.claimWake(tenant, session, sequence)` 是对水位线的条件
  更新：每个高于上次认领的序号恰好返回一次 true。这就是门禁可读的去重证据。
- `TransportConsumerStore.materializedThrough(tenant, session)` 报告一个 PUBLIC
  且未退役 Session 的投影已到达的 `covered_sequence`。
- `ManagedSnapshotStore` 掌管快照回退：写入 `current_snapshot_id`，并在覆盖序号
  超过快照时置 `snapshot_stale_since`。

## 门禁必须钉住什么

1. **缺口被检测到，而不是被吸收。** 位于「从未收到过的序号」之下的消费者必须
   走重放或快照路径，绝不从 `last_sequence` 悄悄续读。
2. **没有重复副作用。** 无论恢复路径重投什么，occurrence 至多触发一次、run 恰好
   结算一次。这是 FG11a/b 从丢应答侧钉过的性质；缺口门禁要从缺事件侧再钉一遍。
3. **没有丢失的 occurrence。** 落在缺口内的事件所属 occurrence 仍须进入终态，
   或有证据地保持未决。沉默即失败。
4. **快照回退按证据选择。** 游标低于 `replay_floor_sequence` 即触发回退，与陈旧
   与否无关：`ManagedSnapshotStore` 只在 `covered_sequence` 越过快照时才置
   `snapshot_stale_since`，所以穿越 floor 的游标可能遇到仍然最新的快照。门禁
   必须检查快照自身的覆盖范围与之后的续读，并把「新快照」与「陈旧快照」分成
   两个用例。

## 夹具要求

- 一个能在保持序号编号不变的前提下丢掉流中单个事件的 relay；
  现有 `HostedLifecycleRelay` 丢的是应答而不是帧，因此这里需要帧级钩子。
- 真实 MySQL，因为上面每条性质都从 `ma_event_stream` 与 `ma_session_record` 读，
  不是从进程内存读。
- 上述断言集，加上现有的「一次 run、一个 Turn、一次执行」计数，使重放无法靠
  把工作做两遍而通过。

## 未解问题

- 「重放」还是「快照」的分支已经定位：游标低于 `replay_floor_sequence` 时
  `ManagedAgentService.replayableEvents` 抛 `ReplayCursorExpired`，
  `ManagedEventStreamService` 把它转成一帧 resync。仍未解的问题更窄——哪些
  automation 事件类型会进入 Session 流，以及同一序号下如何区分「投影缺口」与
  「投影较慢」。
- 客户端可见契约存在于 FG11 设计集之外，写在
  `docs/design/2026-09-27-managed-agent-event-replay.md`（含同版 `.zh-CN.md`）：
  JSON 读以 `409 cursor_expired` 返回 `replay_floor_sequence` 与
  `snapshot_through_sequence`，流则发送一帧携带 `reload_snapshot` 的
  `agent.session.resync_required`，且刻意不带 `id`，使重连不会跳过客户端缺失的
  事件。仍未解的是 automation 消费者是否遵守 `reload_snapshot`。

## 限制

- 各臂描述的是 journal 与投影中的故障，不是客户端与服务端之间的传输；截断响应
  的代理属于另一道门禁。
- 本文不含任何实现。它是后续切片所需的范围，存在的目的是让下一位作者不必再从
  schema 重新推导这三种缺口形态。

## 验收

- 每臂在 JDK 21 + 真实 MySQL 8 上全绿，经 hosted automation profile 选择。
- 每个臂在移除其故障臂后于其所指位置报红。
- 双语气结构一致地交付。
