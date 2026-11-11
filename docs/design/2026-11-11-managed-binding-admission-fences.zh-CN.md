# Managed 绑定 admission 与 fence 抽取

[English](2026-11-11-managed-binding-admission-fences.md) | [简体中文](2026-11-11-managed-binding-admission-fences.zh-CN.md)

## 状态与范围

- 状态：已实现；仅行为保持的抽取与调用点迁移。落在已 merge 的 broker 门面分解（[#16922](https://github.com/QwenLM/qwen-code/pull/16922)）之上，本切片再次下调其全局上限。
- 日期：2026-11-11
- 范围：`packages/managed-agent-server` — `persistence` 模块（`runtimebroker.persistence`），并对共享 fence 词汇的其他 persistence 包做机械式调用点迁移。
- 脉络：延续[结构评审](2026-10-31-managed-agent-structure-review.md) P1 与[类尺寸棘轮](2026-11-04-managed-agent-class-size-ratchet.md)纪律，采用[ store 分解](2026-11-02-managed-store-decomposition.md)模式（门面加共享连接的协作类），最近一次应用是 [broker 门面分解](2026-11-11-managed-broker-facade-decomposition.md)。

## 问题

`JdbcRuntimeBindingRepository` 有 2,662 行；broker 门面分解把全局上限降到 2,662 后，它成为种下 `GLOBAL_MAX_LINES` 的类。只有当它缩到下一个最大 pin（`ToolPublicationDataStore`，2,574）以下，棘轮才能再次下调。

该仓库在绑定 CRUD、CAS 与租约操作之外累积了两个关注点：

1. Harness admission/fence **引擎**：收 `Connection` 的 SQL，判定新工作、恢复、清理、hook 控制或生命周期能否针对某个 Harness Session head 推进，包括 `HarnessFence` enum、方言相关的锁子句，以及 storage admission 检查。
2. 共享 fence **词汇**：public static 的 key 与生命周期 helper（`harnessDrainKey`、`storageFenceKey`、`storageAliasKey`、`beginHarnessLifecycle`、`hasSharedRuntimeSessions`），persistence 模块其余部分早已把它们当作公共 SQL 词汇调用。

两者都是 static、收连接、内聚的；都不需要仓库的绑定状态。

## 现状

admission/fence 方法遵循同一形状：仓库上的 public 接口方法经 `JdbcRepositorySupport.transaction(dataSource, ...)` 持有事务，并委托给一个收 `Connection` 的 static 核心。核心承载 SQL、`HarnessFence` 集合、H2 `FOR UPDATE` / MySQL `FOR SHARE` 的 claim 锁，以及数据库时间的租约比较。私有的 `requireHarnessRecovery` 自开事务，先跑两个 head/operation SELECT，再委托给同一核心。

共享词汇已是 public static，且使用远超本仓库：

- `harnessDrainKey`：`JdbcCsiApplicationRetirement`、`JdbcCsiActivationAdmission`、`JdbcHarnessPlacementStore`、`AgentLifecycleOperations`、`JdbcWorkspaceLifecycleStore`、`JournalFencing`、`WorkspaceCsiApplicationHistoryImage` 等。
- `storageFenceKey`：`JdbcSshWorkspaceStore`、`WorkspaceStorageGuard`、`ExternalStorageRegistrationStore`、`WorkspaceMigrationStore`、`WorkspaceCsiReservationStore`、`WorkspaceCsiApplicationInventory` 等。
- `storageAliasKey`：`ExecutionAdmissionPlacement`、`JdbcCsiReadyAdmission`、`JdbcCsiRetirementSeal`、`AgentSessionPolicies`、`JdbcCsiApplicationProgress`、`WorkspaceMigrationAdmission`、`LocalStorageOwners` 等。
- `beginHarnessLifecycle`：`AgentLifecycleOperations`。
- `hasSharedRuntimeSessions`：`JdbcWorkspaceLifecycleStore`。
- static `requireHarnessAdmission(Connection, ...)`：`WorkspaceCsiRuntimeAccess`。

接口方法（`requireHarnessAdmission`、`requireHarnessRecovery`、`requireHarnessCleanup`、`requireHookAdmission`、`requestHarnessDrain`、`isHarnessDraining`、`requestStorageFence`、`isStorageFenced`）声明在 `contracts` 的 `RuntimeBindingRepository` 上，由 JDBC 与内存两个仓库实现；`runtime-broker` 的调用方经接口消费。

## 提议方案

在 `runtimebroker.persistence` 抽出协作类 `RuntimeAdmissionFences`，持有收 `Connection` 的 static 引擎与共享 fence 词汇。仓库保留事务所有权、接口包装，以及绑定 CRUD/CAS/租约核心。

该类是 `public final` 加私有构造器，而非包私有：约三十五个调用方位于 `managedagent.persistence` 及 `runtimebroker.persistence` 之外的 verification 测试包，包私有类无法跨包 import。只有六个本就 public 的词汇成员是 public；整个引擎面保持包私有。这与同包既有的 public 协作类（`JdbcCsiReadyAdmission`、`JdbcCsiActivationAdmission`）一致；ArchUnit 无可见性规则。

### 搬移内容

- `HarnessFence` enum 与 `fence(...)`。
- static `requireHarnessAdmission(Connection, ...)` 核心及其 public 重载、`requireStorageAdmission`、`requireResidentWorkspaceAdmission`、`requirePhysicalStorageAdmission`、`hasHarnessDrain`、`storageFence`、`localStorageOwnerKey`（两个重载）、`unverifiedWorkspaceHolder`、`admissionClosed`，以及 `requireHarnessRecovery` 的 SQL 体（作为一个收 `Connection` 的方法）。
- 共享词汇：`harnessDrainKey`、`storageFenceKey`、`storageAliasKey`、`beginHarnessLifecycle`、`hasSharedRuntimeSessions`。

每个方法体逐字搬移，包括方言锁子句、`JdbcRepositorySupport` 调用、数据库时间比较和 SQL 字符串。

### 保留内容

- 接口包装：继续经 `JdbcRepositorySupport.transaction(dataSource, ...)` 持有事务并委托给协作类。`requireHarnessRecovery` 保留其事务包装，委托其 SQL 体。
- 绑定 CRUD、`findOrCreate`、`compareAndSet`、claim/renew/release 操作、session 释放操作（`beginSessionRelease`、`completeSessionRelease`、`completeStoppedSessionRelease`）、session/execution 准入，以及查询方法。
- 内存仓库：不经 SQL 实现接口，保持不变。

### 调用点迁移

共享词汇的调用方在同一变更里把 import 与限定名切换到 `RuntimeAdmissionFences`。这是对 81 个调用方文件（38 个生产、43 个 verification 测试）的机械迁移，每处一到三行；没有调用改变其参数、事务或顺序。首发前采用硬切，仓库上不留废弃桥接，与 P0 决策一致。

仓库内部经 static import 引用搬移成员，使约四十处仓库内调用点文本不变。唯一例外是 `requireHarnessAdmission`：成员方法会完全遮蔽同名的 single-static-import（JLS 15.12.1），而接口包装必须保留该名，故十三处收 `Connection` 的调用点改用限定名 `RuntimeAdmissionFences.requireHarnessAdmission(...)`。两个被 pin 的调用方（`JournalCommit`、`WorkspaceRecoveryStore`）用全限定引用而非新 import，因为新 import 会使各超棘轮 pin 恰好一行；引用变更使其保持 pin 尺寸。迁移还移除一个既有的未用 import（`JdbcCsiExecutionAdmission` 中的 `CsiFilesRetirementProfile`，上游已孤立），broker Checkstyle 规则集会标记它；移除是行为中性的。

## 设计决策与理由

- **协作类不持有事务。** 其方法收 `Connection`，在调用方的事务内运行，与今天的 static 核心完全一致。事务与锁所有权留在仓库包装与既有调用方，故锁序与准入原子性不变。
- **一个协作类，而非两个。** key 词汇与 SQL 引擎内聚（引擎消费 key）；拆开只会徒增一个没有缝的类。简单优先。
- **词汇随引擎一起搬。** 把广泛共享的 key 留在仓库上，会让一个意在成为绑定仓库的类继续持有 static 工具面，并迫使日后再做一次迁移。现在搬移把公共 SQL 词汇放进一个命名的家。
- **硬切优于桥接。** 首发前，模块门禁使每个调用方可枚举；桥接会让旧面存活并在迁移期翻倍。
- **public 类，包私有引擎。** 跨包调用方迫使类可见性为 public；只有共享词汇是 public，故引擎面留在 persistence 包内部。
- **限定被遮蔽的名。** `requireHarnessAdmission` 无法与同名接口包装一起 static import（JLS 15.12.1）；限定其收 `Connection` 的调用点是最小的正确选择，其余搬移成员都用 static import。

## 约束

- SQL、事务、并发与恢复语义不变：方言锁子句、数据库时间租约比较、fence 集合逻辑与每条 SQL 字符串按字节搬移。陈旧 owner 仍不得提交持久状态或释放更新 owner 的资源。
- `contracts` 接口与内存仓库不动；ArchUnit 模块边界原样通过。
- 类尺寸棘轮只降：仓库 pin 降到抽取后尺寸，新协作类若达 800 行则 pin，仓库低于 `ToolPublicationDataStore` pin 后 `GLOBAL_MAX_LINES` 从 2,662 降到 2,574。
- 两个 Checkstyle execution 都适用（`checkstyle:check` 与 `checkstyle:check@runtime-broker-checkstyle`）；后者用不同规则集，要求文件尾 newline、闭括号前无空行。

## 风险

- **广度。** 迁移触及约二十个文件。缓解：每个调用点只改 import 与限定名；变更由 maintainer 发起，作为机械搬移而非行为变更来 review。
- **安全相关 SQL。** admission 核心把关租户隔离与生命周期围栏。缓解：逐字搬移、既有的 fence/admission MySQL 集成案例，以及 CI 的 Hosted/fault profile。
- **基线漂移。** 棘轮数字假设 #16922 已 merge 且采用上游当前 pin 基线。缓解：实现时像 broker 切片那样，对齐上游的 pin 与全局上限。

## 验证计划

- 本地（模块预算内）：broker service 与 binding 的 H2 套件，加上针对一次性 MySQL 8.4 选跑 `mysql-integration` 的 binding/fence 案例；两个 Checkstyle execution；上游基线树上的类尺寸棘轮。
- CI 持有完整 unit/H2 套件、SpotBugs、ArchUnit、完整 MySQL profile，以及 Hosted/fault-gate profile。触及 SQL 的抽取不接受仅凭 H2 证据。
- 在所需 CI 门关于接受修订上通过之前，接受状态为待定。

## 接受标准

- `JdbcRuntimeBindingRepository` 从 2,662 降到 2,319 行（低于 2,574）；其 pin 从 2,670 降到 2,319，`GLOBAL_MAX_LINES` 从 2,662 降到 2,574，在同一变更完成。`RuntimeAdmissionFences` 389 行，低于 800 行 pin 阈值，故不 pin。
- 每个搬移体逐字；接口、内存仓库与所有 SQL/事务/锁语义不变。
- 零 OpenAPI 与 schema diff；ArchUnit、两个 Checkstyle execution、SpotBugs 绿；完整 MySQL 与 Hosted/fault CI profile 在接受修订上绿。

## 后续

- 仓库剩余聚类（session 释放操作、绑定 CRUD/CAS/租约）若想进一步下调棘轮，是后续切片。
- 本切片后，`ToolPublicationDataStore`（2,574）成为下一个全局上限种子。
- 结构评审点名的 `QwenHostedHarnessConnector` 分解仍是独立的 adapters 切片，在本棘轮范围之外。
