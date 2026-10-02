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

范围外:拆分 `ManagedAgentStore`;把 seal/finish 的字节重哈希移出请求线程。重哈希是对可变对象存储的完整性承诺,异步化会改变 seal API 契约(客户端必须轮询 `operationStatus`)。该路径的数据库侧仍在本设计中修复:其心跳重授权经由第 6 节变为 O(1)。契约变更由后续 issue #13242 跟踪。

## 3. Snapshot 重写门控

`materializeNextBatch` 保持逐事件投影到 item 表以及 consumer-progress 更新不变,但仅在满足以下任一条时重写 snapshot:

1. snapshot 行尚不存在(insert 路径,不变);
2. 本批携带 terminal 事件——Turn 结束时一定重写,读侧因此在 Turn 边界收敛;
3. 投影自 snapshot 的 `covered_sequence` 以来推进了至少 `SNAPSHOT_REFRESH_EVENTS`(1000)条事件;
4. 本批追平了 `session.last_sequence`(整批期间会话行持有 `FOR UPDATE` 锁,该比较是稳定)且距上次 snapshot 写入已过去至少 `SNAPSHOT_REFRESH_MILLIS`(5000)——涓流情形(单批小于调度周期一个 `EVENT_LIMIT` 的批量)不得每周期重写。

被规则 4 推迟的已取完批次会让 snapshot 落后于投影,而 consumer progress 已经覆盖,因此 `findMaterializationTargets` 还会在 snapshot 落后进度且陈旧超过 `SNAPSHOT_REFRESH_MILLIS` 时重新选中该会话;被重新选中的(空)周期把 snapshot 收敛。若没有这一重选,已追平的空闲会话永远不会被再次访问,snapshot 将永久陈旧。

所有 snapshot 读方(`listPublicItems`、`transcript`、SSE resync 帧、`advanceReplayFloor`)本来就以 snapshot 自身的 `covered_sequence` 为准,因此更陈旧的 snapshot 仍然自洽;`transcript` 还会续读 snapshot 之后的事件,WebShell 读的实时性不受影响。

## 4. SSE 读授权复检窗口

每条流缓存其读授权,至多每个 `qwen.managed-agent.events.read-grant-recheck-interval`(`ManagedAgentProperties.Events` 新增 Duration,默认 `PT5S`,`PT0S` 恢复逐事件检查)复检一次。订阅开始时的 `requireReadableSession` 不变。被撤销的订阅者最多多收一个窗口的事件;`session.deleted` 事件仍立即终止流;复检失败仍按现状结束流。每订阅者成本从每事件最多两次 `canRead` 降为每窗口一次。

## 5. 会话列表批量装配

分页查询保持不变;逐行查询改为加入 `AgentStateStore` / `ManagedAgentStore` 的分组批量查询:

- `findActiveTurns(tenant, sessionIds)`——一条查询,`ORDER BY created_at DESC` 后每个会话取首行(并列时仍不保证顺序,与现状一致)。
- `findSnapshotCoveredSequences(tenant, sessionIds)`——一条 `IN` 查询。
- `findLatestTurns(tenant, sessionIds)`——一条查询把 turn 行联接到每个会话最新的 `turn.accepted` 事件(`MAX(sequence_id)` 派生表),保持单会话 `findLatestTurn` 的语义,包括 turn 行必须存在的 join。迁移 `V35` 增加 `managed_agent_event (tenant_id, session_id, event_type, sequence_id)` 索引,使该查询读索引范围而非会话的整个事件历史。
- `findLatestEnvironmentEvents(tenant, turns)`——对这些 (session, turn) 对一条查询,按 sequence 倒序每个会话取首条。
- `completedWorkspaceCloses(tenant, sessionIds)`——对 `managed_agent_operation` 的一条 `IN` 查询,仅在页面含 workspace 绑定会话时执行,为 archive/unarchive/delete 能力位提供数据而不逐行查询。

