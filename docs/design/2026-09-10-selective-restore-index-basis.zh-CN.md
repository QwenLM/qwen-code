# 选择性会话恢复·第二阶段:sidecar 索引基座

- 状态:草案(仅设计,不改变任何运行时行为)
- 基底设计:[2026-08-08-selective-session-restore.md](./2026-08-08-selective-session-restore.md)(投影形态、replay 选项、释放纪律、兼容性约束)
- 英文版:[2026-09-10-selective-restore-index-basis.md](./2026-09-10-selective-restore-index-basis.md)
- 使能变更:PR #11527(可选开启的 SQLite 会话索引 sidecar,`experimental.sessionIndex`)
- 关联:#11433(SQLite 评估)、#11493(进程内索引缓存准入悬崖)、追踪 #8678(有界水合)

## 1. 问题陈述

既有选择性恢复设计已经给出了正确、按消费者定制的冷恢复投影
(`readRestoreProjection` / `readLiveRestoreProjection`)。但它自己的
非目标一节点名了每次冷恢复仍在支付的成本:**没有持久索引,冷恢复仍要
把 transcript 全量扫描一次,还是 O(文件字节)**——而且这次扫描在内存
里的产物一旦挤不进 32 条 / 64MiB 索引缓存就被丢弃,于是:

- daemon 重启 ⇒ 每个被 resume/attach 的会话都要先对整个 transcript 做一
  次全量 JSONL 读取 + 解析,才谈得上任何投影或回放(#11433 基准实测
  ~1.8ms/MB;203MB 会话 365ms——生产里数百 MB 的会话是秒级),且按进程
  生命周期重复支付;
- 工作集索引估算合计超过内存预算后,退化为"每次读 = 全量重扫"
  (#11493);
- TUI `--resume`、ACP `session/load`、daemon live 任务恢复和 prompt
  ledger 都走 `SessionService.loadSession`,即**全量**读取 +
  `reconstructHistory` + `buildApiHistoryFromConversation`,之后没有任何
  条数/token 截断——transcript 被整段解析,尽管模型上下文反正都要被
  `chat_compression` 收拢;
- 超过 256MiB 的会话连这条路都走不了:投影抛
  `SessionTranscriptTooLargeError`,而(active 状态的)全量恢复器反而
  完全没有上限。

#11527 的持久 sidecar(`sessions` 目录 + `records` 字节偏移索引,增量维
护、JSONL 权威)正是基底设计点名的 "checkpoint follow-up":它让"索引
存在"变成按项目、跨重启成立的属性,而不是每个进程各猜一次。

## 2. 范围

刻意拆成可独立交付的两切:

### 2.1 切 A——投影基座 sidecar 化(行为中立)

投影的索引计算(活跃链、回放选择、hint 候选)可以从 `records` 表逐字节
重推——这正是 sidecar turn 导航已经在跑、且有完整 parity 覆盖的同一套派
生(`session-index/parity.test.ts`)。本切:

- (以加列、schema 版本化的方式)扩展 `records` schema,加上投影归约所需、
  超出 turn 边界的 hint 列(压缩候选、UI 遥测与归因位置、file-history
  位置、artifact 侧记录标记、goal-state / goal-card 候选、后台通知
  task id——其中绝大多数在 sync 时由 `(type, subtype, systemPayload)`
  完全判别);
- `readRestoreProjection` / `readLiveRestoreProjection` 改走 turn 路径已
  在用的同一 provider 查找:sidecar 命中 → SQL 行子集 + 按段 `pread`
  (uuid/sessionId 校验,同类型错误);任何 provider 失败 → 今天的
  `buildIndex(file)`;
- `loadSession` 语义与输出形状零改动——不期望也不声称任何行为变化;既
  有套件 + 扩展的 parity 语料(两种基座下投影输出逐项深等)是证据。

