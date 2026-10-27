# Managed Session 历史查询与 authority 驻留窗口

[English](2026-10-27-managed-session-authority-window.md) | [简体中文](2026-10-27-managed-session-authority-window.zh-CN.md)

## 状态与基线

#13184 的 PR5 以 `0539160f35f983ba4a6d4d369c0ae18941b2fdb2` 为调研基线，包含 PR1 #15566、PR2/PR3 #15569/#15599 和 PR4 #15626，并集成到 main `7a9a88938e65a528311973a552189f7dea1aa04d`。有界驻留是新实现的正常路径，没有 opt-in 开关或完整历史的同步兼容层。验证仍在进行：实现、聚焦验收和最终 CI 资格是不同状态。执行报告记录准确源码摘要、失败与待验门禁。

## 问题与目标

authority 常驻全部事件、命令、身份、回执、checkpoint、Action、extension 修订及唯一性证据，同步历史读取方还会构建完整数组。本地和 HTTP 恢复拼接完整逻辑 journal，activation/inbox 快照将全部终态身份载入内存 Map。只删除一个数组，会把增长转移到别处或破坏重试安全。

将 authority、调度存储和恢复内存限制为 `O(活跃状态 + 固定缓存 + 有界 I/O)`，不随已完成历史增长。保留完整历史及旧 key 精确重试/冲突结果。允许冷恢复扫描历史；固定恢复时长与有界磁盘不是目标。

## 存储与权威边界

canonical native journal 继续作为权威。Hosted 通过 Java/JDBC 使用现有 MySQL；managed-local 通过同一服务契约使用现有 H2。独立 JSONL 在原 `SessionWriterLease` 下使用文件查询适配器，不依赖 Java 或数据库。不引入 SQLite，不提高独立 CLI 的 Node 下限。

不删除 canonical 事务或资源，不推进 native/public replay floor，不自动发布快照，不替换本地 ownership 语义，也不关闭整个 #13184。公共消息投影不能恢复 authority。

## 读取视图与接口

读取视图绑定租户/Workspace/Session 及提交序列和 digest；native HTTP 还绑定 journal revision，文件还绑定物理 generation。异步读取前固定一次视图。可变事实按该前缀（包括指定的较早序列）查询，不可变事实保留原值。只有完整视图能够回答不存在；不可用、补建中及损坏是错误，不能返回空结果。

历史身份查询和列表改为异步。事件按页或异步迭代读取，默认 100 条，最多 256 条且每页最多 8 MiB。拒绝非安全整数、NaN、小数及非法序列。保留连续分页与既有 HTTP/SSE envelope。移除生产路径的完整同步历史读取，包括消费方隐藏的数组和 Set；有界当前摘要及仅含活跃项的调度读取仍可同步。

## SQL 查询视图

复用 native journal 命令索引及源事务字节。增加历史事实版本，保存封闭事实类型、身份、来源 revision/sequence、定位与 digest，以及连续索引覆盖状态。新事实与 canonical commit 同事务写入。旧事务按有界批次补建，不在整个扫描期间持有 head 锁。覆盖未到指定前缀前拒绝返回不存在。恢复时对照源事务验证派生事实；缺失或不一致的索引从 canonical journal 重建，canonical 损坏则阻断恢复。

历史路由属于持久化 Workspace/Session，保留既有租户凭据与 read grant。Core 不持有 SQL 凭据。历史版本查询不能替换成仅保存最新状态的 `ma_session_record` 投影。同步修改共享 V1 schema baseline、初始化/校验注册及 H2/MySQL 覆盖；不增加 V2 migration，不自动删除现有 catalog。

实现使用按 generation 隔离的 `ma_session_history_state` 与 `ma_session_history_fact`。每代记录 256 个身份哈希桶的条数，缺失行不能把有数据的桶变为不存在的证明。查询将每个选中 locator、ordinal、digest 和元数据与其唯一 canonical 源事务核对。Core 还会与独立重建的 canonical 事实比较。补建每请求最多处理 100 个事务，只推进连续前缀。修复使用 `expectedGeneration` 比较交换：较旧的并发修复加入新一代，不再次重置；未来代号冲突。旧派生代每批最多清理 256 行，不在锁住 head 的整个历史扫描中清理。canonical 资源/事务损坏不能作为索引问题修复。

Core 使用 native 身份及事件范围查询。领域身份枚举目前使用独立重建的 canonical 文件目录；SQL 的 `extension-domain` 类型可供服务调用方使用，但并非 Core 的目录读取器。来源校验重新计算 canonical 事件/marker 摘要，核对序列、数量、范围及跨事务物理 parent；仅刷新原始字节 checksum 不能使篡改后的 canonical 内容有效。