两个 turn 读取都只投影 `TURN_SUMMARY_COLUMNS`(`session_id, turn_id, status, created_at, completed_at, error_code`)——正好是 public 与 WebShell 视图暴露的字段——因此一页永远不会逐行 Jackson 解析或持有 prompt 图。approval mode 不需要单独的查询:`sessionMapper` 的每次读取都是对 `managed_agent_session` 的 `SELECT *`,因此 mapper 现在把 `approval_mode` 映射进 `SessionRecord`,`hasActions` 直接读分页已经取回的行。

未绑定会话的页面在两个面上都至多 3 条查询;含 workspace 绑定会话的页面多一条 close 状态批量读——均与页大小无关。单会话视图(`publicSession`、`webShellSession`)以单元素输入复用同一装配路径,保持单一代码路径。单会话 store 方法 `findActiveTurn` / `findLatestTurn` / `findLatestEnvironmentEvent`(保留其 `session_not_found` 检查)是对批量孪生方法的一行委托,因此每条选择规则只有一份书写;`findSnapshotCoveredSequence` 没有任何调用方,已删除。

## 6. 发布授权 O(1)

迁移 `V34` 为 `qwen_managed_session_journal_head` 增加四个可空列:`activation_id`、`activation_phase`、`activation_event_epoch`、`activation_expires_at`。`ManagedSessionStore.commit` 在每次提交本就要做的扩展记录解析遍历中顺带收集最后一条 `activation.changed` 的 payload(不再额外解码记录字节),把其字段写入 head——与追加 journal 事务、推进 `journal_revision` 在同一个事务内。因此 head 行在相同的锁纪律下承载 journal 的当前 activation 状态。payload 可能缺少 `expiresAt`(`timeOrNull`);对应列为 NULL 时新鲜性检查失败,与 journal 扫描读不到该值的效果一致。payload 的 `expiresAt` 的三个读取方(commit 提取与两处回填扫描)共用一个宽松 helper——整数数字或整数字符串,否则视为缺失——因此扫描与 head 列对「是否可表示」永不分歧。

当滚动部署的集群仍可能运行 pre-V34 旧二进制(提交时不维护这些列)时,head 尚不可信,因此 `qwen.managed-agent.tool-publication.journal-head-authorization`(默认 `false`)让授权继续走 journal 扫描。待所有写入方都运行 V34 schema 对应的代码后,运维打开开关:

`ToolPublicationStore.producerBindingLocked` 直接检查它已经 `FOR UPDATE` 读出的 head 列——phase 为 `active`、id 与事件 epoch 和 binding 一致、`activation_expires_at` 未过期——取代倒扫 journal。当这些列为 NULL(迁移前写入的 journal、从未提交过 activation 变更的 journal,或载荷宽于列宽——此时 commit 选择清空列而非拒绝)时,回退执行一次旧的扫描,并用找到的事件回填 head,使每个会话在迁移后首次授权或下次 activation 变更后进入 O(1)。`verifyDispatch` 与 seal/prefix/finish 的心跳都经由 `producerBindingLocked`,因此都变为 O(1)。

`ToolPublicationStore.requireEvidence`(reserve/renew)通过扩展后的 `PublicationWriter` 记录从已加锁的 head 取 activation 状态,并按 `tool.intent` 所在的 revision 直接读取:binding 携带 `intentSequence`,一条对 `first_sequence`/`last_sequence` 的范围读即可解析出 revision,再取一页经过校验的记录,并保留对该 revision 的链式检查。遗留行保持原来的联合扫描,并在成功后回填 head。

## 7. Artifact 下载复检节流

`ManagedArtifactService.content` 保留每次调用的读超时守卫,但 `requireContentAccess`(会话行 + workspace 授权 + policy)至多每个 `qwen.managed-agent.artifacts.read-revalidation-interval`(新增 Duration,默认 `PT5S`)重做一次。开始流式传输前的首次检查不变,因此撤销延迟被限定在一个窗口内,而不是每 64 KiB 分片重新评估一次。

