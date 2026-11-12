# Managed Agent 第一档收敛（OSS 热路径、死代码、打包）

[English](2026-11-12-managed-agent-tier1-convergence.md) | [简体中文](2026-11-12-managed-agent-tier1-convergence.zh-CN.md)

状态：提议中；scope 已与 maintainer 确认。服务尚未投产，因此凡仅为保护既有部署
而存在的向后兼容约束一律去除。确认的 scope：去除 OSS 读路径 versioning 探针
（保留 put/delete 探针）；将通用对象存储自动装配从 tool publication 解耦；删除死
K1 provisioner；修复 `sessionWorktreeScheduler` 默认候选；在各 managed MySQL 池
统一应用 strict session mode；并把分发收敛为单一可执行 jar。环境变量方言统一不在
范围内。

## 问题

对 `packages/managed-agent-server` 的全模块架构评审提出了一档「高收益、低风险」
收敛项。针对当前代码树的源码级核实纠正了若干被夸大的建议（见现状）。本设计记录
核实后的状态与有界改动集，并按「无既有部署需保护的 pre-production 服务」加以精简。

范围内的三项：

1. 去除 OSS 热路径多余 RPC，并将通用对象存储自动装配从 `tool-publication.enabled`
   解耦。
2. 死代码清理、`sessionWorktreeScheduler` 默认候选修复，以及在各分裂的
   `DruidDataSource` 工厂间统一 strict-mode 默认值。
3. 打包收敛：用单一可执行 jar 取代七个重打包 fat jar，由既有统一 admin 启动器分发。

## 现状（已核实）

### OSS 对象存储

`adapters/.../artifact/AliyunToolPublicationObjectStore.java`：

- 构造器调用 `validateConfiguration()`（一次 `getBucketVersioning` 往返）与
  `getBucketAcl`（私有 bucket 检查）。
- `putIfAbsent`、`deleteIfPresent`、`open(key, guard)`、`openRange` 每次都再调用
  `validateConfiguration(guard)`，每个操作额外增加一次 `getBucketVersioning` 往返。
- `validateConfiguration()` 是 SPI 接口
  `contracts/.../artifact/ToolPublicationObjectStore.java` 上的方法，有两处活的
  生产调用点：`ToolPublicationDataStore.verify()`（异步发布校验）与
  `ToolPublicationCollector.runOnce()`（页级 GC 探针，仅当页携带物理 key 时）。

约束：

- `verification/.../artifact/AliyunToolPublicationObjectStoreTest`
  `deletionRejectsVersioningEnabledAfterConstruction` 锁定：构造之后，若 bucket
  版本控制变为 `Enabled`/`Suspended`，`deleteIfPresent` 必须在调用 `deleteObject`
  之前拒绝。这是数据擦除正确性不变量，而非兼容产物：在版本控制 bucket 上删除会
  创建删除标记，而非物理移除对象。`docs/design/managed-tool-output-retention.md`
  与 `docs/design/2026-09-27-managed-tool-result-hosted-delivery.md` 记录了同一
  要求（后者因为 `x-oss-forbid-overwrite` 在这两种状态均不生效）。
- `verification/.../AliyunToolPublicationObjectStoreTest`（根包）
  `retriesTransientGetAndRechecksTheOriginalGuard` 断言一次重试读取中 guard 执行
  三次：versioning 探针前一次、两次 `getObject` 尝试前各一次。去除读探针后该计数
  变为两次。
- `verification/.../persistence/O4OssGate.java` 委托真实 store，不计数探针；其
  受限身份跳过 `validateConfiguration`，因为探针本身即一次存储操作。保留删除探针
  可保住其断言的 `ACCESS_DENIED` 语义。

### 对象存储自动装配

- `server/.../config/AliyunToolPublicationStorageAutoConfiguration.java` 原门控于
  `qwen.managed-agent.tool-publication.enabled=true`、
  `@ConditionalOnBean(ToolPublicationConfiguration.class)` 与
  `@ConditionalOnMissingBean(ToolPublicationObjectStore.class)`。它定义
  `toolPublicationOss` 客户端 bean 与 `toolPublicationObjects` store bean。
