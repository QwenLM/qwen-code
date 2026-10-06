# Managed Agent 事件回放（D3 阶段）

[English](2026-09-27-managed-agent-event-replay.md) | [简体中文](2026-09-27-managed-agent-event-replay.zh-CN.md)

状态：已在本次变更中实现
日期：2026-09-27
Issue：[#12793](https://github.com/QwenLM/qwen-code/issues/12793)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
前置：[Managed Agent API 契约（D1 阶段）](2026-09-27-managed-agent-api-contract.zh-CN.md) 与 [会话查询（D2 阶段）](2026-09-27-managed-agent-session-query.zh-CN.md)

## 1. 问题

D2 之后，事件路由与契约仍有以下差异：

- JSON 事件查询即使整页已满也返回 `has_more: false` 与 `next_cursor: null`，并拒绝
  超过 100 的 limit，而契约允许 1000。WebShell transcript 的 limit 同样如此。
- 没有回放下限。`replay_floor_sequence` 固定为 `0`，没有任何路径返回
  `409 cursor_expired`，两个事件流也都不发送 `agent.session.resync_required`。
- 公共与 WebShell 事件缺少 `schema_version`、`projection_version` 以及顶层的
  `item_id` 与 `content_part_id`，事件表也没有对应的列。
- `capabilities` 把 `snapshots` 与 `resync` 报告为 `false`。

关闭这些差异时又发现两个问题：

- 文本增量在 `data.contentPartId` 中携带 `part_<turn>_<type>`，而 Items 投影给
  Part 的名字是 `part_<turn>_<type>_<首个 sequence>`。把 data 字段直接上移到顶层，
  会指向 Snapshot 中并不存在的 Part。
- spec 没有 resync 帧的 schema，并且为 WebShell 事件流声明了 `409`；而
  [公共 API 契约][contract]第 4 节规定事件流改为发送 resync 帧。

issue 为 D3 规定的验收条件是：事件查询与事件流、WebShell 事件流与 WebShell
transcript 改为 `implemented`，测试覆盖 `Last-Event-ID` 续传、历史补齐切换到实时、
订阅溢出以及由测试推进的下限：不重复、不跳序，并正确返回 `cursor_expired` 或
resync。

## 2. 目标

- 关闭差异文件中所有 D3 行，且不新增差异行。
- 把 `getSessionEvents`、`webShellStreamEvents` 与 `webShellTranscript` 改为
  `implemented`。
- 每条事件随其保存版本与 Item/Part 身份，回放返回事件被接受时的值。
- 为每个 Session 持久化回放下限，并据此回应过期游标。

## 3. 非目标

- 清理事件。生产环境中目前没有任何路径提升下限，这属于保留策略的工作。
- WebShell Session 的 `replayFloorSequence` 与 `snapshotThroughSequence`，仍为
  `planned`。
- `listItems`，在 Snapshot 版本分页之前仍为 `partial`。
- 发布事件、提交与取消的持久准入。

## 4. 决策

### 4.1 契约 v1.17

- 上述三个 operation 改为 `implemented`。
- `next_cursor` 是下一页的 `after` 值，即本页最后一条事件的 sequence 的十进制
  字符串；`has_more` 为 `false` 时为 `null`。
- 两个 schema 描述 resync 帧：公共事件流用 `SessionResyncRequired`，WebShell
  事件流用 `WebShellResyncRequired`。两者都包含类型、Session id、回放下限、
  Snapshot 已覆盖的 sequence，以及动作 `reload_snapshot`。每个事件流的
  `text/event-stream` 媒体类型通过 `x-qwen-resync-frame` 指向对应 schema。契约
  测试据此校验 resync 帧，这个引用也让生成器输出 WebShell 类型。
- WebShell 事件流不再声明 `409`。服务端从未返回过它；过期的 `afterSequence`
  与公共事件流一样，以 resync 帧结束事件流。
- `content_part_id` 与 `contentPartId` 允许 128 个字符，与
  `PublicContentPart.part_id` 一致。Part id 以 sequence 结尾，sequence 达到十位数
  时就会超过 64 个字符。
- `replay_floor_sequence` 增加说明：不超过它的事件可能被清理，低于它的游标已
  过期。
- `SessionResyncRequired` 要求客户端从 Items 列表返回的 `snapshot_through_sequence`
  之后继续，因为帧中的值可能比客户端随后读到的 Snapshot 更旧。
- WebShell transcript 写明它原本的返回内容：没有游标时，有 Snapshot 的 Session
  返回全部 Items、Snapshot 之前除 `turn.accepted`、`item.output_text.delta`、
  `item.reasoning.delta`、`item.tool_call.updated` 与 `item.tool_result.updated`
  （Items 已包含其内容）以外的事件，以及之后的所有事件；其他情况下由 `limit`
  限定事件分页。
- `PublicEvent` 与 `WebShellEvent` 写明事件以被接受时的版本与身份回放，唯一的例外
  是 `stream.reconciled` 事件之后；此前契约并未提及该事件（见 4.2）。由于 Snapshot
  在它之后重建，公共客户端要重新读取 Items，直到其 `snapshot_through_sequence`
  达到该事件，然后从这个 `snapshot_through_sequence` 之后继续。如果改为从
  `stream.reconciled` 事件之后继续，就会再次应用 Snapshot 中已有的增量。

### 4.2 版本与身份

Flyway V14 为 `managed_agent_event` 新增默认值为 `1` 的 `schema_version` 与
`projection_version`，以及 `item_id` 与 `content_part_id`，并为
`managed_agent_session` 新增 `replay_floor_sequence`。存储层为每条新事件写入这两个
版本的 1，回放读取已存储的值，因此以后的新版本不会改写旧事件。

`EventIdentity` 描述投影版本 1 为事件所修改的 Item 与 Part 命名的规则：

| 事件                                                        | `item_id`                                                                         | `content_part_id`                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `turn.accepted`                                             | `data.itemId`，否则为 `item_<turn>_input`                                         | 无；该事件填充多个 Part                                                                                   |
| 带文本的 `item.output_text.delta` 与 `item.reasoning.delta` | `data.itemId`，否则为 `item_<turn>_assistant`                                     | 如果紧邻的上一条事件是同一类型、同一 Item 的增量，则沿用它的 Part；否则为 `part_<turn>_<type>_<sequence>` |
| 文本为空的文本增量                                          | 无                                                                                | 无；投影会跳过它                                                                                          |
| `item.tool_call.updated` 与 `item.tool_result.updated`      | `data.itemId`，否则由工具调用 id 推导；没有工具调用 id 时由 turn 与 sequence 推导 | 无                                                                                                        |
| 其他事件                                                    | 无                                                                                | 无                                                                                                        |

这正是物化器构建 Items 时已经采用的规则，物化器现在也通过同一组辅助方法命名。
由于增量的 Part 只取决于它之前的那条事件，存储层在追加事件时就确定身份：文本增量
按主键读取上一条事件，其他事件不需要读取。`data.contentPartId` 保持原样，客户端
应使用顶层字段。

Flyway V15 是一个 Java 迁移，按同一规则为 V14 之前写入的事件补上身份。它从
Session 表中每页 1000 个地列出 Session，并按 sequence 顺序、每页 5000 条读取每个
Session 的事件，因此内存占用既不随 Session 数量增长，也不随 Session 的长度增长。
它只为四种有身份的事件类型读取 `data_json`，并把
身份相同的连续事件（例如同一个文本 Part）用一条范围更新写入。文本已被撤回清空的
增量不获得身份，这与存储层撤回后重建的 Items 一致。`EventIdentity` 对存储层与 V15
而言都是投影版本 1；不同的规则需要新的投影版本，而不是修改它。

撤回（Harness 恢复期间的 `retractContinuationOutput`）会清空被撤回增量的文本并
重建 Items。随后存储层从第一条被撤回的事件起重新推导每条事件的身份，使被清空的
增量不指向任何内容，而接续了它的保留增量指向重建后的 Items 给出的 Part。这与撤回
本来就会改写的数据一起改写身份，随后的 `stream.reconciled` 事件会让客户端重新读取
Snapshot。

### 4.3 事件分页

- 事件查询与 WebShell transcript 接受 1 到 1000 的 limit，默认 100。Session 列表
  与 Items 列表仍为 1 到 100。
- 查询多读一条事件来确定 `has_more`。
- 事件流的历史补齐仍按每页 100 条读取。

### 4.4 回放下限

- 游标低于下限即为过期。等于下限的游标有效，因为下一条事件仍被保留。
- 读取在读完事件之后才检查下限。下限只会上升，保留策略也只清理下限以下的事件，
  因此读取之后不高于游标的下限，在读取期间也不高于游标。
- JSON 查询对过期游标返回 `409 cursor_expired`，错误信封带有契约早已定义的
  `replay_floor_sequence` 与 `snapshot_through_sequence`。`ApiException` 现在可以
  携带额外的信封字段。
- 事件流每次读取存储时都检查下限：开始时、内存 hub 溢出后、以及空闲等待之后。
  过期游标会收到一帧 `agent.session.resync_required`，随后事件流结束。该帧没有
  `id`，因此客户端的 `Last-Event-ID` 不会越过它缺失的事件。
- `ManagedAgentStore.advanceReplayFloor` 只提升、不降低下限，并且不超过 Snapshot
  已覆盖的 sequence，保证重新读取 Snapshot 的客户端可以从
  `snapshot_through_sequence` 之后继续。测试调用它；保留策略的工作将在删除事件之前
  调用它。
- `PublicSession.replay_floor_sequence` 返回已存储的下限。
- 事件流重整会丢弃 Snapshot，因此在 Items 重建之前，其已覆盖的 sequence 为 `0`。
  如果下限已被提升，这段时间内收到 resync 的公共客户端会发现游标再次过期（得到
  `409` 或又一帧 resync），直到重建完成。生产环境中目前没有任何路径提升下限；保留策略的工作必须在提升下限之前消除
  这段窗口。
- WebShell transcript 不检查下限。事件被清理之后，它的更早分页必须止于下限；这同样
  属于保留策略的工作。

### 4.5 能力

`snapshots` 与 `resync` 改为 `true`。Items 列表返回带有已覆盖 sequence 的
Snapshot，两个事件流都会发送 resync 帧。Items 列表的每一页都读取当前 Snapshot，
因此需要多页的客户端可能看到两个 Snapshot 版本；跨页固定同一版本是 `listItems`
剩余的工作。WebShell transcript 在一次响应中返回同一个 Snapshot。

### 4.6 WebShell 客户端

客户端根据事件名与缺失的 id 识别 resync 帧。provider 把它转换为已有的
`stream_gap` 事件，于是会话 hook 重新读取 transcript 并从其头部之后继续，与收到
`stream.reconciled` 后的处理相同。

hook 的 gap 恢复会把新 transcript 合并进当前展示的事件，而不是整体替换。快照对其
覆盖区间（[首个事件, lastSequence]）是权威的：区间内的实时事件若不在快照中——例如
服务端已将其组装进 Item 的流式 delta——会被丢弃而不是重复渲染；比快照头更新的实时
事件会在读取滞后时存活。窗口之下，用户翻页载入的事件仅在与窗口保持连续时才保留——
一旦出现空洞，空洞两侧的 delta 会被渲染器拼成同一条 assistant 消息，因此有空洞时翻页
内容会被丢弃、并采纳窗口的游标以便重新翻回——而 item 投影一律不保留：撤回之后服务端
以原始事件为准。分页游标跟随被保留的内容：非空快照携带全量历史时清空；客户端没有游标、
或被保留页与窗口之间出现空洞时采纳快照的游标；其余情况保留用户的游标。gap 重同步若未能
推进游标则记为一次停滞；连续第三次停滞会显示持续存在的错误，任何投递的事件或推进的
快照都会清零计数。

流客户端容忍损坏帧。data 载荷无法解析、解析结果没有字符串 `type`、或（流中间）没有
`data:` 行的帧都计为损坏。默认失败即关（fail closed）：只有文本可由快照重新组装的
delta 类型（`item.output_text.delta`、`item.reasoning.delta`）会被跳过并记录限流警告，
后续帧会把消费者的游标推过它；其余任何损坏帧——包括事件名不可用的帧——都会产出
resync。连续损坏超过三帧（即第四帧起，其间的心跳不打断计数，只有成功投递的事件才
清零）时同样产出 resync；整条连接只有跳过没有投递时也产出 resync。流末尾的残缺缓冲
是帧中断连：按断连记录，且不计入损坏预算。合成的 resync 帧携带占位水位
（`replayFloorSequence: 0`、`snapshotThroughSequence: 0`），客户端没有任何代码读取它们。

## 5. 测试

- 契约测试删除 14 行 D3 差异，只剩 3 行生命周期差异。它校验每个事件流帧，包括
  必须没有 id 的 resync 帧。在一个把下限提升到 Snapshot 的新 Session 上，JSON
  查询在低于下限时返回带两个水位的 `409`、在下限处返回 `200`，两个事件流都只回应
  一帧 resync。一致性测试检查新的能力值，并检查每条事件的 `item_id` 与
  `content_part_id` 都指向 Snapshot 中的 Item 与 Part。
- `ManagedEventReplayTest` 覆盖：
  - 按 `next_cursor` 翻页的 JSON 查询不跳序，包括必须报告 `has_more: false` 的
    满页最后一页，以及 1000 的 limit；
  - `Last-Event-ID` 优先于 `after`，并跨越每页 100 条的历史补齐后进入实时事件；
  - 与写入方竞争的历史补齐无缝、不重复地切换到实时事件；
  - 卡住的事件流落后 600 条事件，超过 hub 保留的 512 条（测试断言了这一前提），从
    存储重新读回被丢弃的事件，并且不发送 resync 帧；
  - 下限越过落后的事件流后，事件流在已送达的最后一条事件之后发送一帧 resync；
  - JSON 查询与两个事件流上的过期游标，以及下限的上限与单调性。

  卡住与落后事件流这两项在两个事件流上各跑一遍（它们各有自己的投递循环），并从
  非零游标续传。该测试集把轮询间隔与心跳间隔都设为一分钟，因此空闲的事件流在测试期间不会读取
  存储，实时事件只能经由 hub 到达事件流。

- `EventIdentityTest` 固定该规则。集成测试在以下情形后把每条事件的身份与物化后的
  Snapshot 对照：分两批追加、且有一个 reasoning Part 跨越两批的增量；逐条追加的
  增量；以及撤回，包括接续了被撤回增量的保留增量。
- 一个升级测试在 H2 的 MySQL 模式下于 V1 写入事件、执行迁移，并按规则与 Snapshot
  检查补上的身份。`ManagedAgentMySqlIT` 在 MySQL 上执行同样的升级，并在其上检查回放下限。
- web-shell 测试解码 resync 帧，检查 provider 只产出一个 `stream_gap` 后停止，并检查
  会话 hook 随后重新读取 transcript，从其头部之后重新订阅。hook 的 gap 合并测试钉住
  窗口语义：与窗口连续的翻页历史存活、被取代的 delta 被丢弃、游标跟随被保留的内容、
  连续无法推进的重同步会上报错误。流客户端的测试钉住坏帧策略：只有可重组装的 delta
  会被跳过（告警速率有界），其余任何损坏帧——包括事件名不可用的帧——都触发 resync；
  连续损坏超过三帧（即第四帧起）且其间没有成功解码事件时触发 resync（心跳不稀释计数）；
  帧中断连单独记录且不占预算；只有跳过的连接以 resync 结束。

## 6. 兼容性

- 事件只新增字段，Session 报告已存储的下限；没有删除任何内容。
- WebShell 事件流的 `409` 响应从契约中移除；服务端从未返回过它。
- V14 新增带默认值的列。V15 在迁移事务内分页列出 Session，再分页把每个
  Session 的事件读取一遍，并对每一段事件执行一条更新。在本地 MariaDB 上，它在三秒内迁移了 100 个 Session 中的 20 万条
  事件；短片段很多的表会更慢。
- 所有副本需要一起升级。V14 之后仍运行旧版本的副本写入的事件没有身份，新副本在
  其后追加的文本增量会开始一个 Items 中没有的 Part。
- 忽略 resync 帧的客户端会看到事件流结束，用同一个游标重连后再次收到该帧。
  web-shell 客户端会处理它。在保留策略的工作提升下限之前，生产环境中的事件流不会
  发送它。
- 生成的 `@qwen-code/web-shell` 类型新增 `WebShellResyncRequired`，事件流
  operation 不再列出 `409`。可选的事件字段原本就在 WebShell 事件 schema 中。

## 7. 验证

- Managed Agent 服务的完整测试与 Checkstyle 通过。
- `ManagedAgentMySqlIT` 在 CI 所用的 `mariadb:10.11.18` 以及 `mysql:8.4` 上通过。
- 打包后的 Spring Boot jar 把 MariaDB 数据库迁移到 V15，说明 Flyway 能在 jar 中
  找到这个 Java 迁移。
- 以下变更分别使对应测试失败：忽略 `Last-Event-ID`、跳过下限检查、hub 隐瞒溢出、
  hub 从不投递、不返回 `next_cursor`、满页的最后一页报告 `has_more`、每个增量都
  新建 Part、逐条追加时忽略上一条事件、撤回后跳过身份的重新推导、跳过 V15 回填、
  V15 越过缺口合并范围、V15 在分页边界丢失状态。
- WebShell 的 typecheck、managed 组件测试以及 managed-progress 与
  managed-workspace-w0d e2e 用例在重新生成的类型下通过。

## 8. 后续工作

- 保留策略：清理事件，在清理之前提升下限，在事件流重整重建 Items 期间把下限保持
  在 Snapshot 之下或与之相等，并让 WebShell transcript 的更早分页止于下限。
- WebShell Session 的下限与 Snapshot 水位。
- 带 Snapshot 版本分页的 `listItems`。
- 生命周期工作：剩余的三行差异。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
