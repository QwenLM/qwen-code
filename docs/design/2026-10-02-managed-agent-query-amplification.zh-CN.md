# Managed Agent 查询放大修复

[English](2026-10-02-managed-agent-query-amplification.md) | [简体中文](2026-10-02-managed-agent-query-amplification.zh-CN.md)

## 1. 现状与问题

提议中;跟踪 GitHub issue #13181(对照 `main` a7deb01bcb 的审计)。

Managed Agent Runtime Broker 的四条热路径把数据库工作量放大到远超请求量,其中两条还在持有行锁时放大:

1. `ManagedAgentStore.materializeNextBatch` 在每批 ≤200 个事件后全量重写 `managed_agent_snapshot.items_json`,且全程持有事件摄入也需要的 `requireSessionForUpdate` 行锁。写入量随会话长度平方增长。
2. `ManagedEventStreamService` 几乎在每个事件、每个订阅者上执行 `requireReadGrant` → `ManagedWorkspaceRegistry.canRead`(SQL)。
3. `ManagedAgentService.listPublicSessions` / `listWebShellSessions` 在分页查询之外每行再跑 2-3 条查询(`findActiveTurn` / `findSnapshotCoveredSequence` / `findLatestTurn` / `findLatestEnvironmentEvent` / `approvalMode`)。
4. `ToolPublicationStore.producerBindingLocked` 在每次 publish/seal/prefix/finish 时倒扫会话 journal 直到上一条 `activation.changed`(每个 revision 一条 `SELECT ... FOR UPDATE`),全程持有发布行与租户锁。

相关项:`ManagedArtifactService.content` 每 64 KiB 分片重做多表权限检查;seal/finish 在 HTTP 请求线程上全量重读重哈希整条流。

## 2. 范围与不变量

范围内:四条编号路径加上 artifact 下载检查。对外 API 形态、事件/journal 记录格式、授权的失败关闭(fail-closed)语义均不改变。两处有意放宽、且由 issue 明确认可的是有界陈旧:权限决定可在一个复检窗口内复用(默认 5 秒,运维可配置,不设强制上限;`PT0S` 恢复逐事件检查);snapshot 在突发期间可落后于投影,但摄入暂停后收敛(同样受 5 秒的 snapshot 节奏约束)。

