# 超限会话记录：索引最近窗口而不是拒绝

[English](2026-11-07-transcript-index-window.md) | [简体中文](2026-11-07-transcript-index-window.zh-CN.md)

- 状态：提议（草稿 PR，契约变更需维护者批准）
- 日期：2026-11-07
- Issue：#13113
- 范围：`packages/core/src/services/session-transcript-reader.ts`、`HistoryGap` 与
  `TranscriptReplayGapInput` 类型、CLI 历史缺口提示及其翻译

## 问题陈述

`SessionTranscriptReader` 会拒绝任何大于 `SESSION_TRANSCRIPT_MAX_INDEX_BYTES`
（256 MiB）的会话记录。该检查是 `buildIndex` 的第一条语句，因此 `readPage`、
`readTurnIndexPage` 和 `readRestoreProjection` 都会抛出
`SessionTranscriptTooLargeError`，守护进程返回 `413 transcript_too_large`。会话一旦
超过上限，就无法再在 Web Shell 中打开，也无法由守护进程恢复。

长期运行的会话会通过正常增长达到上限。有一个已报告的定时任务控制会话每天写入约
14 MB，20 天后达到 280 MB；其中大部分是工具结果、压缩记录、遥测和助手消息。这类会话
继续运行并不需要最初几天的内容，但现在会永久不可用，唯一的恢复方式是手工编辑 JSONL。

## 现状

- [选择性会话恢复](2026-08-08-selective-session-restore.md)把该上限定为有意的限制：
  超过 256 MiB 的冷恢复返回 413，且绝不退回全量物化加载器。
- 索引已经把缺失的父记录建模为 `HistoryGap`。`readPage` 和恢复回放页会返回缺口，
  终端 `/resume` 和 ACP 回放会为其显示分隔提示。提示文字说明历史因存储中断而丢失。
- 会话级设置（`parent_session`、`session_source`、`session_model`、
  `session_approval_mode`、`session_workflow_mode`）、来源快照和归因快照，都从索引的
  活动链或物理记录中选取。

## 目标

- 对超限会话记录，从其最后 `SESSION_TRANSCRIPT_MAX_INDEX_BYTES` 提供服务，而不是
  拒绝；上限继续作为索引内存的边界。
- 报告已索引历史的起点，并能与丢失的历史区分。
- 即使会话级状态记录在窗口之前，也恢复续接会话所需的这些状态。
- 不改变上限以内的会话记录行为，也不改动磁盘上的文件。

## 非目标

- 写入侧增长、保留策略、压缩或改写已有会话记录。
- 可配置的上限。
- Managed 会话，其投影会读取整个日志。
- 其他大小限制：归档会话加载器和 Artifact 库保留各自的检查。

## 提议的改动

### A. 窗口化索引

当快照大于上限时，`buildIndex` 从最后 `SESSION_TRANSCRIPT_MAX_INDEX_BYTES` 内第一个
行首开始（`findWindowStart`）。它按今天索引整个文件的方式索引这些行，并使用绝对字节
偏移，因此分页读取、游标和索引缓存都无需改变。窗口不会超过上限，所以索引内存仍和以前
一样有界。

以下情况索引仍以 `SessionTranscriptTooLargeError` 拒绝：窗口内没有任何行首；窗口内
没有会话记录；日志是 Managed 会话。

### B. 前缀扫描

遍历完窗口的活动链后，`scanTranscriptPrefix` 解析窗口之前的行，但不为其建立索引。这些
行同样经过 `SessionExecutionEngineAccumulator`，因此所有者与完整性校验仍覆盖整个文件；
出现其他会话的记录时快照仍然不可用。扫描只保留：

- 文件的第一条记录，用于证明会话所属项目，并提供恢复起始时间；
- 每种会话级记录的最后一条：`parent_session`、`session_source`，最后一条有效的
  `session_model`、`session_approval_mode` 和 `session_workflow_mode`，最后一条
  `session_sources_snapshot`，以及最后一条归因快照；
- 最后一条助手记录的模型。

这些记录以 `window.retainedRecords` 保存在索引上，当索引没有对应条目时按 uuid 提供。

### C. 缺口原因

`HistoryGap` 和 `TranscriptReplayGapInput` 新增可选字段
`reason: 'transcript_window'`。前缀扫描会检查窗口活动链缺失的父记录是否出现在窗口之前。
若出现，该缺口是窗口截断，带上该原因；否则仍是存储缺口。

