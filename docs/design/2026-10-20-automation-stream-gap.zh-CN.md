# FG11e：托管事件流中的 stream gap

[English](2026-10-20-automation-stream-gap.md) | [简体中文](2026-10-20-automation-stream-gap.zh-CN.md)

状态：部分交付。tracker 行点名的三个场景由 `HostedAutomationFaultGatesIT` 中的
两个用例门控（见[已交付](#已交付)）；下文的 journal 缺口形态与快照回退性质仍只在
此定界，尚未实现。

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

## 已交付

`HostedAutomationFaultGatesIT` 中的两个用例，本地用 `-Phosted-automation-gates`
选择，CI 中由 `hosted-harness-mysql` 车道运行：

| 用例                                           | 场景                          |
| ---------------------------------------------- | ----------------------------- |
| `fg11eStreamsResumeAcrossTheSettleOnMySql`     | task 流续传、Session SSE 续传 |
| `fg11eRunListCursorHoldsAcrossAnInsertOnMySql` | 跨插入的列表游标稳定          |

**task 流续传。** 一次手动 run 的 wake Turn 被模型桩挂住，run 停在 fire 与
settle 之间。读者每页读一条该 run 的 task 事件，因此每个页边界都是一个续传点，
读到此处即断开。随后放行模型，run 结算为 `completed`，读者从最后一个游标续读。
当前主干上该 run 的 task journal 为 `pending → running → completed`，断点落在
`running` 之后。用例断言：

- 前缀与续读后缀逐项等于该 task 已提交的事件（游标、类型、时间、状态与
  Runtime 状态），序号为 `1..n`；
- 恰有一个终态，且位于最后；
- 从同一游标再次续读，得到相同后缀；
- 每一页都推进游标，因此交回自身位置的读取会立即失败，而不是一直翻页直到用例
  的超时上限。

**Session SSE 续传。** 可观测性检查在当前主干上已有答案：该 run 的 fire 与
settle 不向 Session 的公开 journal 写入任何事件。用例在等到公开 Turn 异步上报的
Runtime warm 结果之后，把这一点断言为该臂的前置条件。因此该臂门控的是跨越
fire 到 settle 窗口的续传，而不是 automation 内容。读取 Session 流的客户端在
run 被挂住时断开；settle 之后，一个公开 Turn 在没有客户端连接时追加一段尾部；
客户端带 `Last-Event-ID` 重连并读到尾部。拼接结果为 `1..n`，无缺失、无重复，
每一帧都对应其已提交的行。一旦某个投影开始把该 run 写入 Session 流，前置条件
这一行会报红，届时该臂的期望再扩展到 run 自身的帧。

**列表游标稳定。** 三次手动 run 结算后，以 `limit=2` 按从新到旧读取 run 列表。
随后插入第四次 run。用第一页的游标读取第二页，结果恰为最旧的 run：没有重复、
没有跳过，插入的 run 也不在其中。之后从头遍历，四个 run 各出现一次，从新到旧。

两个用例都另外核对每个 occurrence 只结算一次、只有一次模型 Turn，因此续传不能
靠把工作做两遍而通过。

### 变异见证

每个变异体都施加在所指的生产代码行上，对其用例运行后再还原：

| 变异体                                               | 用例报红位置                 |
| ---------------------------------------------------- | ---------------------------- |
| `ManagedTaskEventStore.read` 读取 `sequence_id >= ?` | 每一页都推进 task 游标       |
| 忽略 task 事件游标（读取从 `0` 重新开始）            | 每一页都推进 task 游标       |
| task 事件读取跳过一行（`sequence_id > ? + 1`）       | 断开前缀与续读后缀即 journal |
| 公开事件路由忽略 `Last-Event-ID`                     | Session 视图：无缺失、无重复 |
| run 列表边界变为包含（`occurrence_key <= ?`）        | 游标从第一页之下继续         |
| run 列表忽略游标                                     | 游标从第一页之下继续         |

在加入游标推进检查之前，第一个变异体只会撞上用例 600 s 的上限：一页交回自身
游标就会一直翻页下去。

### 未交付

- 上文三种 journal 缺口形态（由丢帧 relay 制造的投递缺口、投影缺口、认领后
  激活丢失），以及性质 4（按证据选择快照回退）。tracker 行没有点名它们。第一种
  需要夹具要求中的帧级 relay 钩子；性质 4 需要一个承载 automation 事件的
  Session 流。
- task 流的 `409 cursor_expired`：一次 run 的 task journal 只有三条事件，远低于
  256 的保留目标，因此本夹具中 floor 永远不会抬升。
- WebShell：没有 WebShell automation 路由，其 task 事件查询与公开读取共用同一
  路径，因此不单独覆盖。

### 预算

两个用例在 Linux x86_64 的 JDK 21 + MySQL 8.4.6 上分别测得 12.4–14.1 s 与
4.8–6.1 s，按较慢样本的 2 倍计 42 s。健康总和变为 10575 s，fork 变为 11175 s，
因此 Verify 步骤调到 197 分钟，job 上限调到 300。被断开的流在服务端会一直保持
打开，直到下一次写入失败；流用例与 FG9e 一样设置 2 s 心跳，使 Spring 的优雅
停机不必等满 30 s 窗口。

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
  `ManagedEventStreamService` 把它转成一帧 resync。哪些 automation 事件类型会
  进入 Session 流，在当前主干上已有答案：一个都没有（见[已交付](#已交付)）。仍
  未解的是同一序号下如何区分「投影缺口」与「投影较慢」。
- 客户端可见契约存在于 FG11 设计集之外，写在
  `docs/design/2026-09-27-managed-agent-event-replay.md`（含同版 `.zh-CN.md`）：
  JSON 读以 `409 cursor_expired` 返回 `replay_floor_sequence` 与
  `snapshot_through_sequence`，流则发送一帧携带 `reload_snapshot` 的
  `agent.session.resync_required`，且刻意不带 `id`，使重连不会跳过客户端缺失的
  事件。automation 消费者是否遵守 `reload_snapshot` 仍未解，且要等 automation
  事件进入 Session 流之后才可测。

## 限制

- 各臂描述的是 journal 与投影中的故障，不是客户端与服务端之间的传输；截断响应
  的代理属于另一道门禁。
- 只有 tracker 行的场景已实现。本文其余部分是后续切片所需的范围，存在的目的是
  让下一位作者不必再从 schema 重新推导这三种缺口形态。

## 验收

- 每臂在 JDK 21 + 真实 MySQL 8 上全绿，经 hosted automation profile 选择。
- 每个臂在移除其故障臂后于其所指位置报红。
- 双语气结构一致地交付。