预期效果(同语料):203MB 会话的冷投影从 ~365ms + 一次全量内存索引降至
几十毫秒、跨重启存续,>64MiB 的准入悬崖在这条路上不复存在。

### 2.2 切 B——resume 路径默认有界回放(行为变更,可退出)

索引基座变便宜之后,基底设计的有界水合目标即可翻转默认:

- daemon/ACP resume 路径(`acpAgent.loadSession`、经 ACP 内嵌 config 流
  的 `sessionService.loadSession`)默认改为
  `replay: { kind: 'recent', limit, hideInheritedHistory }`,`limit` 由
  项目的 `historyPageSize` 推导(建议默认:
  `max(2 × historyPageSize, 200)` 条记录,仍然 turn 对齐、仍受既有 4MiB
  页预算约束)——恢复回来的会话水合最近一页记录,而不是整篇
  transcript;
- **模型上下文不受影响**:仍按 `buildApiHistoryFromConversation` 的
  `chat_compression` + 尾部选择——按设计那本来就不是整篇 transcript;
- **纯交互 CLI `--resume`**(无 host 投影源)是独立的显式闸门:可先维持
  全量水合(TUI 回滚语义与有限网页不同),或经 settings 键
  (`experimental.restoreHistoryWindow`)采纳同一默认——与维护者合议,**不
  捆绑**进切 B 的默认;
- `replay: { kind: 'all' }` 对不带 `historyPageSize` 的旧客户端必须保留可
  用,与基底设计兼容性约束一致;对未压缩的旧会话,归约器继续读取完整的
  模型面向历史(基底设计认为不可谈判的正确性规则)。

回退:切 B 回 `replay: all` 默认;切 A 关掉 sidecar 开关即退。两边都不迁
移数据。

### 2.3 显式非目标(与基底设计一致,除非列明)

- 不做权威生命周期/checkpoint 存储;JSONL 保持唯一权威。
- 不动 compaction/`chat_compression` 行为;不改 `readPage`;不改
  `readRestoreProjection` 契约。
- live-task 读/等待/启动与 realtime startup-context 的全量读取是另一套消
  费者契约(基底设计§非目标)——不动。
- 256MiB daemon 恢复上限(`413 transcript_too_large`)逐字保留,sidecar
  基座下投影也抛同类型错误,不提供无界服务。
- writer-lease 流程里的双重全量读取由基底设计的投影工作收敛,不在此重
  议。

## 3. 设计

### 3.1 records hint 列(切 A)

sync 时从 `(type, subtype, systemPayload)` 派生的加行布尔/标记列——不存
payload 字节;选择在这些子集上做,payload 仍走今天的字节段读取:

- 压缩/遥测/归因:`chat_compression` 候选(配合活跃链判定)、UI 遥测标
  记、最新归因标记;
- rewind/fork/artifact:用户 turn 父级候选(已可由 `navKind`/`conversation`
  派生)、file-history 标记、artifact 侧记录标记(含活跃链判定已有的废弃
  分支排除);
- goal:v2 goal-state 候选及有效性标记(malformed-state 恢复一致性)、席位
  置的 legacy goal-card slash-command 标记(既有优先级:最新合法 v2 胜出;
  unsupported 保持 unsupported);
- 后台通知:每 turn 最新 `task-notification` task id。

任何这三元组判不出来的都不入列——基底设计的 hint 清单是检查表;需要
payload 文本的 hint 保持在读取时按段物化,与今天一致。

### 3.2 投影基座路由(切 A)

`SessionTranscriptReader.readRestoreProjection` 增加内部基座参数
(`fileScan` 默认;开关开且 store 可解析时为 `sessionIndexStore`)。派生函
数就是 turn 导航已 parity 的那一个;两种基座对同一字节必须产生字节一致
的投影输出——具体地,新 parity 测试在扩展语料(链上压缩、未压缩旧链、
rewind 分支、fork/side-task 边界、goal v2 合法/损坏/缺失、goal-card 混合、
通知标记)上对投影模式做双基座读取,断言 `runtime` + `replay` 字段深等。
256MiB 上限、快照连续性校验、失败分类学,以及基底设计的"绝不回退到旧
全量恢复器"规则原样保留——基座失败只允许发生在索引构建之前,选择开
始之后不再回退。