- `server/.../config/ToolPublicationConfiguration.java`（发布服务）门控于同一个
  `tool-publication.enabled` 属性。
- 非发布类消费方——`JdbcSessionResourceObjects`、`JournalPackTransactions`、
  `JdbcManagedSessionStore`、`WorkspaceRecoveryStore`/`WorkspaceRecoveryReader`、
  各 `WorkspaceCsi*` store——经 `ObjectProvider`/`@Nullable` 获取 store，缺 bean
  时 fail-closed（HTTP 501 `managed_session_oss_disabled`）。因此此前启用
  `session-resources` OSS 存储必须连带启用 `tool-publication.enabled`，纯粹为了
  拿到 store bean。
- `verification/.../config/ToolPublicationStorageConfigurationTest` 锁定门控；其
  `ApplicationContextRunner` 不加载 `application.yml`。
- `application.yml` 已对 `session-store.enabled` 使用嵌套占位符默认值（跟随
  `harness.enabled`），这是一个功能开关跟随另一个的既有模式。
- OSS 连接配置（`oss-endpoint`、`oss-region`、`oss-bucket`）位于
  `tool-publication.*` 下（经环境变量绑定）；`AliyunObjectStoreClient` 通过
  `ManagedAgentSettings.getToolPublication()` 读取。

### 死代码与配置

- `runtime-kubernetes/.../KubernetesRuntimeProvisioner.java`（K1 切片，kind
  `kubernetes`）在生产中是死代码。该模块的
  `META-INF/services/...RuntimeProviderFactory` 只注册
  `KubernetesRuntimeProviderFactory`，其 `kinds()` 仅返回 `kubernetes-workspace`。
  `RuntimeProviderRegistry` 保留并拒绝 `kubernetes` kind。对 K1 类的引用仅有两处
  K1 测试（`KubernetesRuntimeProvisionerTest`、`KubernetesRuntimeWorkerTest`）、
  仅 K1 测试使用的 fixture `FakeKubernetesRuntimeClient`，以及
  `docs/runtime-broker.md`。**`KubernetesRuntimeClient` SPI 接口是活的**
  （`WorkspaceCsiResourceGuard`、`WorkspaceCsiRuntimeProvisioner`，以及
  `KubernetesMaintenanceClient extends KubernetesRuntimeClient`）；必须保留。
- `ManagedAgentProperties`（`applySessionStoreDefaults`）与 `EmbeddedRuntimeBroker`
  （`resolveWorkspaceCwd`/`resolveWorkspaceId`）中的 `"kubernetes"` 析取项因 kind
  被拒绝而不可达，但无害。`RuntimeProviderRegistry` 中的保留守卫是活的且文档化。
  `HarnessConfiguration` 与 `HarnessPoolConnector` 中的 `"kubernetes"` 字符串是
  Harness pool discovery 模式，与 Runtime provisioner 无关。
- **`JdbcRuntimeBrokerSchema` 不可删除。** 它在 `src/main` 零调用，但被 13+ 个
  verification 测试类用作 schema 初始化器，并在 `docs/runtime-broker.md` 中被
  文档化为 Broker schema 入口。评审「生产未使用，删除」的结论不正确。
- `ManagedArtifactConfiguration.sessionWorktreeScheduler` 是该类中唯一缺少
  `defaultCandidate = false` 的调度器 bean。模块内全部 24 个 `@Scheduled` 方法都
  指定了显式 `scheduler=` 限定符；没有一个依赖默认候选解析。在嵌入模式下，缺失该
  标注会让这个单线程 worktree 池成为宿主应用的默认 `TaskScheduler`。
