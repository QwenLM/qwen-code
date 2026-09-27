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

### 4.1 契约 v1.16

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

### 4.2 版本与身份

Flyway V14 为 `managed_agent_event` 新增默认值为 `1` 的 `schema_version` 与
`projection_version`，以及 `item_id` 与 `content_part_id`，并为
`managed_agent_session` 新增 `replay_floor_sequence`。存储层为每条新事件写入这两个
版本的 1，回放读取已存储的值，因此以后的新版本不会改写旧事件。

`EventIdentity` 描述投影版本 1 为事件所修改的 Item 与 Part 命名的规则：

| 事件                                                        | `item_id`                                     | `content_part_id`                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `turn.accepted`                                             | `data.itemId`，否则为 `item_<turn>_input`     | 无；该事件填充多个 Part                                                                                   |
| 带文本的 `item.output_text.delta` 与 `item.reasoning.delta` | `data.itemId`，否则为 `item_<turn>_assistant` | 如果紧邻的上一条事件是同一类型、同一 Item 的增量，则沿用它的 Part；否则为 `part_<turn>_<type>_<sequence>` |
| 文本为空的文本增量                                          | 无                                            | 无；投影会跳过它                                                                                          |
| `item.tool_call.updated`                                    | `data.itemId`，否则由工具调用 id 推导         | 无                                                                                                        |
| 其他事件                                                    | 无                                            | 无                                                                                                        |

这正是物化器构建 Items 时已经采用的规则，物化器现在也通过同一组辅助方法命名。
由于增量的 Part 只取决于它之前的那条事件，存储层在追加事件时就确定身份：文本增量
按主键读取上一条事件，其他事件不需要读取。`data.contentPartId` 保持原样，客户端
应使用顶层字段。

Flyway V15 是一个 Java 迁移，按同一规则为 V14 之前写入的事件补上身份，逐个
Session 按 sequence 顺序处理。它只为四种有身份的事件类型读取 `data_json`。文本
已被撤回清空的增量不获得身份，这与存储层撤回后重建的 Items 一致。事件被接受之后
才发生的撤回不会改变已存储的身份；随后的 `stream.reconciled` 事件会让客户端重新
读取 Snapshot。

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

### 4.5 能力

`snapshots` 与 `resync` 改为 `true`。Items 列表返回带有已覆盖 sequence 的
Snapshot，两个事件流都会发送 resync 帧。

### 4.6 WebShell 客户端

客户端根据事件名与缺失的 id 识别 resync 帧。provider 把它转换为已有的
`stream_gap` 事件，于是会话 hook 重新读取 transcript 并从其 `lastSequence` 之后
继续，与收到 `stream.reconciled` 后的处理相同。

## 5. 测试

- 契约测试删除 14 行 D3 差异，只剩 3 行生命周期差异。它校验每个事件流帧，包括
  必须没有 id 的 resync 帧。在一个把下限提升到 Snapshot 的新 Session 上，JSON
  查询在低于下限时返回带两个水位的 `409`、在下限处返回 `200`，两个事件流都只回应
  一帧 resync。一致性测试检查新的能力值，并检查每条事件的 `item_id` 与
  `content_part_id` 都指向 Snapshot 中的 Item 与 Part。
- `ManagedEventReplayTest` 覆盖：
  - 按 `next_cursor` 翻页的 JSON 查询不跳序，以及 1000 的 limit；
  - `Last-Event-ID` 优先于 `after`，并跨越每页 100 条的历史补齐后进入实时事件；
  - 与写入方竞争的历史补齐无缝、不重复地切换到实时事件；
  - hub 丢弃了 600 条事件的卡住的事件流，从存储重新读回这些事件；
  - 下限越过落后的事件流后，事件流在已送达的最后一条事件之后发送一帧 resync；
  - JSON 查询与两个事件流上的过期游标，以及下限的上限与单调性。
- `EventIdentityTest` 固定该规则。一个集成测试分两批追加增量，其中一个 reasoning
  Part 跨越两批，并把每条事件的身份与物化后的 Snapshot 对照。
- 一个升级测试在 H2 的 MySQL 模式下于 V1 写入事件、执行迁移，并按规则与 Snapshot
  检查补上的身份。`ManagedAgentMySqlIT` 在 MariaDB 上执行同样的升级。
- web-shell 测试解码 resync 帧，并检查 provider 只产出一个 `stream_gap` 后停止。

## 6. 兼容性

- 事件只新增字段，Session 报告已存储的下限；没有删除任何内容。
- WebShell 事件流的 `409` 响应从契约中移除；服务端从未返回过它。
- V14 新增带默认值的列。V15 在升级时读取一遍事件表，并更新有身份的行。
- 忽略 resync 帧的客户端会看到事件流结束，用同一个游标重连后再次收到该帧。
  web-shell 客户端会处理它。在保留策略的工作提升下限之前，生产环境中的事件流不会
  发送它。
- 生成的 `@qwen-code/web-shell` 类型新增可选的事件字段与 `WebShellResyncRequired`，
  事件流 operation 不再列出 `409`。

## 7. 验证

- Managed Agent 服务的完整测试与 Checkstyle 通过。
- `ManagedAgentMySqlIT` 在 CI 所用的 `mariadb:10.11.18` 上通过。
- 打包后的 Spring Boot jar 把 MariaDB 数据库迁移到 V15，说明 Flyway 能在 jar 中
  找到这个 Java 迁移。
- 以下变更分别使对应测试失败：忽略 `Last-Event-ID`、跳过下限检查、在 hub 中越过
  缺口继续投递、不返回 `next_cursor`、每个增量都新建 Part、跳过 V15 回填。
- WebShell 的 typecheck、managed 组件测试以及 managed-progress 与
  managed-workspace-w0d e2e 用例在重新生成的类型下通过。

## 8. 后续工作

- 保留策略：清理事件，在清理之前提升下限，并在事件流重整重建 Items 期间把下限保持
  在 Snapshot 之下或与之相等。
- WebShell Session 的下限与 Snapshot 水位。
- 带 Snapshot 版本分页的 `listItems`。
- 生命周期工作：剩余的三行差异。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