CSI application inventory 包含两张历史表的完整类型定义，共 40 张 managed 表、827 列。派生元数据不能发现 authority 关联，也不能参与全局 JSON-carrier 扫描；按范围和已捕获主键读取时仍核对准确行。覆盖前缀内的事实必须匹配 canonical 事务、条数及 bucket 清单。终态 cut 通过正常 append 的提取器生成准确的五个历史事实，只跨连续前缀推进覆盖。缺失 state 时新建 generation，覆盖从零开始。freeze 在既有资格上限内预留九行，包含可能新增的 state 行。

## 文件查询视图

采用内容寻址的分页 hash-trie，叶页最多 64 KiB，按 key digest 后续 nibble 分裂。键包含封闭事实类型与完整身份；digest 命中仍核对身份。值仅含有界元数据和来源定位，不保存全部历史正文。可变事实保留小型版本链。已校验空分支/叶证明不存在；被引用页面缺失或损坏不能证明不存在。

每次 open 从本次流式验证的 canonical 前缀构建新的 owner/open generation，不将旧侧车水位当作负查询证据。每事务发布一个 root 并绑定前缀证明。首次提交顺序通过带字节长度、条数和 digest 的追加身份目录维护，不依赖目录列表。为读取方固定 root 与目录边界。读取完成后只清理当前任务拥有的侧车，保留 canonical 数据和格式屏障。按事务批量更新共享路径并记录写放大，不构建通用存储引擎。

叶项保存 key digest 和经过验证的值 locator。较大的旧身份放在独立正文中，100 项身份目录页也仅保存引用。文件事件事实定位到单个已验证事务块；首次执行回执保存序列，不复制事件正文。extension 版本保留 ref 与元数据，按需加载解析正文。独立查询 root 共享其 authority owner 的唯一 2,048 项/4 MiB 字节缓存。内容 blob 通过私有 pending 文件和原子 link 发布，并发 root 不会读到半个 blob。

被引用页面缺失或损坏时，该视图按其捕获的 canonical 前缀串行重建一次。重建共享同一有界 owner 缓存，完成全部来源校验后才发布等价逻辑 root，不假定重放会复现旧 blob 哈希。固定读取方保留一个 root alias，迟到的重试使用已验证的修复 root，不能采入之后的 head。writer 保留有界 pending overlay。来源前缀/generation 已变化或不可用时明确报错，不能回答不存在；派生修复不结算 uncertain append，也不修改 canonical 历史。

关闭时拒绝新查询、排空读写、清理缓存，每次最多枚举 32 个目录项且最多同时删除 32 个文件。规模验证中，递归删除曾一次收集数百万文件名并在固定堆下失败；该失败和独立复现仍保留在记录中。清理不删除 transcript、快照页或原资源。一个 open generation 内的不可变索引页及历史版本仍会占用不断增长的 scratch；关闭耗时和写放大是明确成本。

## 提交与故障顺序

只有已确定的 canonical commit 才推进可见状态和查询视图；视图可用后才淘汰驻留事实。若 canonical commit 后文件视图写入失败，最多保留一个事务的有界 overlay，返回已提交 receipt，并暂停后续新写入直到重建成功。重试返回原结果，缓存故障不能把已提交 ACK 变成拒绝。未知追加结果仍只由 `settleAppend()` 判断，不能由视图不存在来结算。

## 驻留事实与消费者

最近事件最多 1,024 条且最多 8 MiB；历史/解析缓存最多 2,048 项且最多 4 MiB。超大正文只用于当次读取，不进入缓存。保留当前 activation/checkpoint、有限 latest-kind 摘要、未结算输入/Action，以及活跃工作和清理引用；不能把所有终态身份伪装成活跃状态。

命令/event-ID 去重、原始执行回执、checkpoint 查询、domain/extension 修订、opening operation、Hook activation/once/occurrence/ordinal/definition pin、child continuation 和团队唯一性改为历史查询。旧重试保留 transaction ID、ref 和结果，仍报告当前提交水位；执行回执保持首次提交优先。驻留依据领域生命周期判断：settled 的 Hook 注册、调度或团队仍可能有效。

迁移审批/模型/Plan 选择、wake/cancel 恢复、工具结果、原始 CSI、清理、Hook/自动化/Channel/Child/Team、transcript 投影、导出及 SSE。将完整历史 settled/delta-ID Set 改为限定范围查询。模型只构建选定分支、当前压缩摘要及所需上下文，不静默截断历史。历史任务按原排序有界分页。

