# Managed Session 流量的租户守卫耦合加界

[English](2026-10-11-managed-tenant-guard-wedge.md) | [简体中文](2026-10-11-managed-tenant-guard-wedge.zh-CN.md)

- 状态：提案
- Issue：[#13800](https://github.com/QwenLM/qwen-code/issues/13800)——一个处于
  `recovery_blocked` 的 Session 楔死同 daemon 上其他 Session 的后续轮次
- 相关：验收报告 `docs/verification/13532-linux-h3/README.md`（发现 A2）、
  复现报告 `.qwen/issues/issue-13800.md`（不随仓库提交）。

## 问题

在 managed-agent 链路（MariaDB → managed-agent-server → hosted-harness
daemon → runtime worker）上，一个被标记为 `recovery_blocked` 的 Session
与无关 Session 的冻结存在相关性：受害 Session 的 journal 停在
`hostedModelAttempt` 之后，模型端点不再收到请求，回合从此不再结束。物理
验收环境中清掉存储行后行为恢复。验收报告只记录了相关性，没有机制；
issue 的工作项 W1（隔离机制）与 W2（限定影响半径）即本设计的实现内容。

## 机制（W1）

Managed Session store 在**每一个** Session 的热写路径上无条件地取两个
per-tenant InnoDB record lock：

1. `qwen_runtime_placement_guard`（每租户一行），经
   `WorkspaceLifecycleStore.lockPlacement` 与
   `WorkspaceMigrationAdmission.lockTenant` 进入
   `JdbcRuntimeBindingRepository.lockPlacementDomain`。
2. `qwen_tool_publication_tenant`（每租户一行），经
   `ToolPublicationRetentionStore.lockTenant`。

`ManagedSessionStore` 当前的调用矩阵：

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
**不做任何校验**——它只是取两把锁。任何事务把其中一行持有得比 harness
客户端 30 秒请求超时更久，其后到达的同租户其他 Session 的下一次 store
调用都会被冻结，因为：

- InnoDB 锁等待（默认 50 秒）大于客户端超时（30 秒）；
- 每次超时调用会被重试，重试到达时服务端语句可能仍在排队，客户端等待
  与服务端等待叠加；
- 失败的 `acquireWriter` 可能留下已插入但未被接管的头行，同会话 ID 的
  后续创建在死写者租约到期前一律收到 `409
managed_session_writer_conflict`。

### 复现（W1 证据）

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

物理 rig 上那次具体的长期持有者未被钉出——rig 没有留下 InnoDB 锁证据，
复现也刻意不去猜。已被证明的缺陷是耦合本身：**租户级锁绝不能给它不属
于的会话的逐轮 store 流量设卡。** 任何长持有——无论由什么产出——都必须
让其他会话的回合要么完成，要么带具名原因快速失败。

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

- W1-G1：当 daemon 所在租户内有一个 `recovery_blocked` 会话且生命周期/
  恢复工作仍在持续推进时，全新会话的普通回合**仍能完成**——普通流量不
  再在它不需要的租户级守卫行后排队。（issue W2 验收。）
- W1-G2：热路径真正需要的守卫争用超过短预算时，调用**快速具名失败**
  而不是 30 秒客户端超时；原因对调用方可见，对回合则模型可见，而非静
  默冻结。（issue W2。）
- W1-G3：持守卫事务不再跨无界工作持行；最重持有者改为无锁快照 + 短
  复核。
- W1-G4：一条见证集成测试钉住该几何：耦合恢复时红、改动后绿。

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
   `acquireWriter` 不再经它取两道守卫。per-session 栅栏保留：head 行
   `FOR UPDATE` 串行化单会话写者；drain 行栅栏
   （`requireOrdinaryAdmission`、`lifecycleFenced`、
   `lifecycleProtocolFenced`）维持 ordinary-vs-lifecycle 隔离。
2. `authorizeOrdinary` 去掉其显式两道守卫；准入仍由
   `requireOrdinaryAdmission`（drain 行）+ head 行治理。
3. `findHeadForUpdate`/`requireHeadForUpdate` 不再经 `lockSessionHead`
   （它拖着 `lockTenant`），直接锁 head 行，并保留 `requireLive`。
   `lockSessionHead`/`lockTenant` 留给 publication 域属主（publish、
   receipts、retire、retention）。
4. `blockRecovery` 形状不变，只失去继承来的 tenant 行。

准入路径保留项：`authorizeLifecycle`（claim 协议）、`acquireWriter` 的
migration 准入（`sessionAdmission`）**及其 publication tenant CAS 行**
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
  具名错误而非 30 秒冻结。`innodb_lock_wait_timeout`（50 秒）不再先于
  客户端（30 秒）引爆。

### D3. 已知无界持有者的重构

- `requireIdleJournal`（`WorkspaceLifecycleStore`）：摘掉 journal 级
  `FOR UPDATE` 扫描。已有的 head 行 `FOR UPDATE` 先取——每个写者都只在
  它之后追加 revision——所以按序读过半不会被并发提交插入，扫描本身一
  致；head 行维持为 idle 检查的唯一序列化点。
- 生命周期恢复事务（`recoverEffects`/`saveEffects`）本次不动；D1 之后
  同租户普通流量已不再在这些守卫后面排队，其窗口压界列为后续。

### D4. Harness 侧契约（W2，TypeScript）

当一回合内 store 重试被 transport/5xx 失败耗尽时，回合必须以具名原因
结束而不是 journal 冻结：

- `packages/cli/src/serve/hosted-harness-session.ts`：在 prompt 路由的
  落定路径里，store 不可用类失败以 `turn_result` `state: 'error'` 落定，
  `stopReason: 'managed_session_store_unavailable'`（SSE/stderr 文案同
  码）。若 `turn_result` 自身也无法提交（写路径已闭锁），daemon 在内存
  保留该具名失败并经由 `/session/:id/status` 反映
  （`recoveryBlocked` 保持 per-session；既有行为是置
  `session.blocked`）。
- store 客户端超时/重试预算不变；D2 让这些预算重新有意义。

### D5. 见证集成测试（W1 验收）

在 `managed-agent-server` 新增 MariaDB 集成测试
`ManagedSessionGuardConvoyIT`（沿用既有 `*MySqlIT` 夹具族）：

1. 同租户建两个会话，一个标成 `recovery_blocked`（头行 UPDATE，对齐复
   现夹具手法）。
2. 另开一个外部 JDBC 事务持两行（`UPDATE ... WHERE tenant_id = ?`）。
3. **见证断言**：持锁期间，另一会话的 `acquireWriter`（migration 准入
   情形）在约守卫预算内以具名错误失败，而 `renewWriter`、`commit`、
   `authorizeOrdinary`、`blockRecovery`（D1 断耦情形）全部正常完成；被
   卡行的 `recovery_status` 不变。
4. 释放持有；先前具名失败的操作重试成功。
5. 变异反证：恢复 `checkLifecycleWriter` 的无条件获取后 D1 情形重新被
   拖死（测试夹具由此硬编码预期调用矩阵）。

`requireIdleJournal` 重构由补断言覆盖：外部持守卫时对 head 未被外部持
有的会话，idle 检查仍可完成。

## 风险与缓解

- **R1——migration 准入回归（D1 不动它，D2 给它加界）。**
  `acquireWriter` 保留 `sessionAdmission` 的 placement guard；5 秒预算
  只会把曾经的冻结竞态变成具名 503。迁移 IT 必须全绿
  （`WorkspaceLifecycleMySqlIT` 族）。
- **R2——生命周期协议栅栏。** 生命周期签发写者保留全套锁与 claim 检查；
  `authorizeLifecycle` 语义不变。既有生命周期套件加见证的生命周期臂覆
  盖。
- **R3——publication 域顺序。** D1 保留 publication 路径的显式
  `lockTenant`；见证断言 publication commit 路径不受影响
  （`ToolPublicationStoreTest` 族必须全绿；publication commit 经
  `publicationRequest` → `ToolPublicationStore` 自有锁）。
- **R4——`requireIdleJournal` 无锁读会看到过期的未决集合。** 以 head 锁下
  的 head-revision 复核缓解；不一致则失败闭（blocked，不放行）。
- **R5——MySQL/MariaDB 方言。** 有界获取走 Connector/J 语句超时，不用
  `NOWAIT`/厂商子句；CI 的 MySQL 车道与 production MariaDB 路径都成
  立。
- **R6——病理持续持有下的行为。** 持有超过重试预算仍无法完成（不删行任
  何设计都做不到）；本设计交付的契约是：瞬时争用 ⇒ 完成；持续争用 ⇒
  快速具名失败，永无静默冻结，且永不让某会话的行给它不属于的会话设
  卡（D1）。

## 验证计划

1. `managed-agent-server` 与 `runtime-broker` 的单元/集成套件（Maven、
   JDK 21）：生命周期、publication、迁移、凭据、store binding 套件必须
   全绿（两模块 `mvn verify`）。
2. 新见证 `ManagedSessionGuardConvoyIT` 在 MySQL 车道运行。
3. TypeScript：`packages/core` 的 HTTP 会话存储既有测试、`packages/cli`
   hosted-harness 套件；为具名落定路径新增单测。
4. 以复现脚本（`.qwen/issues/13800-repro/` 保留）重跑 E2E：守卫持有变
   体现在只产出快速具名失败或正常回合，不再出现 30 秒冻结。
5. #13532 的物理 rig 复验仍是独立后续；W2 验收由见证 + E2E 在本地示
   证。

## 验收标准

1. `ManagedSessionGuardConvoyIT` 绿；回退 D1 调用点后转红（开发期变异
   验证）。
2. managed-agent 全部既有 Java 套件绿（生命周期/publication/迁移各
   条车道语义无漂移）。
3. 复现 E2E 的守卫持有变体下，全新会话的创建与回合不再冻结；持续持
   有下出现的失败一律带具名码。
4. `recovery_blocked` 标记的表述仍准确：被卡会话继续准确报告自身阻
   塞状态（见证步骤 3 的断言）。

## 后续（不在本次改动）

- 生命周期恢复事务的守卫窗口压界（`recoverEffects`/`saveEffects`/
  `verifyCompletion` 的快照复核化）。
- 物化器 gap 绊线熔断（审计 §B2；毒化的 consumer progress 标死而不是
  10 Hz 永久异常）。
- 续期调度器隔离基线（复现假设 H2）——当前未决；rig 证据若指向它再
  议。
- 停在 `dispatch_started` 的 `child_run` 记录（按 #13800 自身范围口径
  另案）。

## 未决问题

- 是否应额外为 store 连接池整池下调 `innodb_lock_wait_timeout`（不在
  本次范围；D2 的逐语句预算已达成有界形态，无需全局旋钮）。
