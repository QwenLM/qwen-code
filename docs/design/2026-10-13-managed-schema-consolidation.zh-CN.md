# Managed Agent 数据库精简：63 到 32 张表

[English](2026-10-13-managed-schema-consolidation.md) | [简体中文](2026-10-13-managed-schema-consolidation.zh-CN.md)

## 状态与边界

已在独立工作树实施，并在全新 MySQL8.4 数据库完成验证，包括原生 Linux worker、重启和独立服务验收。尚未切换正式生产流量；实际证据和环境限制见实施手册。源码清单固定在 `18f80f56666a347a2b67b2ef98099cc58356b253`；现有结构含 V68 异步输出验证，共 63 张业务表。使用新数据库，不迁移旧库或旧 Session。DataAgent 五张 `da_qwen_session_*` 表不在本次范围内。实际验收和待执行的生产切换步骤见实施手册。

目标保留 Managed Session、Runtime、工具、Workspace/CSI、恢复、子 Agent、渠道与自动化。表数减少来自取消重复的存储边界，不能丢弃协议事实。此前 26 表方案被替代：writer 权限、事件流游标、不可变快照、Runtime slot、物理存储占用及读租约分别保存。

## 目标表

| 模块           | 数量 | 物理表                                                                                                                                                                             |
| -------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话与内容     |   10 | `ma_session`, `ma_session_head`, `ma_turn`, `ma_session_journal_tx`, `ma_event_stream`, `ma_public_event`, `ma_message`, `ma_snapshot`, `ma_session_record`, `ma_agent_definition` |
| 资源与输出     |    4 | `ma_resource`, `ma_resource_ref`, `ma_output_capture`, `ma_artifact`                                                                                                               |
| 请求与后台执行 |    3 | `ma_request_receipt`, `ma_operation`, `ma_operation_work`                                                                                                                          |
| 工作区         |    3 | `ma_workspace`, `ma_workspace_access`, `ma_storage`                                                                                                                                |
| 执行环境       |    4 | `ma_runtime_slot`, `ma_runtime_binding`, `ma_runtime_session`, `ma_tool_execution`                                                                                                 |
| 协调与保护     |    3 | `ma_tenant_guard`, `ma_storage_owner`, `ma_read_lease`                                                                                                                             |
| 渠道与投递     |    3 | `ma_channel_instance`, `ma_channel_binding`, `ma_delivery`                                                                                                                         |
| 自动化         |    2 | `ma_schedule`, `ma_schedule_occurrence`                                                                                                                                            |

## 权威状态与提交边界

`ma_session` 保存公开身份、actor/Workspace 绑定、父子关系、标题版本和退役墓碑。`ma_session_head` 分字段保存 writer generation、租约、activation、私有日志 revision/checkpoint、恢复状态和准入 fence。`ma_event_stream` 按 `(tenant, session, stream_kind, stream_id)` 保存永久 tail 与 retention floor；Session 流额外保存投影进度和当前快照身份。重建投影不能清空 tail/floor。

Session 流的可空 `wake_covered_sequence` 独立去重已经尝试的日志唤醒，其私有日志序号可以大于公开事件 tail。原子的严格递增领取只修改该字段，保留消息 `covered_sequence`、retention floor、tail 和物化调度时间；投影重建保留它。传输消费者只读取公开 Session 状态，排除 Control 根记录和已退役 Session。日志所有权通过 head 的摘要主键定位，并核对原始身份、排除仅用于 Harness 的 head；批量所有权读取限制为每批 200 个请求身份。

Broker 单独使用时，Harness 准入屏障可能先于 Managed Session 登记存在。这样的 head 必须明确是仅控制状态，缺少日志权威不能解释为活跃 writer。storage 准入 fence 同样可能先于 CSI 登记存在；未登记的逻辑行不证明物理身份或挂载。两种占位均不授予执行权限。公开 Session 的 Workspace 绑定必须全部缺省或完整存在，Workspace/context revision 必须为正数；仅控制状态的墓碑允许保留局部内部绑定。

私有日志精确字节与摘要链不可变。日志追加、资源引用、领域投影和 head 推进在同一事务提交。公开事件只包含公开投影，Session/task 的事件流、序号、去重和保留独立。`ma_session_record` 保存 task、approval、Hook、MCP、Team 等有类型的最新领域投影，保留 Hook once/occurrence 约束。Agent 定义版本不可变且由 Session 固定。