当前上下文只含有效压缩之后、选定分支上的模型材料。非模型 UI/attribution/attempt 元数据仍在 canonical 历史中，按需流式读取。重复 memory catalog 与本地命令对沿用既有 API 历史语义。取消、工具结果身份及原始 CSI 相邻性等恢复事实查询固定 canonical 前缀，不能根据上下文投影判断不存在。团队任务页默认 100 条、最多 256 条；cursor 绑定团队与前缀，依赖和 roster/plan 不混入较新修订。Hook 安装、有效 schedule/team 定义、活跃输入/任务清理和未决 Action 按生命周期保留必要状态。

消息 parent 与 CSI 相邻性消费者使用 `iterateMessageRecords()`，保留既有消息/分支投影通道；`iterateRecords()` 另外包含终态和 domain 记录。不能仅因某个终态 UUID 是完整历史最后一条，就将其作为消息 parent。显式活跃 transcript 链 API 包含链上的元数据记录，与有界模型上下文投影独立。外部 canonical owner parent 正常结束选定链，链内实际重复身份则视为损坏。

Hook 是否有未完成工作的判断需要读取持久化 execution/occurrence 事实，因此 await `hasPendingOperations()`。模型边界、恢复状态检查和 Hook 准入调用方同步使用这一必需方法。测试替身必须提供它；把缺失方法静默视为 false，可能在 Hook 工作尚未结算时准入模型工作。同步回答需要另外常驻一份随历史增长的 pending/历史投影。

Managed recorder 仅保留 tail、记录 ordinal、用户轮次数、未完成工具身份与一个压缩摘要，不保留完整分支记录或逐轮 rewind 数组。完成轮次的 checkpoint 流式读取固定 canonical 活跃链，发布前核对 cursor 到 tail 的条数。取消与 Goal 证据也跨压缩读取该链；Goal 候选及 proof 查询落在共享 owner 缓存的磁盘视图。Legacy recorder/rewind 保持原契约。CSI turn Map 只保留正在执行的工作；终态重试查询 canonical 前缀并返回原结果，不再次调用模型。

当前 Harness checkpoint 只包含活跃工具（包括 settled 但结果尚未 consumed 的工具）以及既有的固定 inline tail。已完成且已消费的 tool/binding 页继续保留在 canonical 资源中。authorization 必须携带不可变历史视图，提供惰性 tool/binding 枚举、execution ID 点查，以及经过校验的条数、最大 ordinal、结算/消费摘要。execution ID 不能作为 function-call ID 的别名。视图固定 state ref、Session/Turn/prompt 和 archive 条数，后续 head 不能改变旧视图。冷验证将 page locator、身份/ordinal 唯一性和首次提交顺序落盘；热提交复用经过认证的 page proof，仅索引新页。prepared fork 只能在 canonical commit 已确定后发布。派生页缺失或损坏时从捕获的 root 重建，canonical 损坏则拒绝恢复。缓存 compact 当前视图，不缓存完整历史数组或另存 raw root。

保留既有 `managed-checkpoint-paged/1` 字节格式、48 KiB/32 项页、4,096 页/64 MiB 资格限制和格式下界。新 Turn 的 `before_model` 清除当前 archive 引用，canonical 历史仍完整保留。CLI runtime owner 和 definition pin 检查流式读取完整固定视图，涵盖 inline tail 之外的 pin；pending-message 和原始回执按历史身份查询。生产消费者不通过兼容路径重构完整 tool/binding 数组。