- 四个 `DruidDataSource` 构建器此前不一致：
  - `ManagedAgentServerApplication.standaloneDataSource`：绑定
    `spring.datasource` + `spring.datasource.druid`，调用
    `MySqlStatementCache.fillDefaults`，未设置 `STRICT_TRANS_TABLES`。
  - `ManagedAgentPersistenceConfiguration.managedAgentDataSource`（嵌入）：读取
    `qwen.managed-agent.datasource.*`，为 MySQL/MariaDB 设置 `STRICT_TRANS_TABLES`
    connection-init SQL，调用 `fillDefaults`。
  - `WorkspaceRecoveryApplication.dataSource`：经 `@ConfigurationProperties`
    （bean 方法返回后）绑定 `spring.datasource` 与 `spring.datasource.druid`，
    跳过 `fillDefaults` 与 `STRICT_TRANS_TABLES`。
  - `ManagedLocalConfiguration.managedLocalDataSource`：H2 专用（`managed-local`
    profile），刻意不同。
    嵌入与 standalone 的属性前缀差异是刻意的：嵌入宿主自有其 `spring.datasource`。
    `STRICT_TRANS_TABLES` 的分裂此前在 `README.md` 中被记录为调用方责任；
    pre-production 下，该文档被更新为单一统一规则，而非作为约束保留。

### 打包与运维入口

- 统一 admin 启动器**已存在**：`bin/qwen-managed-agent-admin`（PR #15772，
  `docs/design/2026-10-23-managed-agent-admin-launcher.md`）通过 Spring Boot
  `PropertiesLauncher` 从可执行 server jar 分发全部维护命令，含 `operator-recovery`
  （`maintenance.WorkspaceRecoveryCommand`）。评审「改为统一 CLI 子命令分发」的
  建议已实现。
- 该设计曾把删除 classified jar 记录为延期 follow-up、把保留 operator-recovery
  jar 与启动器记录为 non-goal——两者都为保护既有分发。pre-production 无既有分发，
  故本批删除全部 classified jar 与专用 operator-recovery 启动器。
- `server/pom.xml` 定义了七个 `spring-boot-maven-plugin:repackage` execution
  （`exec` 加六个运维工具）与七个 `maven-jar-plugin` classifier execution，由
  `managed.operator-tools.skip/attach/jar.phase` 管理（默认 `false`/`true`/`package`；
  `no-operator-tools` 与 `central-release` profile 跳过它们）。
- `scripts/package-managed-agent-reference.mjs` 当前分发两个 jar：`exec` jar
  （作 `lib/<server jar>`）与 `operator-recovery` jar，并有专用
  `bin/qwen-managed-agent-operator-recovery` 启动器。容器只选择 `exec` classifier
  （`ContainerArtifactSelectionTest`）。`operator-recovery` 启动器与
  `bin/qwen-managed-agent-admin operator-recovery` 功能冗余——后者从 `exec` jar
  运行同一个 main 类。
- 指名 classified jar 的消费方：`README.md`（workspace-migration 私有制品）、
  `docs/design/2026-10-01-managed-workspace-w1b-bundle.md`（workspace-bundle
  制品）、`docs/users/hosted-workspace-recovery.md` 与配置参考（operator-recovery
  启动器）、E2E 元测试 `scripts/tests/managed-agent-server-e2e.test.js`、
  `scripts/tests/package-managed-agent-reference.test.mjs`，以及
  `scripts/run-managed-agent-server-e2e.ts`。
- admin-launcher 设计明确决定「它不做任何环境变量映射。每个入口继续读取自己的
  凭据」：Workspace 命令读 `W1_JDBC_*`，CSI 命令读 `K2_JDBC_*`，
  `operator-recovery` 与 `resident-retirement` 读 `SPRING_DATASOURCE_*`。这些方言
  在 E2E 脚本、MySQL 集成测试与部署文档中承重。
- `WorkspaceCsiHostedMain` **不是**死代码：它是被 `WorkspaceCsiRuntimeMain` 调用
  的 package-private helper，并有自己的测试。

## 目标

- 去除 OSS 读热路径上冗余的每读 `getBucketVersioning` 往返，且不弱化任何存储安全
  不变量。
- 让非发布功能（session resources、journal packs、CSI 恢复）无需启用 tool
  publication 即可获得通用对象存储。
- 删除真正死掉的 K1 provisioner 及其仅测试用 fixture；修复
  `sessionWorktreeScheduler` 默认候选 bug；在各 managed MySQL 池统一应用 strict
  session mode 与语句缓存。
- 把模块构建与分发收敛为单一可执行 jar，经 admin 启动器分发每个维护命令（含
  operator-recovery）。

## 非目标