message 保存最新投影和稳定 ID 的有序 parts；流式增量保存为事件，投影批量更新。大正文引用不可变资源。snapshot 保存不可变版本、水位及 manifest/page 引用。通过一个 repeatable-read 一致性视图构建，所有页验证后才发布指针，不能用多次独立事务或 INSERT SELECT 替代。游标有效期 30 分钟，保护所需资源及重放区间；最新快照在替代版本发布前保留。过期沿用 409 cursor_expired 和 SSE resync。

快照构建及分页在一致性视图中复用当前连接检查已提交的读取租约，不从该视图内再次借用连接。视图必须在已提交的 120 秒租约内完成，过期立即拒绝继续读取。释放视图连接后、发布快照或返回页面前，再提交续租并检查最新退役代次。普通输出读取继续续租。这样保留 GC 保护，同时避免连接池的嵌套依赖。

后台按有界批次删除已过期的替代快照，空闲 Session 也会清理。释放 SNAPSHOT 或 MESSAGE owner 时，以 resource.retention_until 标记其生成的内联正文，供索引扫描回收。回收器持有 Session 锁检查剩余引用、读取及快照构建租约、恢复保护，再原子清空 inline bytes 并写入 COLLECTED 墓碑。它不选择私有日志的暂存资源；当前快照继续保留。回收遵守已有 GC 启用开关。

每个不可变快照页资源保存 snapshot 身份、页序号，以及该页消息 first-sequence 的最小值和最大值。这四个有类型的字段在快照页上必填，在其他资源上为空；scope 内的 snapshot/页序号唯一。首次数字 `after` 通过资源目录索引直接定位页，再在页内过滤；相同 first-sequence 跨页时仍沿用排除等值的数字边界。定位始终读取同一固定快照，不查询不断变化的最新 message 投影。后续 opaque cursor 保存 snapshot 身份及 page/offset。历史消息从 1,000 增大到 10,000 时，生产分页读取及目录索引扫描必须保持有界。

## 请求、worker 与外部副作用

request_receipt 在外部副作用前占位，在固定 namespace 和可信 scope 中精确重放摘要/结果。Session 创建模式冲突按 tenant 定位，与 actor 级创建重放分开。私有日志的 command 去重独立保留。

operation 是封闭且有类型的执行单元，覆盖生命周期/改名/cwd/审批/取消、子会话启动关闭与工作区、输出上传验证完成/put/结果投影/GC、恢复迁移/CSI 退役及渠道入站。tenant、目标、kind、phase、state、claim generation 和 next-attempt 为索引列；业务参数有独立校验。work 逐 Session/资产/execution 保存进度和不可变证明。不提供可配置流程引擎或动态 SQL 兼容路由。

delivery 分别记录传输、接收和消费，领取字段内联。子结果交接后，关闭欠账仍是一条独立 operation。审批按 action 身份与版本唯一占位，租约过期不准入相反决定。改名结算必须匹配目标标题 revision，不能回退。V68 异步验证保留显式阶段与到期列。

worker 用短事务领取，结算匹配同一 generation；持有领域行锁时不做外部 I/O。UNKNOWN 外部结果只查询原身份或由操作员明确结算；过期不允许分配新工具执行、对象写入或渠道发送。终态回执不能作为普通缓存重建。OBJECT_PUT 停留于 IN_FLIGHT 或 UNKNOWN 时，可以读取原不可变对象，核对完整长度与摘要后结算；不会再次发送 PUT，也不把租约到期作为完成证据。对象适配器必须只执行一次物理创建、禁止自动重试；普通服务和离线恢复/CSI 客户端使用同一重试策略。对象缺失或不匹配时继续保持未决与回收保护。

渠道对账先按 tenant/channel/delivery 和 claim generation 预留稳定身份。拥有该 live Session 的 Harness 仅在结算 unknown 投递时接受这个保留身份，并原样传入私有日志 command。Server 在同一日志事务投影时核对该身份与当前 claim，旧 claim 不能修改后继状态。普通 UUID 请求保持已有 command 行为。

## Runtime、存储与资源闭包

