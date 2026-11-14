# 退役 Runtime Broker 的 InMemory 仓储实现

[English](2026-11-11-retire-inmemory-runtime-repositories.md) | [简体中文](2026-11-11-retire-inmemory-runtime-repositories.zh-CN.md)

状态：已实施（2026-11-11）；本地聚焦验证全绿（763 测试、Checkstyle、SpotBugs），CI 全量门禁待跑。

## 问题

Runtime Broker 持久化模块为每个仓储接口维护了两套实现：所有生产 wiring 使用的
JDBC 实现（`RuntimeBrokerConfiguration` 只构造 JDBC 仓储），以及三个没有任何
生产调用方的 InMemory 实现：

- `InMemoryRuntimeBindingRepository`（558 行）
- `InMemoryRuntimeSessionRepository`（199 行）
- `InMemoryToolExecutionRepository`（512 行）

InMemory 类纯粹作为测试 fixture 存在：`verification` 模块中 42 个测试文件实例化
它们（共 448 处构造）。类注释提到 "single-node use"，但并不存在这样的 wiring。
维护存储契约的第二套实现带来永久性的语义分叉风险：broker 编排测试跑在 fixture
语义上，而它可能偏离生产实际使用的 JDBC 语义。

## 现状

一次场景级覆盖盘点（2026-11-11）将全部 42 个消费文件与现有 H2/JDBC 后端套件
（`JdbcRepositoryTest` 在 H2 上、`JdbcRuntimeBrokerMySqlIT` 在 MySQL 上运行的
`JdbcRepositoryContract`，以及 `ExecutionTakeoverContract`、
`RuntimeRecoveryContract` 和 H2 后端的 service/IT 套件）逐一比对：

- 7 个混合文件已包含其 InMemory 测试的 JDBC 孪生用例，只需删除 InMemory
  方法/参数臂。
- 1 个文件（`HostedExecutionTransportProbeTest`）只自测
  `HostedCancellationProbe` 与 status-reply 门控这两个测试辅助。它们真正的
  使用方是 `HostedWorkspaceToolTurnIT` 中仅限 MySQL 的 FG6d 与 FG6a 用例，
  在 `hosted-harness-mysql` profile 中运行。
- 4 个文件本身已是 JDBC/H2 后端，InMemory 仓储只作为空壳参数传入；直接替换为
  JDBC 不损失任何覆盖。
- 约 27 个文件需要真正迁移 fixture 构造或缺口场景，大头是
  `RuntimeBrokerServiceTest`（约 170 个无覆盖的编排场景、95 处构造）、
  `DurableRuntimeRecoveryTest`（约 30 个）和 `Issue13183RegressionTest`
  （约 15 个）。`RuntimeBrokerHttpServerTest`（44 个用例）通过一处集中的
  Fixture 即可迁移。

## 目标

- 删除三个 InMemory 实现、`InMemoryRepositoryTest` 和 `InMemoryTestAccess`。
- 保留场景覆盖：只删除 H2/JDBC 后端测试已经覆盖的部分；每个缺口场景都迁移到
  H2 上的 JDBC 仓储。
- 不改变生产行为；生产 wiring 本来就只用 JDBC。

## 范围边界

- 仅测试代码与三个未被使用的 fixture 类。不改 SQL、schema、事务或恢复语义，
  因此除现有 CI profile 外不需要新的 MySQL 证据；迁移后的套件获得 H2 覆盖，
  已有 MySQL IT 的部分保持不变。
- TypeScript 侧的 `createInMemoryChannel` helper（acp-bridge）与此无关，保留。

## 方案

分阶段执行，每阶段独立可编译、可测试：

1. **阶段 A — 机械清理。** 在 4 个已是 JDBC/H2 后端的文件中把空壳 InMemory
   参数换成 JDBC；删除 7 个混合文件中的 InMemory 方法/参数臂；删除
   `HostedExecutionTransportProbeTest`。
2. **阶段 B — 中小迁移。** 将集中式 fixture 换到 H2
   （`RuntimeBrokerHttpServerTest`、`EmbeddedRuntimeBrokerTest`、
   `RuntimeProviderPluginsTest`、`SshRuntimeWiringTest`、pinning/fault-gate/
   provisioner 测试），并迁移各 partial 文件中 1–3 个缺口场景。
3. **阶段 C — 大迁移。** `RuntimeBrokerServiceTest`、
   `DurableRuntimeRecoveryTest`、`Issue13183RegressionTest` 的缺口场景。
4. **阶段 D — 退役。** 删除 `InMemoryRepositoryTest`、`InMemoryTestAccess`
   和三个实现；确认无残留引用；跑聚焦套件及 Checkstyle/SpotBugs。

## 设计决策与理由

- **已覆盖的场景直接删除而非迁移**（明确的产品决策）：H2/JDBC 契约与 service
  套件是权威覆盖；针对 fixture 重复一遍只增加维护成本，不产生信号。
- **沿用模块内 H2 模式**：每个测试自建 `jdbc:h2:mem:<uuid>;MODE=MySQL;
DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE` 加 `ManagedSchema.initialize`，
  与 `JdbcRepositoryTest` 及现有混合测试一致。不引入新的共享 fixture 抽象。
- **时间控制**：JDBC 仓储读数据库时钟（`JdbcRepositorySupport.databaseNow`），
  因此 `MutableClock` 场景改为直接 SQL 更新 deadline/lease 列
  （`JdbcRepositoryContract` 已在用的 `expire`/`tamper` 模式），在 H2 与
  MySQL 上行为一致。