- 去除 `putIfAbsent` 或 `deleteIfPresent` 的每调用探针（正确性不变量：漂移后的
  版本控制 bucket 上拒绝 forbid-overwrite 与物理删除；由删除回归测试锁定）。
- 删除 `validateConfiguration()` SPI 方法或其两处显式生产调用点。
- 删除 `JdbcRuntimeBrokerSchema`（仅测试用但承重；搬去 verification 是另行决策）。
- 删除 `kubernetes` 保留守卫，或触碰无关的 Harness pool-discovery `"kubernetes"`
  字符串。
- 将 `W1_JDBC_*` / `K2_JDBC_*` / `SPRING_DATASOURCE_*` 统一为单一方言（admin-launcher
  的刻意设计决策；方言在 E2E、集成测试与运维文档中承重）。
- 收敛 16 个调度器池或六个协调器租约循环（评审的第二档结构性工作，每个调度器的
  Javadoc 都记录了刻意的隔离理由）。

## 提议方案

### 1a. 读路径探针去除

在 `AliyunToolPublicationObjectStore` 中，从 `open(key, guard)` 与 `openRange`
移除 `validateConfiguration(guard)` 调用。保留构造器、`putIfAbsent`、
`deleteIfPresent` 中的调用，并保留公共 `validateConfiguration()` SPI 方法及其
`ToolPublicationDataStore.verify()` / `ToolPublicationCollector.runOnce()` 调用点
不变。

guarded read loop 仍在每次 `getObject` 尝试与重试前运行 guard，因此接口契约
「在每次新存储请求（含实现重试）前检查授权」得以保留。更新
`retriesTransientGetAndRechecksTheOriginalGuard`，期望两次 guard 运行而非三次。
`deletionRejectsVersioningEnabledAfterConstruction` 与所有请求计数测试保持绿。
构造后版本控制漂移的 bucket 上的读取，在下一次校验、GC 页或删除时被发现；每次
外部读取仍校验长度与 SHA-256 并在不匹配时 fail-closed。

### 1b. 对象存储自动装配解耦

新增中性开关 `qwen.managed-agent.object-storage.enabled`：

- 在 `ManagedAgentProperties` 中新增 `ObjectStorage` 嵌套类（布尔 `enabled`，
  默认 false）。
- 在 `application.yml` 中：
  `object-storage.enabled: '${QWEN_MANAGED_AGENT_OBJECT_STORAGE_ENABLED:${qwen.managed-agent.tool-publication.enabled:false}}'`，
  复用既有 `session-store.enabled` 跟随 `harness.enabled` 的模式。仅
  session-resources 的部署设置 `object-storage.enabled=true` 且
  `tool-publication.enabled=false`。

将 `AliyunToolPublicationStorageAutoConfiguration` 门控改为
`@ConditionalOnProperty(prefix = "qwen.managed-agent.object-storage", name = "enabled", havingValue = "true")`
加既有 `@ConditionalOnMissingBean(ToolPublicationObjectStore.class)`。移除
`tool-publication.enabled` 条件与 `@ConditionalOnBean(ToolPublicationConfiguration.class)`
条件。保留类名与 `toolPublicationOss` / `toolPublicationObjects` bean 名（被
`HostedGateTestSupport`、`HostedShellLifecycleFixtureMain` 与配置测试引用）；重命名
是可选 follow-up。

OSS 连接配置仍留 `tool-publication.oss-*`；无属性迁移。
`ToolPublicationConfiguration` 保留其 `tool-publication.enabled` 门控及其必需的
`ToolPublicationObjectStore` 构造器参数，因此启用发布但无 store 仍在启动时
fail-closed。

更新 `ToolPublicationStorageConfigurationTest`：`ApplicationContextRunner` 不加载
`application.yml`，故每个触发自动装配的用例都显式设 `object-storage.enabled=true`。
原 `maintenanceContextsDoNotInitializePublicationStorage` 用例改为
`genericStorageDoesNotRequirePublicationConfiguration`：在 `object-storage.enabled=true`、
无 `ToolPublicationConfiguration` 且 tool publication 关闭时，通用 store 仍被创建
（且无发布 datastore），证明解耦。更新 README「Tool publication storage」节、
配置参考（新增 `object-storage` 节，双语）与 `configuration-descriptions.json`。