Java checkpoint proof 使用同样的 compact root 与逐页模型。execution/function ID、ordinal 唯一性及 binding 到 tool 的外键通过请求私有的磁盘事实校验；按时间枚举使用经过校验的逆序页 spool。普通 JDBC CSI proof 同时将历史 ID、batch、intent、receipt、frozen batch、资源 inventory 元数据及 execution snapshot 落盘。每个 proof owner 只有固定 640 KiB bucket 目录，记录摘要链连接到受信 bucket head，只有验证完整链后才能回答键不存在。数字前缀游标冻结旧查询，无须复制目录。私有 scratch value 上限为 32 MiB：已经合法的 8 MiB 消息在规范化数值拼写时最多使用三倍字节，另加不足 512 KiB 的有界 batch/refusal 元数据。该上界依据当前 Jackson writer 与 [Java 21 十进制格式](<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Double.html#toString(double)>)。私有 codec 保留数值节点类型，包括仍待语义校验拒绝的溢出值。其读取深度 72 容纳经过深度 64 校验的资源外层固定 DTO。execution snapshot 保存 SQL reference/result 原始 JSON，并使用原 ledger parser 恢复，保留小数精度及其来源深度。公共 parser、canonical 消息及通用资源上限保持不变。正文逐条读取，手动 JDBC transaction scope、Spring completion 或显式 offline proof close 释放 scratch owner。这些改动不取消既有 CSI 资格限制，也不能单独证明最终 Java/平台验收通过。

## Core API 迁移

本 PR 同步修改内部 Managed Core 契约及所有 workspace 消费者，不修改公共事件类型或 native journal 格式。

| 原用法                                                    | 新用法与归属                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同步事件数组与冷身份 getter                               | `readEvents()` 返回有界 Promise 页；`iterateEvents()` 是可重开的固定前缀异步查询。冷命令、receipt、checkpoint、Action 和 extension 查询返回 Promise。查询 predicate 和终结操作均须 await。                                               |
| 所有 extension 记录常驻数组                               | `extensionRecordsInDomain(domain, { throughSequence })` 惰性读取固定版本视图；旧修订和长期唯一性事实留在磁盘。                                                                                                                           |
| 用 journal `read()` 打开 authority                        | 每个 journal reader 实现 `scan(consume)`，交付带准确源偏移/字节的完整已验证事务。authority open 不调用 bulk reader。                                                                                                                     |
| 用完整投影 transcript 做运行决策                          | `iterateMessageRecords(prefix)` 保留消息/分支语义；`iterateRecords(prefix)` 还包含终态/domain 记录。`projectModelRecords()`/`projectContextRecords()` 包含当前模型上下文，后者保留 branch checkpoint。历史事实使用身份查询。             |
| recorder 分支数组与取消/Goal 扫描                         | `readActiveTranscriptHistory()` 返回可重开的固定活跃链，包括压缩前的事实。`createTranscriptQueryHistory()` 共享 authority 缓存。恢复提供有界 pending-call/压缩摘要及用户轮次数标量。                                                     |
| 完整展开的 checkpoint tool/binding 数组                   | authorization 提供 compact checkpoint 和 `ManagedHarnessCheckpointView`：惰性 `tools`/`bindings`、异步 `tool(executionCallId)`/`binding(executionCallId)`，以及经过校验的条数/ordinal/结算摘要。历史 pin 和 receipt 必须使用该固定视图。 |
| Managed 恢复的 `replay.records`、telemetry 和通知 ID 数组 | Managed 完整重放提供可重开的 `recordHistory`；telemetry 提供 `uiTelemetryHistory`；有界正缓存 miss 时，`hasBackgroundNotification` 执行新的 canonical 查询。有界 recent 页和 Legacy 格式保留数组形状。                                   |
| 无界 ACP bulk 响应                                        | 增量消费异步重放。既有 bulk update/字节上限触发 `HistoryReplayLimitError`（`-32012`），更大 Session 使用分页历史。不以短的成功响应冒充完整历史。                                                                                         |
| 长期持有只读 authority                                    | `openReadOnly()` 不获取、创建、追加或 seal writer。`disposeHistory()` 释放私有查询 generation。writer 的 `close()` 先 seal，再一次性排空并释放历史 owner。                                                                               |

CSI 资格快照保留既有总计 128 MiB/4,096 引用上限，逐事务验证与交付。内部 CSI bulk-history 响应保留数组形状，超过 64 MiB 时明确拒绝，不静默截断。这些显式边界不同于正常的完整历史恢复；不为导出提高通用资源上限。

## 实现位置

| 层次                         | 实现                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| canonical scanner 与文件查询 | `packages/core/src/managed-runtime/managed-session-storage.ts`、`managed-session-history.ts` 及本地 journal/writer 适配器     |
| 有界 authority 与上下文      | `managed-session-authority.ts`、`managed-session-message-projection.ts`、`managed-session-record-sink.ts`                     |
| 历史 transcript 与终态       | `managed-session-transcript-query.ts`、transcript reader、activation/inbox store 和 `managed-journal-stream.ts`               |
| Native 查询路由与 V1 schema  | `packages/managed-agent-server/` 的历史 store、Session controller、schema contract/projection、retirement 清理和 SQL baseline |
| 消费者                       | CLI serve/recovery/领域读取、ACP 重放和通知去重、Core Config/recorder/模型恢复                                                |

## 流式恢复与本地转换

增量验证完整 journal 事务，保留精确 marker 链、记录/字节位置和 torn-tail 语义。逐页消费选定 native 快照和连续尾部，不拼接完整 journal。将资源 census/frontier 及 checkpoint 事实落文件视图，避免另建无限 Map。

流式处理本地 header、sealed 转换、普通恢复及替换后验证。保留 16 MiB 页与既有 64 MiB 本地资源/manifest 上限。发布页面前先预检容量，将 page/ref census 落 scratch。只有 manifest 容量不足允许保留原源恢复，且必须验证原前缀、sealed proof 及全部声明/嵌套资源；该分支不发布、不 rename、不降低 schema-3/format-2 屏障。已有 snapshot base、损坏、I/O 故障及 ownership 不确定均不适用该降级。

流式解码 activation/inbox v2 快照并编码替换，保留全部 canonical 身份、顺序、payload、outcome 和 fence。digest 仍为 `JSON.stringify(parsed state)` 的摘要，不能改为原输入字节。使用纯 JavaScript 流式 JSON 解析器且不保留已消费容器。内存仅保留 pending/assigned/processing，将冷 Session 的 `nextEpoch` 与 released/finished 身份一起放入持久查询。PR1 helper 仍为派生数据：从新视图提供已验证 terminal，不再依赖完整内存 Map。

解析器采用固定版本 `0.0.26` 的 [`@streamparser/json`](https://github.com/juanjoDiaz/streamparser-json)，支持纯 JavaScript 增量解析，不需要 native module 或提高 Node 要求。已消费的 state 容器立即释放。编码流式生成相同语义的 JSON，保留既有 v2 checksum 契约。

依赖隔离在终态快照 codec 后，并由 lockfile 固定版本。上游停更不会改变该版本，也不会启用完整解析的回退。替换或升级必须在支持的 Node 版本上保留语义 checksum、chunk 边界、非法输入及已消费容器测试；解码失败拒绝快照，不能丢弃身份。

## 兼容与验收

服务端未提供历史查询能力时，新客户端可将现有事务流式构建为文件视图；已选快照损坏不能回退到其它历史。Managed Core 异步接口需同步迁移全部 workspace 消费者及导出文档，不提供重新加载完整历史的同步兼容层。

以相同活跃状态、payload 大小和模型上下文，比较独立固定堆子进程中的 10,000/100,000 条完成历史。硬性断言缓存/队列上限，记录常驻及恢复峰值 heap/external/RSS，确认终态不形成新的驻留集合。覆盖冷查询/重启重试及冲突、once/ordinal/pin/continuation/team/epoch/FIFO/fence、固定前缀、补建缺口、侧车损坏、提交后视图失败、崩溃、丢 ACK 及 uncertain append。

运行真实 Core→Java→MySQL 快照恢复和 H2/文件路径；TCP fixture 与普通 daemon smoke 不能代替最终集成路径。保留资源损坏拒绝，包括超容量转换叠加旧资源缺失。前序 PR4 完整 CI 有未解决的 Automation/Monitor 故障门禁，需要在最终版本复核，不能因已合入就宣称资格通过。本地 Java 准备/构建/测试/重试共享 600 秒；完整 profiles、数据库/平台/故障矩阵由 CI 承担。构建、类型检查、打包及受影响 TypeScript 测试仍须完成，记录精确版本、失败、跳过和待验门禁。

完整 SDK Java workflow 为 H2 与 MySQL 分别增加独立的 `managed-history-scale` 资格 job。其 opt-in Maven profile 以一个 scale Gate 运行 10,000 和 100,000 事件，每个规模使用独立、固定堆预算的 Node 进程，经过真实 Core HTTP 客户端与 Spring 服务。该长用例不进入普通 600 秒单测 fork，不替换正常 profiles，也不缩小其报告门禁。必须完成两个规模并比较常驻内存，成功与失败均保留逐阶段指标和报告，拒绝被过滤或跳过的资格报告。H2 使用文件存储，MySQL 使用任务私有数据库。该 CI 入口是验收机制，不代表最终源码已经通过测试。

首轮双引擎运行 `3c92f28d` 在内存比较前失败：夹具为同一执行结果身份提交了不同 canonical 来源，被既有工具发布契约拒绝。夹具现使用不同 execution，仍在恢复后核对窗口外的原回执和旧命令重试。原失败继续保留，修复后源码等待 CI 资格验证；该夹具修正和此前文件测量都不能证明 native 规模验收通过。

## 待决问题

没有待决产品问题。完整能力在一个 PR 内交付，查询/恢复/消费者迁移及受影响验收通过后才启用淘汰。记录冷 I/O、文件索引磁盘和写放大成本，不宣称这些成本有界。