Runtime slot 的代次分配单调递增且在 binding GC 后仍保留。历代 binding、Runtime Session、原始工具 execution 分开，status/cancel/recovery 使用原身份；结果不明阻止不安全重放。

storage 保存逻辑 alias、登记和准入 fence；storage_owner 按规范物理身份保存占用、mount/CSI 证明，包括跨 tenant alias 指向同一物理存储的情况。租约过期不证明已停止。tenant_guard 保持 runtime_placement/output_publication 两个锁域。read_lease 每读者一行，绑定 Session retirement generation，领取与退役检查原子完成；续租失败停止继续读取。

新库 LOCAL 工具和 child Git 部署必须在 Linux 上开启 `QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true`，并先按 native mount 登记每个逻辑别名。未映射的别名仅提供元数据，不能领取物理执行权限。

本地存储的物理键是 native host、device、inode、birth identity 的定长编码摘要。每个已配置的 tenant/storage alias 保留各自登记和准入 fence，所有别名解析到同一物理 owner。owner 和磁盘 marker 保留首次登记的来源身份，不能用它授予另一别名的 Session 权限。别名登记不改写该 marker 或 native 身份。迁移为目标挂载建立新的物理 owner，并原子重映射所选逻辑别名；原物理 owner 保留 fence 和证据。复制的 marker 或不同的规范根目录不能授予别名权限。新 Runtime 准入及已有 writer 的内容修改都检查映射 owner 的当前状态；恢复冻结时仍允许封存 writer。

物理交接按键顺序锁定最多 128 个映射别名，再锁定 owner，最后检查已提交的权威状态。清单不完整或超过上限时拒绝交接。持有持久化 provisioning seed 的 FAILED binding 仍是结果未明的物理权威。仅属于一个 tenant 的恢复或迁移不能证明另一 alias 尚未覆盖的 Session、私有 writer 或未决 Runtime 已结算；这些权威未完成时拒绝交接。即使调用恢复事务已建立较旧的 repeatable-read 视图，清单检查也必须读取当前已提交 SQL 状态。Runtime binding 保存派生 storage-alias key，并按 key、state、持久化 provisioning seed 是否存在、identity 建索引；Session 权威按 tenant、storage、资源 GC 完成状态、Session 建索引。恢复不推断可以导出其他租户的私有日志。封存或租约过期的 Session 在永久退役并完成全部回收前，仍属于当前 cut 之外的数据。Session 的 resource_gc_completed 投影仅在结算 GC 成功的同一事务中设置，并核对永久墓碑、完整压缩的 DELETED head（或完全不存在私有日志）及不可变权威。已完成的历史墓碑不再阻塞交接，SQL 计数仍完整保留。child Workspace 操作保留领域状态的小写值；preparing、ready、merging、applying、applied、discarding、conflicted、blocked 和 failed 在父 Session 已回收或缺失时仍阻塞交接，只有 merged/discarded 表明物理清理步骤已结算。已证明停止且不存在匹配物理 owner 的原 binding 可以完成无副作用的释放，不能清除 CSI 或后继 holder。

资源正文不可变且有作用域，目录区分 staging、verified、quarantine 和删除状态，保留摘要/长度/位置。resource_ref 用有类型 owner/revision 保存日志、快照、capture、artifact、task 和恢复证明的边；删除 owner 与释放引用同事务。不能仅凭摘要共享不同作用域的资源。capture manifest 保存各 stream 的数量、长度及摘要；采集完成不代表获得公开发布准入。

GC 同时检查引用、恢复保护、读者和未决 put。先持久化删除意图并阻止新增引用，再执行物理删除；未知删除/写入结果继续可对账。不能因公开事件过期删除原始恢复闭包。

workspace 表示根和 child_git，保留父级、generation、Git 基线/结果/冲突证明；创建合并清理由 operation 驱动。默认 Workspace 使用生成列唯一约束并在事务中切换。child 沿当前父级 ACL 授权，不复制权限。schedule 的定义来自私有日志。经过校验的 schedule record 在同一事务内更新 session_record 与 schedule，并与日志正文、资源引用及 head 推进一起提交。HTTP 修改响应读取已提交的投影；scanner 不再修补定义。定义变更保留 scanner 的 lease/fence/watermark，只在从禁用变为启用时重置 armed_at。Scanner 退役只改变调度状态，不改写权威 enabled 字段。cron 列容纳私有契约允许的 4096 字节表达式。occurrence 保存 skipped/missed/unknown，与 run 是否存在分开。渠道 binding 是稳定路由，入站去重包含 account generation、平台事件身份和 semantic revision。