### 2a. K1 死代码删除

删除 `KubernetesRuntimeProvisioner.java`、`KubernetesRuntimeProvisionerTest`、
`KubernetesRuntimeWorkerTest` 与 `FakeKubernetesRuntimeClient`。更新
`docs/runtime-broker.md`，移除 K1 切片描述及其悬空引用。保留
`KubernetesRuntimeClient`、`KubernetesMaintenanceClient`、
`KubernetesHttpRuntimeClient`、`KubernetesRuntimeProviderFactory` 及 resident/CSI
provisioner。保留 `RuntimeProviderRegistry` 保留守卫。`ManagedAgentProperties` 与
`EmbeddedRuntimeBroker` 中不可达的 `"kubernetes"` 析取项维持原样（无害，受保留
守卫保护）。

### 2b. JdbcRuntimeBrokerSchema

不变。保留该类及其文档。将搬去 verification fixture 记录为另行未来决策，而非删除。

### 2c. sessionWorktreeScheduler 默认候选

在 `ManagedArtifactConfiguration` 的 `sessionWorktreeScheduler` bean 上添加
`defaultCandidate = false`，与该类其余每个调度器 bean 一致。没有 `@Scheduled`
方法依赖默认候选解析，故 standalone 行为不变，嵌入宿主不再继承 worktree 池作为
其默认调度器。

### 2d. 统一 managed MySQL 池默认值

新增 `ManagedDataSourceDefaults.applyMySqlDefaults(DruidDataSource)`：对
MySQL/MariaDB URL 设置 `STRICT_TRANS_TABLES` connection-init SQL（保留其他 session
mode）并调用 `MySqlStatementCache.fillDefaults`。在池的 URL 与连接属性绑定之后，
由 standalone、嵌入与 recovery 构建器调用。standalone 与 recovery 构建器保留既有
`maxActive`/`maxWait`/`validationQuery` 默认值与前缀绑定；recovery 构建器从
`@ConfigurationProperties("spring.datasource.druid")` 改为方法内 `Binder` 绑定
（与 standalone 一致），使默认值看到最终 URL 与连接属性。
`ManagedLocalConfiguration` 保持 H2 专用。

pre-production 下，strict mode 统一应用，而非留给 standalone 与维护调用方自行
配置：一条规则、无运维负担，且 schema 准入本就要求 strict mode。`README.md` 从
「嵌入池加 strict mode；standalone/维护调用方自行配置」更新为「每个 managed 池都
加 strict mode；自定义 DataSource 自行配置」。两处重复的 `maxWait`/`validationQuery`
setter 不抽入 helper（helper 是绑定后调用；那些默认值是绑定前、可覆盖的）。

### 3a. 单一可执行 jar

从 `server/pom.xml` 移除全部六个运维工具 `spring-boot-maven-plugin:repackage`
execution（`workspace-bundle`、`workspace-migration`、
`workspace-maintenance-recovery`、`csi-session`、`csi-runtime`、`operator-recovery`）
及其六个 `maven-jar-plugin` classifier execution，只留单个 `exec` repackage。
`managed.operator-tools.*` 属性与 `no-operator-tools`/`central-release` profile
不再需要，一并移除。

把分发收敛为一个 jar：

- `scripts/package-managed-agent-reference.mjs` 只分发 `exec` jar（作
  `lib/<server jar>`）；移除 `operator-recovery` jar 条目与专用
  `bin/qwen-managed-agent-operator-recovery` 启动器。每个维护命令（含
  `operator-recovery`）经 `bin/qwen-managed-agent-admin` 从 `exec` jar 运行
  （`operator-recovery` 命令已映射到 `WorkspaceRecoveryCommand`）。
- 更新打包元测试（`scripts/tests/package-managed-agent-reference.test.mjs`、
  `scripts/tests/managed-agent-server-e2e.test.js`）与
  `scripts/run-managed-agent-server-e2e.ts` 为单 jar 布局。