### D. 读取接口

- `readPage` 和恢复回放页已经返回缺口。
- `readTurnIndexPage` 在存在缺口时返回 `gaps`。
- 对窗口内没有再次记录的每项设置，`readRestoreProjection` 回退到前缀。前缀记录先于窗口
  记录读取，因此窗口内改过的设置仍最后分发并生效。
- 两种恢复投影都会回退到前缀中的来源快照。
- 恢复出的 `historyGaps` 带有该原因，用来标记会话只是部分恢复。

### E. 提示

`formatHistoryGapNotice` 对窗口截断返回单独的提示：会话过大，无法完整恢复，因此更早的
会话记录未加载。已翻译现有提示的英文、简体中文、繁体中文和加泰罗尼亚语目录，也翻译了
新提示。

## 关键设计决策

- **只改读取侧。** 这样无需改动磁盘或 writer lease，就能让所有现有的超限文件重新可用。
  写入侧上限只对改动之后写入的文件有帮助。
- **前缀只扫描一次，不建索引条目。** 前缀仍需要解析，但除了少量保留记录外不占内存。
- **前缀设置按文件顺序选取。** 前缀没有索引，因此没有活动链可以遍历。对窗口内没有再次
  记录的设置，按文件顺序的最后一条，只有在它位于窗口之前被 rewind 放弃的分支上时，才会
  与活动链上的那条不同。
- **Fork 保持不变。** `SessionService.forkSession` 不使用索引：它读取整个源文件并复制
  其活动分支，因此对超限会话仍然可用。早先的方案草图提出拒绝从窗口化会话 fork；阅读
  fork 路径后确认没有必要。
- **Rewind。** 窗口之前的轮次不在恢复出的轮次列表和文件历史中，因此不能被选为 rewind
  目标。

## 契约变更

- 超过 256 MiB 的守护进程冷恢复不再以 `413 transcript_too_large` 失败，而是恢复最近
  窗口并报告 `transcript_window` 缺口。这修订了
  [选择性会话恢复](2026-08-08-selective-session-restore.md)中对应的目标；该目标在引入
  时就需要维护者批准，这里同样需要。
- `HistoryGap.reason`、`TranscriptReplayGapInput.reason` 和
  `SessionTranscriptTurnIndexPage.gaps` 都是可选新增字段。忽略它们的客户端看到的结构
  与以前相同。
- A 中列出的拒绝情况仍使用 `transcript_too_large`。

## 约束与风险

- 前缀仍需解析，因此打开很大的会话记录所需时间与其大小成正比。
- 窗口之前的状态只恢复保留的那几类。更早的 UI 遥测、目标记录、Artifact 和文件历史不会
  恢复，窗口缺口会把会话标记为部分恢复。
- 模型历史从窗口开始，或从窗口内最后一次压缩开始。
- 以同一 uuid 写成多行的记录，若窗口起点落在这些行之间，只保留窗口内的行。

## 验证计划

- 使用仅供测试的上限编写读取器测试：窗口及其缺口、整个文件中都不存在的父记录、只在窗口
  之前记录的设置、窗口内再次记录的设置、没有会话记录的窗口，以及没有行首的窗口。
- 变异检查，确认以下改动会使上述测试失败：窗口起点偏移一个字节、从不或总是设置原因、
  没有前缀回退、前缀记录在窗口之后读取，以及第一条记录不取自前缀。
- 在 Ubuntu 24.04 与 Node 22 上：对 280 MiB 会话记录调用读取接口；在改动前后调用守护
  进程 `POST /session/:id/load`，并检查 turn index 和窗口起点处的会话记录分页。

## 验收标准

- 超限会话记录可以加载、分页和恢复，不再出现 `transcript_too_large`，且其第一页已加载
  内容显示窗口提示。
- 只在窗口之前记录的会话级设置能够恢复。
- 父记录在整个文件中都不存在的缺口，仍报告为存储缺口。
- 上限以内的会话记录行为不变。

## 待决问题

- 窗口化是否应默认取代 413，还是放在设置开关之后？
- 报告 280 MB 会话的使用者曾请求以可配置上限作为临时手段。有了窗口之后是否仍需要？
- 长期会话记录中遥测记录的保留策略，留待另行决定。