### 3.3 有界 resume 默认(切 B)

resume 路径上原 `loadSession` 调用改为基底设计 `replay` 选择的投影请求,
复用已实现的 ACP `projectionSource` 流(`preloaded` /
`after_writer_lease`)。默认窗口随客户端 `historyPageSize`(2.2);结果经
既有 `historyPageSize` / `historyHasMore` / `historyAnchorRecordId` 分页表
面返回。纯 CLI `--resume` 按 2.2 独立设闸。daemon 恢复路径之外消费
`ResumedSessionData` 的调用方(export、archive、fork、TUI)不动。

`historyGaps` 语义、sources 完整性、`fileHistorySnapshots` 与
`artifactSnapshot` 由投影在文件级定义,恰如基底设计要求——这也是基底设
计早已否定"把 messages 截断即可"的天真捷径、此处仍否定的同一个原因。

### 3.4 推出节奏

1. PR-1(切 A):schema hint 列 + 投影基座路由 + parity 扩展。零行为变
   化;同一开关治理。
2. PR-2(切 B):daemon/ACP resume 默认窗口 + 兼容性守卫 + 遥测
   (`restore_index.basis`、`restore_replay.selected_records`、按类别的恢复
   耗时)。默认窗口这一兼容性变更需要维护者单独、具名批准(对齐基底设
   计的尺寸裁决先例)。
3. CLI `--resume` 的闸门决策并入 PR-2 review;settings 键仅在维护者共识
   倾向捆绑时才加。

## 4. 兼容性与释放

- 开关默认仍关;`file` 模式下切 A 惰性。
- 非 daemon 调用方的 `loadSession` 契约不变。
- 未压缩旧会话:模型面向历史仍全量读取(既有正确性规则);有界窗口只作
  用于 UI 回放,恰为基底设计已有的划分。
- 无 `historyPageSize` 的旧客户端保留全量回放(`replay: all`),符合基底
  设计约束——切 B 只在客户端声明分期能力之处收窄默认。

## 5. 涉及文件(预期)

- `packages/core/src/services/session-index/sqlite.ts`(+schema 版本,sync
  时提取 hint)
- `packages/core/src/services/session-transcript-reader.ts`(投影基座路由;
  归约契约不变)
- `packages/core/src/services/sessionService.ts`(投影入口委托不变)
- `packages/cli/src/acp-integration/acpAgent.ts`(resume 调用 → 带默认窗口
  的投影;纯 CLI 闸门 + 可选 settings 键)
- `packages/core/src/services/session-index/parity.test.ts`(投影 parity 语
  料扩展)
- `docs/design/2026-09-10-selective-restore-index-basis.{md,zh-CN.md}`(本文,
  双语)
- 基准:#11433 语料的按尺寸冷恢复、daemon 重启 N 会话 resume 风暴、追加
  后失效

## 6. 待回答问题

1. hint 列集合 vs 查询态 systemPayload 判别——切 A 实施时对照投影归约的
   真实选择代码逐条校验;依赖 payload 的保持按段物化。
2. 默认窗口策略:记录数 + 字节预算(建议)vs token 预算——token 是更准
   的用户体验信号但需读 payload 计数,破坏"亚文件"性质;建议沿用今天
   的记录窗口 + 字节预算混合。
3. 纯交互 `--resume`:采纳 daemon 窗口、维持全量、还是 settings 门控——
   维护者拍板。
4. daemon 热会话失效:resume 出的 live 会话会追加新 turn;下一次 daemon
   重启后的冷恢复不许复用陈旧窗口——sidecar 的 indexedBytes 检查点已经
   对其有界,投影模式需成文。