Git 发现仓库前先检查元数据，再启动原生进程：即使 `rev-parse` 也可能修改 linked-worktree 元数据。预检从请求 cwd 向上寻找存储边界内最近的 `.git`，解析普通 gitfile 和 commondir 文件，拒绝 Git 可能写入或清理的元数据中的危险链接。原生发现及既有的规范路径、布局和配置检查继续验证最终仓库。合法的普通仓库和 linked worktree 保持原有行为。

恢复登记锁定每个 Session 和私有 head，以当前读检查删除意图，并在同一事务提交 Session 保护。私有资源通过具名 JOURNAL/SESSION_RECORD 引用确定；公开消息和快照正文不扩大私有恢复闭包。永久删除且私有日志已完整回收的 Session，仅在退役墓碑、DELETED head、完整压缩水位及 SUCCEEDED Session GC 操作一致时，才能沿用已有的无私有日志退役恢复路径。可选 `retiredHead` 将原 writer 代次、日志和事件水位、activation 及提交摘要保留为不可变备份元数据。worker 校验并完整保存这些字段，不重放已回收事务或激活 Session，也不删除、重置 SQL head 或事件流。部分压缩及结果不明的 GC 均拒绝准入。

## 身份、索引与共享 DDL

机器身份按字节精确比较，包括尾随空格。Actor 创建作用域保留原有 Base64 编码，并预留 2732 字节，以容纳完整合法的 2048 字节 actor 身份。Session 消息和渠道投递按 domain/delivery state 建立索引；渠道查询指定作用域内的状态索引，避免已完成历史量决定扫描成本。长身份保存原始字节，固定编码摘要建键，命中后核对原值。确定的一对多使用唯一约束和外键；多态引用用封闭 owner kind 和事务校验。领取、分页、GC、恢复阻塞条件使用索引列，不扫描全表 JSON。

MySQL 8.4/InnoDB baseline 只有一个版本化来源，由 Managed Server/Broker 共用。初始化必须在创建/修改业务表前拒绝旧数据库。两个入口读取相同资源；不使用兼容 view、trigger、另一套独立 schema 或旧名 SQL 路由。HTTP/SDK 业务身份及已有字段保持稳定。公开分页契约改为签名的 opaque snapshot cursor，明确 30 分钟有效期、409 cursor_expired 和 SSE 重同步语义，包括保留事件行已全部删除的情况；这些变化记录在公共契约版本 1.45.0。Task 事件游标使用有版本且不依赖分隔符的 tenant/Session/task 身份元组；所有事件行过期后，原 task 序号和 floor 仍为权威。使用数据库时间的原生租约保留 DATETIME(6) 精度，并通过数据库目录校验；公开时间字段继续使用原有 epoch 毫秒表示。

历史 SQL/Java 迁移及仅用于升级的验收保存在 `docs/archive/managed-agent-schema`，不进入运行时或测试 classpath。原 Broker `schema.sql` 已移除。现役测试验证新库 baseline 启用及旧库拒绝，新应用不携带停用的升级入口或第二套结构定义。仅有迁移历史的库及历史 view 在 Flyway 写入前被拒绝。

MySQL/MariaDB 的两个初始化入口都要求选定应用数据库，在读取表元数据或调用 DDL/Flyway 前拒绝 `mysql`、`sys`、`information_schema` 和 `performance_schema`。JDBC 驱动可能把系统库中的所有表都标为 SYSTEM TABLE，因此仅筛选 TABLE/VIEW 不能证明它是空的应用数据库。

保留的 MariaDB CI 车道使用同一 canonical DDL。其 CHECK 目录没有逐约束的 ENFORCED 字段；即使 Connector/J 将产品名报告为 MySQL，校验仍识别 MariaDB，要求全局和当前会话的 check_constraint_checks 均开启，并核对每项 CHECK 的名称与表达式。两种数据库均要求 InnoDB；MySQL 继续要求 ENFORCED=YES。无法读取强制执行配置或约束关闭时，在元数据枚举或 DDL 前安全拒绝。MySQL 8.4 的验收基线不变。