- `ContainerArtifactSelectionTest` 继续证明选择器选 `exec`。
- 更新 `docs/users/hosted-workspace-recovery.md`（双语）与配置参考
  `operator-recovery-enabled` 说明，改用 `bin/qwen-managed-agent-admin operator-recovery`；
  更新 `README.md`（workspace-migration）与
  `docs/design/2026-10-01-managed-workspace-w1b-bundle.md`（workspace-bundle）为
  可执行 jar；把 admin-launcher 设计的「删除 classified jar」follow-up 标记为已
  落实、其 operator-recovery non-goal 标记为被本 pre-production 改动取代。更新
  reference distribution 设计布局为单 jar。

### 3b. 环境变量方言

不变。`W1_JDBC_*`、`K2_JDBC_*` 与 `SPRING_DATASOURCE_*` 维持 admin-launcher 设计
与部署指南所记录的样子。

## 设计决策与理由

- **仅去读探针**：删除探针被一个安全回归测试与文档化擦除不变量锁定；put 探针保住
  forbid-overwrite 拒绝。读是高频路径且校验 digest，故去除其探针是无安全损失的纯
  性能收益。put/delete 探针是正确性而非兼容，即便 pre-production 也保留。
- **中性 object-storage 开关并默认跟随 `tool-publication.enabled`**：复用既有
  `application.yml` 模式并保住自定义 store 的失败模式；OSS 属性仍留
  `tool-publication.oss-*`（无迁移）。
- **保留 `JdbcRuntimeBrokerSchema`**：评审「生产未使用」仅对 `src/main` 成立；
  13+ 测试与模块文档依赖它。
- **保留 K1 保留守卫与活的 `KubernetesRuntimeClient` SPI**：只有未注册的 K1
  provisioner 及其仅测试用 fixture 是死的。
- **统一 strict mode**：pre-production 去掉了「让 standalone 与维护调用方自行配置
  strict mode」的理由；一条统一规则更简单，且与 schema 准入要求一致。README 相应
  更新，而非当作固定契约。
- **单一可执行 jar**：pre-production 去掉了保留 classified jar 或专用
  operator-recovery 启动器的理由；admin 启动器已从 exec jar 分发每个命令（含
  operator-recovery），故额外 jar 与启动器纯冗余。一个 jar、一个 repackage。
- **不统一环境变量方言**：admin-launcher 设计明确决定不做环境映射，且方言在 E2E、
  集成测试与运维文档中承重。

## 约束

- 保住 `ToolPublicationObjectStore` SPI 契约、每请求前 guard 的读取契约、私有/从未
  versioning bucket profile，以及无 store 配置时的 fail-closed 501 行为。
- 为每条触碰路由保住租户隔离、writer-lease/generation 围栏与持久化 SQL 准入
  （模块 AGENTS.md Code Review 规则）。
- 保住嵌入与 standalone 数据源前缀区分及 H2 `managed-local` profile。
- 保持每个 admin 启动器命令从单一可执行 jar 到达其入口，含 `operator-recovery`。
- 若出现任何 schema 触碰，就地编辑 V1 baseline；不新增 V2+ 迁移（模块 AGENTS.md）。
  本批预期无 schema 变更。
- 文档变更须保持双语版本完整且同步（docs/design/README.md）。

## 风险

- guard 计数测试更新不得弱化 guard-before-request 契约；它是机械计数变更，删除
  安全测试保持不动。
- 解耦改变存储配置测试：原 `maintenanceContextsDoNotInitializePublicationStorage`
  用例改为 `genericStorageDoesNotRequirePublicationConfiguration`；设
  `tool-publication.enabled=true` 的嵌入宿主现在即使无 `ToolPublicationConfiguration`
  也会获得通用存储（刻意）。
- 统一 strict mode 改变 standalone 与 recovery 行为（现在加 `STRICT_TRANS_TABLES`）。
  `StandaloneDataSourceConfigurationTest` 断言连接属性（语句缓存），不受影响，因为
  strict mode 走 `connectionInitSqls`；recovery H2 测试跳过 strict mode。确认两者
  仍通过。
- 单 jar 改动是模块构建与分发接口变更：从源码构建 classified jar 或使用专用
  operator-recovery 启动器的运维须切换到可执行 jar / admin 启动器。pre-production
  无此类部署；容器不变。触及运维面向文档与 E2E/元测试层。
