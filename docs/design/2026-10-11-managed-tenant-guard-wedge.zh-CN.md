# Managed Session 流量的租户守卫耦合加界

[English](2026-10-11-managed-tenant-guard-wedge.md) | [简体中文](2026-10-11-managed-tenant-guard-wedge.zh-CN.md)

- 状态：已在本改动中实现（见证：`ManagedSessionGuardConvoyIT`）；「后续」
  一节列出的车道仍保留无界获取
- Issue：[#13800](https://github.com/QwenLM/qwen-code/issues/13800)——一个处于
  `recovery_blocked` 的 Session 楔死同 daemon 上其他 Session 的后续轮次。
  本改动并不实现该 issue 的 W1 或 W2，见「范围」。
- 相关：验收报告 `docs/verification/13532-linux-h3/README.md`（发现 A2）、
  复现报告 `.qwen/issues/issue-13800.md`（不随仓库提交）。

## 问题

在 managed-agent 链路（MariaDB → managed-agent-server → hosted-harness
daemon → runtime worker）上，一个被标记为 `recovery_blocked` 的 Session
与无关 Session 的冻结存在相关性：受害 Session 的 journal 停在
`hostedModelAttempt` 之后，模型端点不再收到请求，回合从此不再结束。物理
验收环境中清掉存储行后行为恢复。验收报告只记录了相关性，没有机制。

### 范围

#13800 的 W1 已落定为另一种机制：Workspace 执行挂载租约，每个
`(tenantId, storageId)` 一行，由停住的被阻塞回合持有。楔死期间
`innodb_trx` 与各锁等待表均为空、broker 线程空闲，排除了租户级行锁
（[issue 评论](https://github.com/QwenLM/qwen-code/issues/13800#issuecomment-6094220681)）。
W2 是 [#13816](https://github.com/QwenLM/qwen-code/pull/13816)。本改动既不
实现 W1，也不满足 W2 的验收。

它修复的是调查中独立证实的另一种耦合（下文的守卫持有变体）：每个 Session
的逐轮 store 流量都在两张租户级守卫行上排队，任一行被长时间持有，就会让
无关 Session 冻结到超出客户端预算。

## 机制

Managed Session store 在**每一个** Session 的热写路径上无条件地取两个
per-tenant InnoDB record lock：

1. `qwen_runtime_placement_guard`（每租户一行），经
   `WorkspaceLifecycleStore.lockPlacement` 与
   `WorkspaceMigrationAdmission.lockTenant` 进入
   `JdbcRuntimeBindingRepository.lockPlacementDomain`。
2. `qwen_tool_publication_tenant`（每租户一行），经
   `ToolPublicationRetentionStore.lockTenant`。

本改动之前 `ManagedSessionStore` 的调用矩阵：

| 操作                 | placement guard                                                               | publication tenant 行                               | per-session 锁（head 行 / drain / session 行） |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `acquireWriter`      | 是——`checkLifecycleWriter`，及 `WorkspaceMigrationAdmission.sessionAdmission` | 是——`checkLifecycleWriter` 及一次显式调用           | 是                                             |
| `renewWriter`        | 是——`checkLifecycleWriter`                                                    | 是——`checkLifecycleWriter` + `requireHeadForUpdate` | 是                                             |
| `sealWriter`         | 是——`checkLifecycleWriter`                                                    | 是                                                  | 是                                             |
| `commit`             | 是——`checkLifecycleWriter`                                                    | 是                                                  | 是                                             |
| `blockRecovery`      | 否                                                                            | 是——`requireHeadForUpdate`                          | 是                                             |
| `authorizeOrdinary`  | 是——显式                                                                      | 是——显式                                            | 是（drain + head）                             |
| `authorizeLifecycle` | 是                                                                            | 是                                                  | 是（claim + session + head）                   |

对 `authority == null`（普通、非生命周期流量）`checkLifecycleWriter`
取两把锁，并执行一次 v2 探测（`ma_operation` 按 `operation_id` join
drain 行，种类 `CLOSE`/`ARCHIVE`/`DELETE`，
`lifecycle_protocol_version = 2`）；存在 v2 claim 时抛
`workspace_lifecycle_claim_fenced`。D1 迁移了这道栅栏，而不是删掉它。任何
事务把其中一行持有得比 harness 客户端 30 秒请求超时更久，其后到达的同租户
其他 Session 的下一次 store 调用都会被冻结，因为：

- InnoDB 锁等待（默认 50 秒）大于客户端超时（30 秒）；
- 每次超时调用会被重试，重试到达时服务端语句可能仍在排队，客户端等待
  与服务端等待叠加；
- 失败的 `acquireWriter` 可能留下已插入但未被接管的头行，同会话 ID 的
  后续创建在死写者租约到期前一律收到 `409
managed_session_writer_conflict`。

### 复现（守卫持有证据）

含环境、命令与原始日志的完整复现报告见 `.qwen/issues/issue-13800.md`。
决定性命名的变体摘要（本地 MariaDB 10.11 + managed-agent-server + 打包
hosted harness + 假模型端点）：

- **守卫持有变体（阳性）。** 外部事务持两行（`UPDATE ... WHERE
tenant_id = ?`）。结果：
  - 无关会话 ID 的创建卡在 `POST /writers:acquire`；daemon 报
    `Managed Session Store POST /writers:acquire failed ... aborted due
to timeout`（30002 ms），路由返回 503 `managed_session_open_failed`；
    `sys.innodb_lock_waits` 显示 29 个 waiter；后续创建在半插入头行上
    返回 409 `managed_session_writer_conflict`。
  - 预建受害 Session 的 `POST /session/:id/prompt` 卡住 30009 ms 并返回
    503 `hosted_execution_authorization_unavailable`；该回合模型端点
    零请求；释放守卫后正常完成。
- **裸 `recovery_blocked` 标记（阴性）。** 仅把
  `qwen_managed_session_journal_head.recovery_status` 设为
  `'BLOCKED_RESOURCE'` 不会楔死全新会话的回合（验收 pin 提交与调查
  head 两臂均验证）。
- **物化器 gap 毒害（单因子阴性）。** 在被卡会话事件流里人工注入序列
  gap 会触发 10 Hz `Message projection event sequence has a gap` 绊线
  （确证存在，`ManagedAgentStore.materializeNextBatch`），但本机受害
  回合正常完成。它是 2026-10-02 审计在册的真实放大器（§B1/B2），但不
  是此处的单独楔死机制。

守卫持有变体并不能解释物理 rig 上的楔死（见「范围」）。已被证明的缺陷是
耦合本身：**在本改动覆盖的车道上，租户级锁绝不能给它不属于的会话的逐轮
store 流量设卡。** 任何长持有——无论由什么产出——都必须让这些车道上其他
会话的回合要么完成，要么带具名原因快速失败。覆盖的车道是上表中的
`ManagedSessionStore` 操作、publication 车道（F2）与回合提交准入
（`ManagedAgentStore.insertTurnCommand`）。`ManagedAgentStore` 中其余对
placement 行的获取列在「后续」中。

## 守卫存在的理由（以及为什么不能一删了之）

两张守卫行实现的是跨域栅栏，整体删除会破坏真实契约：

- `WorkspaceMigrationAdmission.lockTenant`（placement guard）——「栅栏
  安装与准入共享此锁，先于任何 Session 锁」：storage-migration 栅栏
  （`qwen_runtime_storage_fence`）必须排除新的 Session writer。准入时点
  的 TOCTOU 窗口使该锁对 W1c 离线 workspace 迁移是负载语义。
- `WorkspaceLifecycleStore.lockPlacement` + claim 检查（placement
  guard）——L3 生命周期协议（close/delete）认领操作并串行化生命周期
  结算与普通写者。
- `ToolPublicationRetentionStore.lockTenant`（publication tenant 行）—
  工具输出 publication 域的 CAS 根（publish / receipts / 会话自有退休
  / 保留扫掠）。publication 路径按设计保留 per-tenant 串行化。

所以缺陷不在栅栏而在其**放置与窗口**：

1. 每个热路径操作（renew、普通 commit、seal、blockRecovery、普通授权）
   即使既不是准入、也不产生生命周期或 publication 效果，也照样取两把
   守卫。
2. 两侧持有窗口都无上界：获取侧不带语句超时（热路径实际
   `setQueryTimeout(0)`）；已知胖持有者（生命周期恢复事务、
   `requireIdleJournal` 的整 journal `FOR UPDATE` 扫描加 Java 侧 JSON
   解析）跨 O(journal)/O(records) 工作持锁。
3. 失败不对称（客户端 30 秒 < InnoDB 锁等待 50 秒）把瞬时争用放大成客
   户端可见的冻结。

## 目标

- G1：普通流量不再在它不需要的租户级守卫行后排队：另一事务持有租户守卫
  行时，会话的续租、普通准入与恢复状态都能完成。一个回合还要经过仍持守卫
  的车道（普通记录提交的有界 placement，见 F4；回合提交；writer 获取），
  因此只有在持有时长短于客户端请求预算时它才**能完成**；持有更久时，这些
  车道以具名 503 `tenant_guard_contended` 有界快速失败，而不是冻结。
- G2：覆盖车道上的热路径真正需要的守卫争用超过短预算时，调用**快速具名
  失败**而不是 30 秒客户端超时。这个名字送达 store 客户端，客户端在剩余请
  求预算内重试，并把它保留在最终错误上。争用超出该预算的回合以通用的
  `error` 停止原因落地，而不是静默冻结：harness 只把传输层与 5xx 存储故障
  在落地的回合结果中命名为 `managed_session_store_unavailable`，不会把有
  界的租户守卫拒绝称作存储故障。
- G3：`requireIdleJournal` 的 journal 扫描先以无锁方式运行，只有扫到已锁
  head 的 revision 时才被采信，否则改以加锁读重扫（D3）。生命周期恢复/校
  验事务在本改动中保留无界获取，也仍在租户行下做 journal 侧工作；给它们加
  界列为后续。
- G4：一条见证集成测试钉住该几何：耦合恢复时红、改动后绿。

## 非目标

- 钉出物理 rig 在 2026-10-09 那次的确切持有者（证据未留存；本修复消除
  的是楔死类而不是历史个案）。
- 改动生命周期 claim 协议语义、publication 域串行化、migration fence
  排除结果。
- 启用 `monitor_run` 或 `child_run` 的 `shell` kind，以及停在
  `dispatch_started` 的 `child_run` 记录（按 issue 口径另案）。
- 物化器 gap 绊线熔断与其它审计 §B 卫生项（另案跟踪，列为后续）。
- 续期调度器饥荒候选（复现假设 H2）——未决；本设计不针对它改动。

## 设计

### D1. 非准入热路径不再取租户守卫

在 `ManagedSessionStore`：

1. `checkLifecycleWriter` 仅当 `authority != null`（生命周期签发 writer）
   才取 placement guard 与 publication tenant 行。普通
   （`authority == null`）`commit`、`sealWriter`、`renewWriter` 与
   `acquireWriter` 不再经它取两道守卫。per-session 栅栏保留：Session 根行
   与 head 行的 `FOR UPDATE` 串行化单会话写者；drain 行栅栏
   （`requireOrdinaryAdmission`、`lifecycleFenced`）维持
   ordinary-vs-lifecycle 隔离。v2 claim 栅栏从 `checkLifecycleWriter` 迁到
   `requireNoLifecycleClaim`：`requireOrdinaryAdmission` 调用它，renew、
   seal、commit（首次尝试与重复提交的重放分支）以及工具结果发布在取得自身
   守卫或 head 锁之后调用它。
2. `authorizeOrdinary` 去掉其显式两道守卫；准入仍由
   `requireOrdinaryAdmission`（drain 行）+ head 行治理。
3. `findHeadForUpdate`/`requireHeadForUpdate` 不再经 `lockSessionHead`
   （它拖着 `lockTenant`），直接锁 head 行，并保留 `requireLive`。
   `lockSessionHead`/`lockTenant` 留给 publication 域属主（publish、
   receipts、retire、retention）。
4. `blockRecovery` 形状不变，只失去继承来的 tenant 行。

准入路径保留项：`authorizeLifecycle`（claim 协议）、`acquireWriter` 的
migration 准入（`WorkspaceMigrationAdmission.requireSessionOpen`；本改动
删掉了它自身的 `lockTenant`，placement 守卫改由调用方显式、有界地获取）
**及其 publication tenant CAS 行**
——Session 还没有 head 行时，该行是同 Session delete/retire 在飞期间的
唯一排序点（`writerAcquisitionAndRetirementSerializeEvenWithoutAnExistingHead`
钉住的契约），所以 `acquireWriter` 保留两者并按 D2 加界——以及所有
publication 路径的写者操作（`publishToolResult`、publication receipt
commit、退休）。

### D2. 其余热路径守卫获取全部加界

合法设防的准入路径（`acquireWriter` 的 migration 准入、
`authorizeLifecycle`、经 `checkLifecycleWriter` 带 authority 的生命周期
签发 commit/seal）以短语句超时获取守卫——使用既有的
`JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant,
timeoutSeconds)` 重载，并为 `ToolPublicationRetentionStore.lockTenant`
实现等价的有界变体：

- 热路径守卫获取预算：每条语句 **5 秒**。
- 超时以快速数据访问失败浮出，映射为 HTTP 503 `tenant_guard_contended`
  （锁等待），而不是静默久等。
- harness 客户端既有 `uncertain` 分类把 5xx 当可重试；服务端等待被压到
  ≤5 秒后，瞬时争用下三次重试落在一个客户端预算内；持续争用则退化为
  具名错误而非 30 秒冻结。在覆盖车道上，`innodb_lock_wait_timeout`
  （50 秒）不再先于客户端（30 秒）引爆。
- 覆盖车道包括 CSI 钉住 Session 的续接检查——在 renew、commit 与恢复状态
  上，它的 placement 与 publication 获取就是首个租户级等待——以及回合提交
  准入。

### D3. 已知无界持有者的重构

- `requireIdleJournal`（`WorkspaceLifecycleStore`）：journal 扫描先不带
  `FOR UPDATE` 运行。已有的 head 行 `FOR UPDATE` 先取——每个写者都只在
  它之后追加 revision——所以扫描过程中不会有 revision 提交，head 行仍是
  idle 检查的唯一序列化点。但无锁扫描是快照读，而外层生命周期事务可能在
  head 锁授予之前就用普通读（`beginWorkspaceLifecycle` 的重放与未结操作
  读取）钉住了 REPEATABLE READ 快照，这个窗口内提交的 revision 对扫描不可
  见。因此只有当扫描到的最大 revision 达到已锁 head 的 `journal_revision`
  时才采信它；否则改以加锁读重扫——加锁读读取当前已提交的 journal——并据
  此给出结论（`turn_active` 或放行）。加锁重扫后仍落后于自身 head 的
  journal 以 `workspace_lifecycle_journal_unverified` 失败闭。本改动的第一
  版在快照过期时一律拒绝，会让最后一个回合刚提交、实际空闲的 Session 得到
  409（已在 2026-10-16 的评审轮修正）。
- 生命周期恢复事务（`recoverEffects`/`saveEffects`）本次不动；D1 之后
  同租户普通流量已不再在这些守卫后面排队，其窗口压界列为后续。

### D4. Harness 侧契约（TypeScript）

当一回合内 store 重试被 transport/5xx 失败耗尽时，回合必须以具名原因
结束而不是 journal 冻结：

- `packages/cli/src/serve/hosted-harness-session.ts`：在 prompt 路由的
  落定路径里，store 不可用类失败以 `turn_result` `state: 'error'` 落定，
  `stopReason: 'managed_session_store_unavailable'`（SSE/stderr 文案同
  码）。若 `turn_result` 自身也无法提交（写路径已闭锁），daemon 在内存
  保留该具名失败并经由 `/session/:id/status` 反映
  （`recoveryBlocked` 保持 per-session；既有行为是置
  `session.blocked`）——具名原因在 block 存续期经同一 JSON 载荷的
  `recoveryReason` 字段返回。
- store 客户端超时/重试预算不变；D2 让这些预算重新有意义。

### D5. 见证集成测试

在 `managed-agent-server` 新增集成测试 `ManagedSessionGuardConvoyIT`（沿用
既有 `*MySqlIT` 夹具族）。它需要 `jdbc:mysql:` URL，可在 MySQL 8.4 或
MariaDB 10.11 上运行。它不是 PR 门禁：#14205 起 Java 数据库车道只按每日
计划与手动触发运行，因此其变异保证需要人工执行。

1. 同租户建两个会话，一个标成 `recovery_blocked`（头行 UPDATE，对齐复
   现夹具手法）。
2. 另开一个外部 JDBC 事务持两行（`UPDATE ... WHERE tenant_id = ?`）。
3. **见证断言**：持锁期间，另一会话的 `acquireWriter`（migration 准入
   情形）在一个守卫预算内以具名错误失败（断言上限固定为 15 秒，把预算调
   到超过它时见证会变红）；`renewWriter`、
   `authorizeOrdinary`、`blockRecovery`（D1 断耦情形）正常完成，而普通
   记录 `commit` 以同一具名错误快速失败（R2 起它重新有界获取
   placement 守卫）；被卡行的 `recovery_status` 不变。
4. 释放持有；先前具名失败的操作重试成功。
5. 变异反证：恢复 `checkLifecycleWriter` 的无条件获取后 D1 情形重新被
   拖死（测试夹具由此硬编码预期调用矩阵）。

`requireIdleJournal` 的见证：
`WorkspaceLifecycleMySqlIT#idleJournalCheckReadsARevisionItsSnapshotCannotSee`
钉住 REPEATABLE READ 快照，从另一连接提交一个让回合保持未决的 revision，
然后分别直接调用 idle 检查与经 `beginWorkspaceLifecycle` 调用，断言
`turn_active`；`#idleJournalCheckFailsClosedOnAJournalShortOfItsHead` 对落后
于 head 的 journal 断言 `workspace_lifecycle_journal_unverified`。「外部持守
卫时 idle 检查仍可完成」没有见证。

## 风险与缓解

- **R1——migration 准入回归（D1 不动它，D2 给它加界）。**
  `acquireWriter` 为 `requireSessionOpen` 保留 placement guard，现在在它
  之前显式、有界地获取；5 秒预算
  只会把曾经的冻结竞态变成具名 503。迁移 IT 必须全绿
  （`WorkspaceLifecycleMySqlIT` 族）。
- **R2——生命周期协议栅栏。** 生命周期签发写者保留全套锁与 claim 检查；
  `authorizeLifecycle` 语义不变。既有生命周期套件加见证的生命周期臂覆
  盖。
- **R3——publication 域顺序。** D1 保留 publication 路径的显式
  `lockTenant`；见证断言 publication commit 路径不受影响
  （`ToolPublicationStoreTest` 族必须全绿；publication commit 经
  `publicationRequest` → `ToolPublicationStore` 自有锁）。
- **R4——`requireIdleJournal` 无锁读会看到过期的未决集合。** 以扫描到的最
  大 revision 与已锁 head 的 revision 对比来缓解：扫描落后则改以加锁读重
  扫，只有重扫后仍落后于 head 的 journal 才失败闭（blocked，不放行）。
- **R5——MySQL/MariaDB 方言。** 有界获取走 Connector/J 语句超时，不用
  `NOWAIT`/厂商子句；已在 MariaDB 10.11.18（计划内 CI 车道的镜像）与
  MySQL 8.4.7 上实测。
- **R6——病理持续持有下的行为。** 持有超过重试预算仍无法完成（不删行任
  何设计都做不到）；本设计交付的契约是：瞬时争用 ⇒ 完成；持续争用 ⇒
  快速具名失败，永无静默冻结，且永不让某会话的行给它不属于的会话设
  卡（D1）。

## 验证计划

1. `managed-agent-server` 与 `runtime-broker` 的单元/集成套件（Maven、
   JDK 21）：生命周期、publication、迁移、凭据、store binding 套件必须
   全绿（两模块 `mvn verify`）。
2. 新见证 `ManagedSessionGuardConvoyIT` 在 `mysql-integration` profile 下运行。
   PR 不再运行它（#14205 把 Java 数据库车道改为每日计划与手动触发），合入
   证据须是一次手动触发的 `sdk-java.yml` 运行，或附上的
   `mvn -Pmysql-integration -Dit.test=ManagedSessionGuardConvoyIT` 记录。
3. TypeScript：`packages/core` 的 HTTP 会话存储既有测试、`packages/cli`
   hosted-harness 套件；为具名落定路径新增单测。
4. 以复现脚本（`.qwen/issues/13800-repro/` 保留）重跑 E2E：守卫持有变
   体现在只产出快速具名失败或正常回合，不再出现 30 秒冻结。
5. #13532 的物理 rig 复验仍是独立后续，属于 #13800 的 W2（#13816），
   不属于本改动。

## 验收标准

1. `ManagedSessionGuardConvoyIT` 在手动触发或本地的 `mysql-integration`
   运行中绿；回退 D1 调用点后转红（开发期变异验证）。
2. managed-agent 全部既有 Java 套件绿（生命周期/publication/迁移各
   条车道语义无漂移）。
3. 复现 E2E 的守卫持有变体下，覆盖车道上全新会话的创建与回合不再冻结；
   持续持有下出现的失败一律带具名码。
4. `recovery_blocked` 标记的表述仍准确：被卡会话继续准确报告自身阻
   塞状态（见证步骤 3 的断言）。

## 评审修正（R1，2026-10-12）

首轮评审证明解耦本身引入了三处缺陷；三处均在本改动内修复并以见证钉
住。

### F1. 重放快照只允许在取得 head 锁之后钉住

从 `findHeadForUpdate` 移除 per-Session 的 `lockSession` 后，`requireLive`
这条普通读成了事务首个一致性读。REPEATABLE READ 下它在 head 行锁等待
之前钉快照：被该锁放行的重复提交在 `findTransactionByCommand` 里仍读旧
快照，看不到赢家已提交的事务，落入 `validateHead`，把幂等重试变成
`managed_session_head_conflict` 409。`findHeadForUpdate` 现在先执行 head 行
`SELECT ... FOR UPDATE`，依赖快照的读取均在持锁之后。见证：
`ManagedSessionGuardConvoyIT#duplicateCommitReplaysOnceTheWinnerReleasesItsGuards`
（R2 起改名——重试先停在 commit 的有界 placement 守卫，head 行锁在其
后）。

### F2. 有界必须落在各车道首次获取处，而不是下游

publication 车道在到达 `lockPublicationWriter` 之前就已触租户守卫：
`applyLocked` 内联执行自己的 tenant INSERT/SELECT，`prepareAdmission` 与
`commitReceipt` 各自调用自身锁函数（receipt 还先无超时取 placement guard），
且 `grants.lockOriginalSettledResult` 与 retention 读 lease 的开口
（`lockSessionHead`）更早触 CAS 行。apply/准入/回执三条车道与 lease 开口的
首次获取现均以同一逐语句上界运行并共享 `tenant_guard_contended` 映射。见
证：`ManagedSessionGuardConvoyIT#heldTenantGuardsBoundPublicationLaneEntries`。

取得 tenant 行后，`lockSessionHead` 也为 root UPSERT、root 加锁读取与 head
加锁读取设置每条语句五秒的上界，并共享 `tenant_guard_contended` 映射，
包括锁等待超时 1205，避免因一个 Session 的 writer 占住 publication 守卫，
一直等到数据库默认锁等待超时。既有更短的语句或事务超时继续生效；普通
root-only writer 路径保留原等待设置与死锁映射。见证
`ManagedSessionGuardConvoyIT#heldSessionRowsBoundRetentionReads` 检查 root 与
head 被持有时的有界拒绝，以及释放后的成功读取，覆盖 #14393 A.2。
producer/dispatch placement 和更早的 lifecycle 获取仍由 #14393 A.1/A.3
独立跟踪。

### F3. writer 获取保持 placement 先于 drain 栅栏

普通分支的 `checkLifecycleWriter` 早退后，`acquireWriter` 先读
`requireOrdinaryAdmission`、再取 placement guard。drain 行不存在时，
`SELECT ... FOR UPDATE` 在 REPEATABLE READ 下持有 next-key/gap 锁；生命周期
侧恒以 placement 在先、再插入 drain 行，因此 writer 持 gap 锁等待
placement 成环，InnoDB 以击毙 writer 化解（经有界路径浮出水面的是 1213 而
非正确的 409）。`acquireWriter` 现在先取有界的 placement guard，再读 drain
栅栏。见证：
`ManagedSessionGuardConvoyIT#writerAcquisitionOrdersPlacementBeforeTheDrainFence`。

## 评审修正（R2，2026-10-12）

R1 推送后两条 Java/MySQL CI 车道转红；在 R1 前基线（`134ff291da`）上的
SHA 级复现给出完全相同的签名，三处失败均可归因于 D1 自身而非 R1 改
动。两处机理在本改动内修复并以见证钉住。

### F4. 普通记录提交仍须持有有界的 placement 守卫

D1 让 `commit()` 完全不再取守卫：`checkLifecycleWriter` 的普通分支早
退，而这条路径上再无他处触及 `qwen_runtime_placement_guard`。该行是生
命周期准入（`INSERT INTO qwen_runtime_placement_guard`）相对在飞记录
提交唯一的排序点，于是
`ManagedAgentMySqlIT#serializesDeletionBehindTheRecordCommit` 观测到
DELETE 准入绕过仍卡在记录行上的提交径直放行。`commit()` 现在在
`checkLifecycleWriter` 之后经同一有界封装重新获取 placement
guard——串行关系恢复，行被持有时仍在热路径预算内退化为
`tenant_guard_contended`。convoy 见证的 `committed` 臂随之一并翻转：
`heldTenantGuardsDoNotWedgeUnrelatedSessions` 现在等待该提交在上界内以
具名 503 快速失败，而非完成。记录提交持有该行正是栅栏所需的排序点；
有界获取使被持有场景退化为具名失败而非原先的拖死。

### F5. `acquireWriter` 的首个一致性读在 CAS 等待之后钉住

R1 的顺序把 `WorkspaceMigrationAdmission.requireSessionOpen`——一条普
通 SELECT、本事务的首个一致性读——排在 CAS 获取之前，REPEATABLE
READ 的快照由此在 `qwen_tool_publication_tenant` 等待之前钉住；在该等
待之下提交的退休对随后的 `requireLive` 不可见。retention harness 抛出
的是 `managed_session_not_writable` 而非 `tool_output_session_retired`
（`WorkspaceSessionRetentionMySqlIT#retirementSerializesQueuedWriterAndProjectionCompletion`），
O4 门控的迟到 writer 在应被拒绝处径直获得授权
（`O4MySqlGate#writerReallyWaitsOnRetirementTransactionAndThenIsRejected`）。
`acquireWriter` 现在依次执行有界 placement 获取、有界 CAS 获取，然后
才是它的一致性读，快照在等待之后钉住，可见赢家的提交。要守住的不变量
是：本车道上的每一条普通读都在这些等待之后。目前第一条是 CSI 运行时标记
探测（在根行锁之后，对 `ma_runtime_slot` 与 `ma_runtime_binding` 的两条普通
`SELECT`），其后是 `requireSessionOpen`。把任一条移到等待之前都会让缺陷
复现。

## Schema 整合（#14069，2026-10-14）

32 表 baseline（#14069）在本改动评审期间合入。上文各节保留整合前的表名。
合并后的 baseline 上：

- `qwen_runtime_placement_guard` 与 `qwen_tool_publication_tenant` 成为
  `ma_tenant_guard` 的 `runtime_placement` 与 `output_publication` 两个
  domain，仍是每租户每 domain 一行。D2 的有界获取对两个 domain 原样适用。
- journal head 与 Harness drain 行合并为每 Session 一行 `ma_session_head`，
  drain 准入读取与 head 锁落在同一行上。
- baseline 在租户守卫与 head 之间加入了每 Session 一行的 `ma_session` 根行
  （`lockSessionHead`），记录提交在 head 之后还会再锁该根行
  （`isBeingDeleted`）。普通写路径保留根行：`findHeadForUpdate` 先锁根行
  再锁 head，只去掉租户级行。`authorizeOrdinary` 在读 drain 之前先锁根行，
  `ensureSessionRoot` 在 `INSERT IGNORE` 之前先以排他锁取根行。因此所有
  不持租户守卫的写路径都是先根行后 head，也不会有共享锁排在别的写者的
  排他请求之后再升级。
- baseline 给记录提交、工具结果发布与 publication writer 加了
  `requirePhysicalSessionOpen`（placement 加物理存储准入），其中的
  placement 获取同样走有界包装。
- baseline 的心跳锁（`requireHeartbeatHead`）依赖 `checkLifecycleWriter`
  过去持有的租户守卫。现在它先锁 head 再做 `requireLive`，与
  `findHeadForUpdate` 顺序一致。
- `commit()` 保留 baseline 的顺序：重放查找在 head 锁之前。重复提交仍能
  重放，因为两次提交都先取有界的 placement 守卫，落后者的第一次一致性读
  发生在胜者提交之后。
- `requireNoLifecycleClaim` 按 Session scope key 与生命周期种类（`CLOSE`、
  `ARCHIVE`、`DELETE`）读 `ma_operation`。与 PR 之前的探测不同，它不 join
  drain 行：只要存在 v2 生命周期操作就拦截，包括 drain 行尚未写入该操作 id
  的窗口。没有任何代码路径会清除 drain 行上的操作或把其 phase 重新打开，
  因此两个谓词结论不同时 drain 守卫本来就会拒绝该写入，差别只在错误码。
- 在工具结果通道上，claim 检查对生命周期调用方同样生效。这保持了 baseline
  的行为：它在调用方自身检查之后再调用一次
  `checkLifecycleWriter(…, null)`，对所有调用方拦截 v2 Session。

## 评审修正（2026-10-15）

对 `f668634b96` 的评审找出了仍然无界等待或跳过栅栏的车道：

- CSI 钉住 Session 的续接检查以 10 秒超时取 placement、以无超时取
  publication 行，且不在具名映射之内，因此 publication 行被持有时，renew、
  commit 与恢复状态会冻结满 50 秒锁等待。两者现在都走有界封装。见证：
  `ManagedAgentCsiMutationMySqlIT#pinnedSessionBoundsItsTenantGuards`。
- 回合提交准入（`insertTurnCommand`）无超时地取 placement 行；现在有界并
  具名。见证：`heldTenantGuardsDoNotWedgeUnrelatedSessions` 的回合提交臂。
- 对 v2 已认领 Session 的普通重复 `commit()` 会被重放，因为迁移后的 claim
  栅栏只在重放分支之后运行。重放分支现在也运行它。见证：
  `WorkspaceProfileLifecycleTest#duplicateOrdinaryCommitIsFencedByAVersionTwoClaim`。
- CSI 运行时标记探测的两条普通读现在带守卫类的 10 秒语句超时，因为普通读
  仍会等元数据锁。

## 评审修正（2026-10-16）

对 `e1ba36ad4b` 的评审发现：

- **有界获取点上的死锁可能逃出具名映射。** 有界封装原先只捕获
  `CannotAcquireLockException` 与 `QueryTimeoutException`。经本栈默认的翻
  译器，MySQL/MariaDB 的 1213（SQLState 40001）以
  `CannotAcquireLockException` 到达（下方见证在 MariaDB 10.11.18 上实测），
  因此已被具名；而按错误码翻译的翻译器把它报为兄弟类
  `DeadlockLoserDataAccessException`，原先不会被具名。封装现在捕获整个
  `PessimisticLockingFailureException` 族。见证：
  `ManagedSessionGuardMappingTest`。
- **CSI 钉住环的另一个牺牲者未具名。** 钉住 Session 的续接先取根行再取租
  户守卫（D1 让普通 Session 不碰守卫，所以它无法先取守卫），而该 Session
  上的其他车道——包括 retention 读与各 collector——先取守卫再取根行。
  InnoDB 可能回滚任一方。续接一侧的等待原本就已具名；现在守卫之后的根行等
  待（`lockSessionRoot`、遗留的 `isPrivate` 探测）遇到 1213 也具名为
  `tenant_guard_contended`，按厂商错误码识别，因此两种翻译器的形态都能匹
  配。曾尝试改为让 retention 一侧根行优先，但被否决：publication、生命周期
  授权与 writer 获取在每个 Session 上都先取租户 CAS 行再取根行，这样会在普
  通 Session 上也形成环。见证：
  `ToolPublicationLockOrderMySqlIT#pinnedSessionDeadlockNamesTheRetentionVictim`
  与 `#ordinaryPublicationBesideARetentionOwnerDoesNotDeadlock`。各 collector
  的候选查询已排除钉住 Session，因此实际上这个环的 retention 一侧是请求路
  径上的 retention 读。
- **`requireIdleJournal` 会拒绝合法准入**：外层事务的快照早于 head 锁时
  （见上文 D3，已修正）。
- **客户端争用预算。** 守卫重试在 commit 的共享争用截止时间内运行，但一次
  调用的首个尝试保有自己的请求预算，因此在停顿或较早的争用拒绝之后赢得的
  重启不会一发出就已过期。争用拒绝之后的截止 abort 保留守卫自己的名字，并
  报告共享预算已耗尽，从而停止外层重启；publication commit 车道与事务车道
  走同一个重试引擎。

## 后续（不在本次改动）

- 生命周期恢复事务的守卫窗口压界（`recoverEffects`/`saveEffects`/
  `verifyCompletion` 的快照复核化）。
- 给 `ManagedAgentStore` 中其余对 placement 行的获取加界或限定范围
  （无超时的 `WorkspaceMigrationAdmission.lockTenant` 与
  `WorkspaceLifecycleStore.lockPlacement`）：Session 创建与子 Session、重命
  名、变更、close/archive/delete 准入、cwd 变更与任务取消操作。它们都不是
  逐轮路径；被长持有时每一处仍会等满 `innodb_lock_wait_timeout`。
- 物化器 gap 绊线熔断（审计 §B2；毒化的 consumer progress 标死而不是
  10 Hz 永久异常）。
- 续期调度器隔离基线（复现假设 H2）——当前未决；rig 证据若指向它再
  议。
- 停在 `dispatch_started` 的 `child_run` 记录（按 #13800 自身范围口径
  另案）。

## 未决问题

- 是否应额外为 store 连接池整池下调 `innodb_lock_wait_timeout`（不在
  本次范围；D2 的逐语句预算已达成有界形态，无需全局旋钮）。