结构化 CASE 比较仅将裸 TRUE/FALSE token 视为数值别名 1/0，与 [MariaDB 布尔字面量](https://mariadb.com/docs/server/reference/sql-structure/sql-language-structure/sql-language-structure-boolean-literals) 一致。带引号字符串、分支顺序/值、操作符和 ELSE 仍属于校验结构，不跳过任何 CHECK。

规模验收在两种保留的数据库族中都读取真实执行统计。MySQL 使用 EXPLAIN ANALYZE 树形算子；MariaDB 使用 [ANALYZE FORMAT=JSON](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/analyze-format-json)，对每个表节点将平均 r_rows 乘以 r_loops。测试辅助代码核对实际选中的 key，不以 possible_keys 代替；拒绝仅有估算或缺失计数的计划，并保留未执行 JOIN 的零循环统计。MariaDB 可能在优化阶段读取 PRIMARY const 表，执行循环为零且没有 r_rows；其实际 r_engine_stats.pages_accessed 与扫描行数分开记录。每次资源查询必须有正数的实际行或页读取证据，两个指标分别受预算约束。1000→10000 历史规模下行数必须稳定；B-tree 高度可能变化，因此页数在每个规模分别受预算约束。既有扫描量上限与实际索引检查仍是门禁，不跳过任何数据库族。

真实栈 E2E 运行器仅使用 canonical 表播种和验收，审批查询明确限定 ACTION 类型。Linux CI 对首个及替换 Server 都显式开启 verified recovery，在启动任何 Harness 或接纳工作前注册任务专用新存储的原生身份，不使用仅 SQL 的身份证明，不启用 trusted reboot recovery。macOS LOCAL 工具支持仍属待决定的平台边界；文档描述当前要求 Linux 注册的行为，并保留物理排他规则。

Linux Hosted 用例在工具准入前通过生产原生存储 guard 登记每个已配置的 Workspace storage。崩溃及生命周期恢复用例仅在首次启动时登记，重启保留原登记与物理占用证明。物理 owner 断言先将逻辑 alias 解析为物理 key。这些用例不跳过原生存储检查，不通过 SQL 构造身份凭证，也不削弱故障断言。

## 实施顺序与验收

1. 提交中英文设计、63→32 完整归属清单、类型/键/状态契约和共享 DDL；验证空库初始化及旧库拒绝。
2. 接入回执/操作/资源、Session/head/journal/stream/message/snapshot，证明创建提交读取重放重建删除闭环。
3. 接入 Runtime/Workspace/CSI/输出/恢复/GC，保留原身份并证明物理排他和读写回收竞态。
4. 接入审批/Hook/child/channel/automation/公开查询，全部生产 worker 使用目标表。
5. 真实 MySQL 约束并发崩溃负载验收后才接正式新请求；关闭旧准入并结算旧工作，旧库保留历史。回滚不能把新记录路由回旧库。

验收要求恰好 32 张业务表、全部旧职责覆盖、无旧表访问。测试 tenant/actor/幂等/创建模式冲突/default 竞态；提交前缀原子性和旧 writer；固定快照分页、重建与空流 floor；外部发送后断连；reader/put/seal/retirement/GC；alias 物理排他与缺失 ACK；审批/Hook/子关闭欠账/改名/渠道换代/调度竞争；历史量增大十倍时仍通过索引有界扫描。H2 仅快速反馈，不能代替 MySQL 锁及隔离证据。测试不使用用户的真实云资源。

## 完整职责映射

| 原表                                       | 目标存储                                           |
| ------------------------------------------ | -------------------------------------------------- |
| `managed_agent_session`                    | `ma_session`, `ma_event_stream`                    |
| `managed_agent_turn`                       | `ma_turn`                                          |
| `managed_agent_command`                    | `ma_request_receipt`                               |
| `managed_agent_operation`                  | `ma_operation`                                     |
| `managed_agent_action`                     | `ma_session_record`, `ma_operation`                |
| `managed_session_rename_delivery`          | `ma_operation`, `ma_session`                       |
| `managed_session_create_scope`             | `ma_request_receipt`                               |
| `managed_workspace_create_command`         | `ma_request_receipt`, `ma_session`                 |
| `managed_agent_event`                      | `ma_public_event`                                  |
| `managed_agent_item`                       | `ma_message`                                       |
| `managed_agent_item_part`                  | `ma_message`                                       |
| `managed_agent_snapshot`                   | `ma_snapshot`                                      |
| `managed_agent_consumer_progress`          | `ma_event_stream`                                  |
| `qwen_managed_session_journal_head`        | `ma_session_head`                                  |
| `qwen_managed_session_journal_tx`          | `ma_session_journal_tx`                            |
| `qwen_managed_session_resource`            | `ma_resource`                                      |
| `qwen_managed_session_resource_ref`        | `ma_resource_ref`                                  |
| `qwen_managed_session_resource_collection` | `ma_session`, `ma_operation`                       |
| `qwen_managed_session_extension_record`    | `ma_session_record`                                |
| `qwen_managed_session_task_journal`        | `ma_public_event`                                  |
| `qwen_managed_session_task_journal_cursor` | `ma_event_stream`, `ma_resource_ref`               |
| `qwen_managed_child_result_relay`          | `ma_operation`, `ma_delivery`                      |
| `qwen_managed_session_message_relay`       | `ma_delivery`                                      |
| `qwen_managed_child_workspace`             | `ma_workspace`, `ma_operation`                     |
| `qwen_runtime_binding_slot`                | `ma_runtime_slot`                                  |
| `qwen_runtime_binding`                     | `ma_runtime_binding`                               |
| `qwen_runtime_session`                     | `ma_runtime_session`                               |
| `qwen_tool_execution`                      | `ma_tool_execution`                                |
| `qwen_runtime_placement_guard`             | `ma_tenant_guard`                                  |
| `qwen_runtime_harness_drain`               | `ma_session_head`                                  |
| `qwen_runtime_storage_fence`               | `ma_storage`                                       |
| `managed_workspace_registry`               | `ma_workspace`                                     |
| `managed_workspace_access`                 | `ma_workspace_access`                              |
| `managed_workspace_default`                | `ma_workspace`                                     |
| `managed_workspace_execution_lease`        | `ma_storage_owner`                                 |
| `managed_workspace_operator_recovery`      | `ma_operation`, `ma_operation_work`, `ma_resource` |
| `managed_workspace_recovery_operation`     | `ma_operation`                                     |
| `managed_workspace_recovery_session`       | `ma_operation_work`                                |
| `managed_workspace_recovery_work`          | `ma_operation_work`                                |
| `managed_workspace_csi_registration`       | `ma_storage`                                       |
| `managed_workspace_csi_retirement`         | `ma_operation`, `ma_operation_work`                |
| `managed_workspace_csi_worker_ack`         | `ma_operation_work`, `ma_resource`                 |
| `managed_workspace_migration`              | `ma_operation`, `ma_operation_work`, `ma_storage`  |
| `qwen_tool_publication_tenant`             | `ma_tenant_guard`                                  |
| `qwen_tool_publication`                    | `ma_output_capture`                                |
| `qwen_tool_publication_object`             | `ma_resource`                                      |
| `qwen_tool_publication_operation`          | `ma_operation`                                     |
| `qwen_tool_publication_seal`               | `ma_output_capture`, `ma_resource`                 |
| `managed_agent_tool_result`                | `ma_operation`, `ma_message`                       |
| `managed_agent_artifact`                   | `ma_artifact`                                      |
| `qwen_output_session_retirement`           | `ma_session`                                       |
| `qwen_output_read_lease`                   | `ma_read_lease`                                    |
| `qwen_output_put_attempt`                  | `ma_operation`                                     |
| `managed_agent_definition`                 | `ma_agent_definition`                              |
| `managed_agent_definition_command`         | `ma_request_receipt`                               |
| `qwen_managed_channel_instance`            | `ma_channel_instance`                              |
| `qwen_managed_channel_binding`             | `ma_channel_binding`                               |
| `qwen_managed_channel_route`               | `ma_request_receipt`, `ma_operation`               |
| `qwen_managed_channel_delivery`            | `ma_delivery`                                      |
| `qwen_managed_channel_claim`               | `ma_delivery`                                      |
| `qwen_managed_automation_schedule`         | `ma_schedule`                                      |
| `qwen_managed_automation_occurrence`       | `ma_schedule_occurrence`                           |
| `qwen_managed_automation_command`          | `ma_request_receipt`                               |