范围外:拆分 `ManagedAgentStore`;把 seal/finish 的字节重哈希移出请求线程。重哈希是对可变对象存储的完整性承诺,异步化会改变 seal API 契约(客户端必须轮询 `operationStatus`)。该路径的数据库侧已在本设计中修复但默认按开关启用:待集群全部运行 V36 代码后,运维打开 `journal-head-authorization`,其心跳重授权才经由第 6 节变为 O(1)(灰度方式见第 9 节;开关切换本身由后续 issue #13295 跟踪);在此之前心跳仍按原样走旧式 journal 扫描。契约变更由后续 issue #13242 跟踪。

## 3. Snapshot 重写门控

`materializeNextBatch` 保持逐事件投影到 item 表以及 consumer-progress 更新不变,但仅在满足以下任一条时重写 snapshot:

1. snapshot 行尚不存在(insert 路径,不变);
2. 本批携带 terminal 事件——Turn 结束时一定重写,读侧因此在 Turn 边界收敛;
3. 投影自 snapshot 的 `covered_sequence` 以来推进了至少 `SNAPSHOT_REFRESH_EVENTS`(1000)条事件;
4. 本批追平了 `session.last_sequence`(整批期间会话行持有 `FOR UPDATE` 锁,该比较是稳定)且距上次 snapshot 写入已过去至少 `SNAPSHOT_REFRESH_MILLIS`(5000)——涓流情形(单批小于调度周期一个 `EVENT_LIMIT` 的批量)不得每周期重写。

被规则 4 推迟的已取完批次会让 snapshot 落后于投影,而 consumer progress 已经覆盖,因此推迟被记录在进度行上:该批次的进度更新把 `snapshot_stale_since` 写为 snapshot 的 `updated_at`(迁移 `V38`),`findMaterializationTargets` 重新选中标记已至少 `SNAPSHOT_REFRESH_MILLIS` 旧的会话;被重新选中的(空)周期把 snapshot 收敛并清除标记。若没有这一重选,已追平的空闲会话永远不会被再次访问,snapshot 将永久陈旧;该标记使每周期扫描无需逐行探测 snapshot 表。

所有 snapshot 读方(`listPublicItems`、`transcript`、SSE resync 帧、`advanceReplayFloor`)本来就以 snapshot 自身的 `covered_sequence` 为准,因此更陈旧的 snapshot 仍然自洽;`transcript` 还会续读 snapshot 之后的事件(无 cursor 页返回快照之后的每一个事件,与已发布契约一致,因此流可以按所报告的水位续播而不留缺口),因此 WebShell 流的事件视图不失去实时性——其 items 数组来自 snapshot,滞后幅度与第 9 节对 `listPublicItems` 所述相同。

## 4. SSE 读授权复检窗口

每条流缓存其读授权,至多每个 `qwen.managed-agent.events.read-grant-recheck-interval`(`ManagedAgentProperties.Events` 新增 Duration,默认 `PT5S`,`PT0S` 恢复逐事件检查)复检一次。订阅开始时的 `requireReadableSession` 不变。被撤销的订阅者最多多收一个窗口的事件;`session.deleted` 事件仍立即终止流;复检失败仍按现状结束流。复检只在流循环迭代时运行,因此空闲流的关闭还要等下一次循环唤醒——最多在窗口之后再过一个 `events.poll-interval`(默认 5 秒)。每订阅者成本从每事件最多两次 `canRead` 降为每窗口一次。

## 5. 会话列表批量装配

分页查询保持不变;逐行查询改为加入 `AgentStateStore` / `ManagedAgentStore` 的分组批量查询:

- `findActiveTurns(tenant, sessionIds)`——一条查询,`ORDER BY created_at DESC` 后每个会话取首行(并列时仍不保证顺序,与现状一致)。
- `findSnapshotCoveredSequences(tenant, sessionIds)`——一条 `IN` 查询。
- `findLatestTurns(tenant, sessionIds)`——一条查询把 turn 行联接到每个会话最新的 `turn.accepted` 事件(`MAX(sequence_id)` 派生表),保持单会话 `findLatestTurn` 的语义,包括 turn 行必须存在的 join。迁移 `V37` 增加 `managed_agent_event (tenant_id, session_id, event_type, sequence_id)` 索引,使该查询读索引范围而非会话的整个事件历史。
- `findLatestEnvironmentEvents(tenant, turns)`——一条查询在 SQL 内选出每个会话最新 Turn 上的最新 environment 事件(以 (session, turn) 对过滤的 `MAX(sequence_id)` 派生表),因此每个会话恰好读取一行。
- `completedWorkspaceCloses(tenant, sessionIds)`——对 `managed_agent_operation` 的一条 `IN` 查询,仅在页面含 workspace 绑定会话时执行,为 archive/unarchive/delete 能力位提供数据而不逐行查询。

两个 turn 读取都只投影 `TURN_SUMMARY_COLUMNS`(`session_id, turn_id, status, created_at, completed_at, error_code`)——正好是 public 与 WebShell 视图暴露的字段——因此一页永远不会逐行 Jackson 解析或持有 prompt 图。approval mode 不需要单独的查询:`sessionMapper` 的每次读取都是对 `managed_agent_session` 的 `SELECT *`,因此 mapper 现在把 `approval_mode` 映射进 `SessionRecord`,`hasActions` 直接读分页已经取回的行。

未绑定会话的页面在两个面上都至多 3 条查询;含 workspace 绑定会话的页面多一条 close 状态批量读;WebShell 页面若含有可提交形态的会话则再加一条创建者标记批量读,其中存在创建者持有的会话时再加一条授权批量读——均与页大小无关。单会话视图(`publicSession`、`webShellSession`)以单元素输入复用同一装配路径,保持单一代码路径。单会话 store 读取(`findActiveTurn` / `findLatestTurn` / `findLatestEnvironmentEvent`、`findSnapshotCoveredSequence`)已无生产调用方,全部删除,因此每条选择规则只有一份书写;close 状态谓词同样只有一份书写——单数 `hasCompletedWorkspaceClose` 委托给批量孪生方法。

## 6. 发布授权 O(1)

迁移 `V36` 为 `qwen_managed_session_journal_head` 增加五个可空列:`activation_id`、`activation_phase`、`activation_event_epoch`、`activation_expires_at` 与 `activation_head_revision`。`ManagedSessionStore.commit` 在每次提交本就要做的扩展记录解析遍历中顺带收集最后一条区间内的 `activation.changed` 的 payload(不再额外解码记录字节),把其字段写入 head——与推进 `journal_revision` 在同一条 head `UPDATE` 中;时间戳 `activation_head_revision = journal_revision` 在携带 activation 变更的提交上写入,在其余提交上仅当被保留的列在上一 revision 还是最新时才推进——被保留列的时间戳已经落后时提交保持其落后,因此 pre-V36 写入方留下的偏差永远不会被重新打戳伪装成新鲜。因此 head 行在相同的锁纪律下承载 journal 的当前 activation 状态,而时间戳标明这些列反映到哪个 journal revision:不维护这些列的二进制的提交仍会推进 `journal_revision`,于是其 head 无法通过时间戳相等检查,授权回退重扫 journal——滚动窗口因此自愈:扫描的回填会重写各列并重新打戳。payload 可能缺少 `expiresAt`(`timeOrNull`);对应列为 NULL 时新鲜性检查失败,与 journal 扫描读不到该值的效果一致。payload 的 `expiresAt` 的三个读取方(commit 提取与两处回填扫描)共用一个宽松 helper——不超过 19 位整数位且不超过 19 位小数位的整数数字或整数字符串,否则视为缺失,且在任何 BigInteger 物化之前先做宽度与小数位预检,指数形态字符串在两个方向上零开销(1e+N 需要巨型整数,1e-N 在除法前要展开 10^N)——因此扫描与 head 列对「是否可表示」永不分歧。

当滚动部署的集群仍可能运行 pre-V36 旧二进制(提交时不维护这些列)时,head 尚不可信,因此 `qwen.managed-agent.tool-publication.journal-head-authorization`(默认 `false`)让授权继续走 journal 扫描。待所有写入方都运行 V36 schema 对应的代码后,运维打开开关:

`ToolPublicationStore.producerBindingLocked` 直接检查它已经 `FOR UPDATE` 读出的 head 列——phase 为 `active`、id 与事件 epoch 和 binding 一致、`activation_expires_at` 未过期,且时间戳等于 head 的 `journal_revision`——取代倒扫 journal。当这些列为 NULL 或时间戳落后(迁移前写入的 journal、从未提交过 activation 变更的 journal、载荷宽于列宽——此时 commit 选择清空列而非拒绝——或 pre-V36 提交留下的残余)时,回退执行一次旧的扫描,并用找到的事件回填 head——列已持有完全一致取值时跳过这次写入——使每个会话在迁移后首次授权或下次 activation 变更后进入 O(1)。`verifyDispatch` 与 seal/prefix/finish 的心跳都经由 `producerBindingLocked`,因此都变为 O(1)。

`ToolPublicationStore.requireEvidence`(reserve/renew)通过扩展后的 `PublicationWriter` 记录从已加锁的 head 取 activation 状态——先于任何其他读取,因此被围栏的 activation 不付出任何 journal 语句——并按 `tool.intent` 所在的 revision 直接读取:binding 携带 `intentSequence`,一条对 `last_sequence` 的索引范围读(迁移 `V39`)即可解析出 revision,再取一页经过校验的记录,并以一次索引计数(带上旧式遍历逐 revision 施加的同一字节长度触发器)证明从该 revision 到已加锁 head 的链无空洞。语句数恒定——无论日志多深都是 4 条 journal 语句——而定位的行代价随 intent 到 head 的距离增长,与旧式遍历相同(旧遍历为同样的距离付出整行加锁读,因此 head 路径严格更轻,而非渐近常数)。遗留行保持原来的联合扫描,并在成功后回填 head。

## 7. Artifact 下载复检节流

`ManagedArtifactService.content` 保留每次调用的读超时守卫,但 `requireContentAccess`(会话行 + workspace 授权 + policy)至多每个 `qwen.managed-agent.artifacts.read-revalidation-interval`(新增 Duration,默认 `PT5S`)重做一次。开始流式传输前的首次检查不变,因此撤销延迟被限定在一个窗口内,而不是每 64 KiB 分片重新评估一次。

该窗口节流的是 `requireContentAccess` 整体,其中包含会话生命周期门禁:下载进行中进入 stage-1 `DELETING` 的会话同样只在下一个窗口边界被察觉,而不是下一个分片(stage-2 retirement 仍经由读取租约逐分片中止)。这一推迟与授权复检一样,是有意接受的有界陈旧;读超时守卫仍把任何下载硬性封顶在 `read-timeout`。`ReadLease.check()` 有意不接管生命周期检查:它被 retention 与生产者路径共享,而那些路径必须能继续读取正在被删除会话的行。

## 8. 验证与验收

- `Issue13181QueryBudgetTest` 的 `QueryLedger` 辅助(统计预编译语句的 `DataSource` 代理)钉住各端点的查询预算:20 个会话一页的 `listPublicSessions` ≤ 3 条查询(workspace 绑定行 4 条,多一条 close 状态批量读)、`listWebShellSessions` ≤ 3 条(可提交形态会话中含创建者持有者的绑定页为 6 条——分页、最新 Turn、环境事件、close 批量、创建者标记、授权;页面不含 Turn 而跳过环境事件批量读时为 5 条),并断言两个批量 turn 读取只投影摘要列、准入顺序的选择规则经分页路径验证(一个会话的两个 Turn 以非 `created_at` 顺序准入、environment 事件 sequence 倒置)。`materializeNextBatch` 在突发期间每 1000 条已覆盖事件最多重写一次 snapshot,涓流取完时每 `SNAPSHOT_REFRESH_MILLIS` 最多一次,terminal 事件必写,且被推迟的 snapshot 被钉住在老化重选时收敛。activation 提交后的 `verifyDispatch`/`publish` 对 `qwen_managed_session_journal_tx` 读零次(seal/prefix/finish 共用同一 `producerBindingLocked` 路径);`renew` 在 intent 自己的 revision 直接读取,无论堆积多少 revision 都恒定 4 条 journal 语句(范围读 + 链式计数 + 校验页),且被围栏的 renew 不付出任何 journal 语句。artifact 复检窗口由 `ManagedArtifactReadIntegrationTest` 的策略调用计数单独钉住,包括 stage-1 `DELETING` 的推迟观察。
- `ManagedEventStreamServiceTest` 的撤销测试固定为零窗口,并新增窗口化测试统计各事件间的 `canRead` 调用次数:窗口覆盖一次投递、窗口到期后撤销生效、成功复检后窗口重新装配、以及经 null 哨兵路径走到发布的 5 秒默认值(数值本身在 `ManagedAgentPropertiesTest` 中钉住)。
- 其余现有套件必须不变通过:`ToolPublicationStoreTest`(activation 围栏现在经由 `sessions.commit` 走 head 列,且两条反向 journal 扫描的记录内顺序)、`ManagedAgentApiIntegrationTest`、`ManagedAgentMySqlIT`、`RuntimeBrokerFlywaySchemaTest`。`ManagedArtifactReadIntegrationTest` 新增了窗口测试并为它们抽取了共享 setup。`ManagedAgentServerIntegrationTest` 是有意例外:物化器的 10ms 心跳与其显式追平存在竞争,因此其 transcript 追平等待预算提高到 15 秒(被推迟的 snapshot 在一个 `SNAPSHOT_REFRESH_MILLIS` 内收敛),且两个快照内容测试(`preservesTextOrderAcrossToolsAndReasoningInSnapshots`、`singleAppendsContinueTheTextPartBeforeThem`)把夹具的末尾事件标记为 terminal,使显式追平必然重写——两者的断言均未改变。
- 验收:钉住的预算成立;除有意更新的撤销语义外没有测试改变预期;遗留回退仍能授权迁移前的 journal(由把新列置 NULL 的测试覆盖)。

## 9. 风险与后续

- 第 4、7 节的有界陈旧放宽是有意为之;两个间隔默认 5 秒,为运维可配置的 Duration,不设强制上限(`PT0S` 恢复严格的逐事件行为),因此部署方可以通过配置放宽所接受的陈旧度。
- 突发期间落后的 snapshot 会把 `listPublicItems` 的实时性最多推迟 1000 条已覆盖事件;读侧在 Turn 边界收敛,涓流取完时经重选规则在 `SNAPSHOT_REFRESH_MILLIS` 内收敛。
- 第 6 节的遗留扫描回退会让迁移前的 journal 在首次授权或 activation 变更前保持旧成本;这是有意选择,以避免对 journal 字节做数据迁移。
- 滚动部署:pre-V36 旧二进制的 commit 不维护 head 的 activation 列,因此旧二进制仍在写入时这些列可能变陈旧。`activation_head_revision` 时间戳记录这些列反映到哪个 journal revision,因此这种 head 无法通过时间戳检查,授权回退重扫 journal 并重新回填——提前打开开关也会逐会话自愈,而不是把陈旧状态认证为有效。`journal-head-authorization` 开关(默认关)仍然作为刻意的运维开关发布;待集群全部运行 V36 代码后打开,残余偏差会被检测并修复而非被信任。
- 第 6 节 head 路径的链式证明是带旧式遍历字节长度触发器的计数,而非对中间 revision 的逐行解析:在本变更之前写入的 journal 若含外部作用域的行,旧式扫描能捕获,而 head 回填后不再重读。现在提交侧拒绝任何作用域错误、版本未知的事件行(head 只持久化 `activation.changed` 行的载荷),因此残余只限于已被行为不端的写入方写入的 journal——而这样的写入方同样能写出作用域正确的伪造行。
- 后续:把 seal/finish 流重哈希移出请求线程(需要异步 seal 契约——issue #13242);并如 issue 所述考虑拆分 `ManagedAgentStore`。