该窗口节流的是 `requireContentAccess` 整体,其中包含会话生命周期门禁:下载进行中进入 stage-1 `DELETING` 的会话同样只在下一个窗口边界被察觉,而不是下一个分片(stage-2 retirement 仍经由读取租约逐分片中止)。这一推迟与授权复检一样,是有意接受的有界陈旧;读超时守卫仍把任何下载硬性封顶在 `read-timeout`。`ReadLease.check()` 有意不接管生命周期检查:它被 retention 与生产者路径共享,而那些路径必须能继续读取正在被删除会话的行。

## 8. 验证与验收

- `Issue13181QueryBudgetTest` 的 `QueryLedger` 辅助(统计预编译语句的 `DataSource` 代理)钉住各端点的查询预算:20 个会话一页的 `listPublicSessions` ≤ 3 条查询(workspace 绑定行 4 条,多一条 close 状态批量读)、`listWebShellSessions` ≤ 3 条,并断言两个批量 turn 读取只投影摘要列、准入顺序的选择规则经分页路径验证(一个会话的两个 Turn 以非 `created_at` 顺序准入、environment 事件 sequence 倒置)。`materializeNextBatch` 在突发期间每 1000 条已覆盖事件最多重写一次 snapshot,涓流取完时每 `SNAPSHOT_REFRESH_MILLIS` 最多一次,terminal 事件必写,且被推迟的 snapshot 被钉住在老化重选时收敛。activation 提交后的 `verifyDispatch`/`publish` 对 `qwen_managed_session_journal_tx` 读零次(seal/prefix/finish 共用同一 `producerBindingLocked` 路径);`renew` 在 intent 自己的 revision 直接读取,无论堆积多少 revision 都恒定 3 条 journal 语句。artifact 复检窗口由 `ManagedArtifactReadIntegrationTest` 的策略调用计数单独钉住,包括 stage-1 `DELETING` 的推迟观察。
- `ManagedEventStreamServiceTest` 的撤销测试固定为零窗口,并新增窗口化测试统计各事件间的 `canRead` 调用次数:窗口覆盖一次投递、窗口到期后撤销生效、成功复检后窗口重新装配、以及经 null 哨兵路径走到发布的 5 秒默认值(数值本身在 `ManagedAgentPropertiesTest` 中钉住)。
- 其余现有套件必须不变通过:`ToolPublicationStoreTest`(activation 围栏现在经由 `sessions.commit` 走 head 列,且两条反向 journal 扫描的记录内顺序)、`ManagedAgentServerIntegrationTest`、`ManagedArtifactReadIntegrationTest`、`ManagedArtifactApiIntegrationTest`、`ManagedAgentMySqlIT`、`RuntimeBrokerFlywaySchemaTest`。
- 验收:钉住的预算成立;除有意更新的撤销语义外没有测试改变预期;遗留回退仍能授权迁移前的 journal(由把新列置 NULL 的测试覆盖)。

## 9. 风险与后续

- 第 4、7 节的有界陈旧放宽是有意为之;两个间隔默认 5 秒,为运维可配置的 Duration,不设强制上限(`PT0S` 恢复严格的逐事件行为),因此部署方可以通过配置放宽所接受的陈旧度。
- 突发期间落后的 snapshot 会把 `listPublicItems` 的实时性最多推迟 1000 条已覆盖事件;读侧在 Turn 边界收敛,涓流取完时经重选规则在 `SNAPSHOT_REFRESH_MILLIS` 内收敛。
- 第 6 节的遗留扫描回退会让迁移前的 journal 在首次授权或 activation 变更前保持旧成本;这是有意选择,以避免对 journal 字节做数据迁移。
- 滚动部署:pre-V34 旧二进制的 commit 不维护 head 的 activation 列,因此旧二进制仍在写入时这些列可能变陈旧。因此在 `journal-head-authorization` 打开之前,授权始终读 journal;仅当整个集群都运行 V34 schema 对应的代码后才打开它,且只要仍可能回滚到 pre-V34 二进制就保持关闭。
- 后续:把 seal/finish 流重哈希移出请求线程(需要异步 seal 契约——issue #13242);并如 issue 所述考虑拆分 `ManagedAgentStore`。