- K1 删除不得移除活的 `KubernetesRuntimeClient` SPI 或保留守卫；全模块编译证明无
  悬空引用。

## 验证计划

本地验证遵循模块 AGENTS.md 预算（共享 10 分钟预算内的聚焦回归；完整门禁留在 CI）。
使用 JDK 21 / Maven 3.8.9+，将 sibling SDK 安装进任务隔离仓库，并通过 `mvn verify`
跑 Checkstyle（裸 `checkstyle:check` 对 runtime-broker execution 是假绿）。

- OSS：两个 `AliyunToolPublicationObjectStoreTest` 类、
  `ToolPublicationStorageConfigurationTest`、`ToolPublicationCollectorTest`、
  `ToolPublicationAsyncVerificationTest` 与发布校验测试；CI 中真实 OSS `O4OssGate`
  profile。
- 数据源：`StandaloneDataSourceConfigurationTest`、`WorkspaceRecoveryApplicationTest`、
  `MySqlStatementCacheTest`；CI 中 MySQL `ManagedDataSourceSqlModeMySqlIT`；
  `managed-local` H2 启动。
- 死代码：全模块编译（删除证明无悬空引用）；确认 `KubernetesRuntimeClient` 消费方
  仍编译。
- 打包：`scripts/tests/package-managed-agent-reference.test.mjs`、
  `scripts/tests/managed-agent-server-e2e.test.js`、`ManagedAgentPackagingIT`、
  `ContainerArtifactSelectionTest`，以及每个 admin 命令（含 `operator-recovery`）
  从单 jar 到达其入口的 reference-distribution E2E。
- 文档：每个更新文档的格式与相对链接/引用检查，双语。

分别报告本地通过、失败、跳过与 CI 缺口；在被接受修订上所需 CI 门禁通过之前，
acceptance 处于 pending。

## 验收标准

- `open`/`openRange` 不再发每调用 `getBucketVersioning`；`putIfAbsent`/
  `deleteIfPresent` 仍拒绝版本控制 bucket；删除回归测试绿；guard 计数测试期望两次。
- `object-storage.enabled=true` 且 `tool-publication.enabled=false` 产出 store bean
  且无发布 bean；现有 tool-publication 部署经跟随默认无需变更即可工作。
- K1 provisioner 及其仅测试用 fixture 已删除；全模块编译；`KubernetesRuntimeClient`
  SPI 与 `kubernetes` 保留守卫仍在。
- `sessionWorktreeScheduler` 具 `defaultCandidate = false`；无未限定 `@Scheduled`
  任务受影响。
- standalone、嵌入与 recovery 池都经 `ManagedDataSourceDefaults` 应用
  `STRICT_TRANS_TABLES` 与语句缓存；`managed-local` H2 与属性前缀区分不变；README
  陈述统一规则。
- 只构建并分发 `exec` jar；专用 operator-recovery 启动器已移除；每个 admin 命令
  （含 `operator-recovery`）从单 jar 到达其入口；文档与 E2E 消费方已迁移。
- 环境变量方言不变。

## 开放问题与 follow-up

- 可选：将 `AliyunToolPublicationStorageAutoConfiguration` 及其 bean 名重命名为
  中性 object-storage 名（触碰自动装配 imports、嵌入 `@Import`、hosted fixture 与
  配置测试）。
- 可选：将 `JdbcRuntimeBrokerSchema` 搬去 verification fixture。
- 可选：简化不可达的 `"kubernetes"` 析取项。
- 可选：OSS 连接属性改用中性 `object-storage.*` 前缀（当前 `tool-publication.oss-*`）；
  因 churn 大于收益而延期。
- 环境变量方言统一若将来需要，须另行提议，附迁移/兼容方案与 maintainer 签核。
- 相邻文档同步（不属本批）：配置参考 `session-resources.deletion-enabled` 前提仍写
  三个 `record_bytes` 读取方「尚未 pack-aware」；待 pack-aware CSI admission 与
  activation-lease 读取方迁移（`feat/journal-pack-aware-csi-readers`）合入 main 后，
  该前提行应另行刷新。