- **确定性 ID**：`JdbcRuntimeBindingRepository` 带 ID supplier 的构造器保留
  对生成 ID 的断言。
- **装饰器 fixture 保留**：latched/故障注入 delegate 包装的是仓储接口，
  改为包装 JDBC 仓储即可，无需改动。

## 约束

- 模块验证策略：JDK 21、Maven ≥ 3.8.9、任务级 `-Dmaven.repo.local`、每个增量
  本地验证不超过 10 分钟；本地跑聚焦 `-Dtest=`，全量 unit/H2/MySQL/Hosted
  profile 由 CI 负责。
- Checkstyle 与 SpotBugs 作用于生产模块（被删的类位于 `persistence`）。

## 风险

- **覆盖误判** → 被删场景失去保护。缓解：删除仅限于文件内有 JDBC 孪生或有
  具名 H2 等价物的情况；每处删除都对照所引证据抽查。
- **时间语义漂移**：`MutableClock` 转 SQL 改时间时可能断言错东西。缓解：
  逐场景审查转换，保留原断言结构。
- **套件耗时增长**：每个测试引入 H2 初始化。接受：H2 内存库是模块内既有模式，
  耗时门禁由 CI 负责。

## 验证计划

- 每阶段：在 `packages/managed-agent-server` 下用任务级本地仓库执行
  `mvn -Dtest=<受影响类> test checkstyle:check`。
- 阶段 D：全仓库 grep 证明三个类零残留引用；对 `persistence` 跑 SpotBugs。
- CI：完整 `mvn verify`（unit/H2、Checkstyle、SpotBugs）及 MySQL、Hosted
  profile；在这些门禁通过之前，验收状态保持 pending。

## 验收标准

- 三个 InMemory 类、`InMemoryRepositoryTest`、`InMemoryTestAccess` 被删除，
  源码中无残留引用。
- 盘点中识别的每个缺口场景都在 H2 上的 JDBC 仓储（已有 IT 的在 MySQL 上）
  运行。
- 本地聚焦套件全绿；最终修订版 CI 全量门禁全绿。

## 实施备注

迁移中确立的机制（全部在测试侧；生产行为无变化）：

- **CSI provision pin 播种**：JDBC `findOrCreate` 强制要求控制面在 provisioning
  前写入的 CSI Session root（`ma_session` 行）；InMemory 没有此检查。CSI
  fixture 用既有 INSERT 模式播种 pin（`RuntimeHarnessDrainTest`、
  `RuntimeBrokerHttpServerTest`）。
- **guard 解包装饰器**：JDBC 跨仓储事务（`admitSession`、`admitExecution`、
  `authorizeDispatch`、`recoverLost`、release 路径）要求同 `DataSource` 的原生
  JDBC 仓储。测量 double 保留在 service 读路径上；`JdbcGuardBindings` /
  `NativeAdmissionBindings` 在 guard 调用时解包到原生 delegate
  （`Issue13183RegressionTest`、`RuntimeBrokerServiceTest`）。
- **SQL 门控 pinning 见证**：`BrokerVirtualThreadPinningTest` 无法包装 final
  的 session 仓储，改用 `DataSource` 代理把非锁定 `ma_runtime_session` SELECT
  （guard 内的 `findById` 路径）停在 latch 上；锁定 admission 读直接放行。
- **假时钟 DataSource shim**：连续续租循环测试保留原样的
  `advanceAndAwaitRenewal` 机制——`DataSource` 代理把仓储时钟查询
  （`SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))`，
  精确匹配以放行 schema INSERT）重写为测试 `MutableClock` 的字面量。租约参数
  用整秒，因为 `JdbcRepositorySupport.leaseUntil` 向上取整到秒。同一 shim 用
  两个独立假时钟恢复了时钟偏斜族的"仓储时钟 vs service 时钟"判别。
- **一次性过期**：deadline/lapse 场景把时钟推进改为 SQL `UPDATE` 存储的
  deadline（`expire` 模式）；`renewDispatch` / `renewOperation` 拒绝已失效
  claim，因此过期对后台续租稳定。
- **JDBC 测试访问**：`RuntimeBrokerTestAccess.authorizeDispatch` /
  `insertExecution` / `compareAndSet` 暴露包私有的 execution 级原语，供故意
  省略 CSI admission evidence 的 fixture 使用，替代 `InMemoryTestAccess`。
- **身份断言**：仓储读上的 `assertSame` 改为 `sameIdentity` + version + state
  相等（JDBC 每次写都 bump version，故 version 相等证明"无写"属性）。

已知局限：

- 短 operation-lease fixture（100–200ms）现在按真实 DB 时钟过期；lease/3 续租
  余量保持其存活，CI 重负载下有轻微 flaky 风险。
- 两个 `MySqlIT` 消费文件已换成 JDBC，但只在 CI MySQL profile 运行（本地无
  MySQL 实例）。
- 删除 `HostedExecutionTransportProbeTest` 后，探针辅助的覆盖从单元测试套件
  移到 CI 的 Hosted MySQL job，而该 job 只在 full 档运行。被删的"关闭探针后
  派发与取消两条路径都恢复原 transport、因而不再计数"断言没有直接替代；IT
  只在清理阶段关闭探针。
- 描述当时内存仓储状况的带日期设计记录作为历史保留，不做修改。

## 待解决问题

- 无阻塞项。
