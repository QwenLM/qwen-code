# Managed Agent 结构评审与重构提案

[English](2026-10-31-managed-agent-structure-review.md) | [简体中文](2026-10-31-managed-agent-structure-review.zh-CN.md)

- 状态：提案。本文档不改动任何代码。
- 日期：2026-10-31
- 范围：`packages/managed-agent-server`
- 分析基线：`9ebd2de171`；两处有差异的数字已按 `origin/main` `e7fe14ee83`
  复核。行数是快照，会随演进漂移。

## 问题陈述

Managed Agent 服务端从首篇设计（2026-09-19）起，约两个月内长成约 13.6 万行
生产 Java 代码（2026-09-01 以来触及本模块的提交有 289 个）。外部边界扎实且
有机器守卫；内部结构则沉积了两类在首个正式 release 后会永久变贵的东西：

1. `persistence` 与 `runtime-broker` 中的上帝类，以及镜像它们的上帝测试文件。
2. 一条已经固化进 `contracts` 模块的会话创建望远镜式重载链。

首个 release 是 `contracts` 还能自由改的最后窗口。本提案把窗口花在两处杠杆
最高的修正上，其余债务列为后续切片。

## 现状

### 模块布局

一个 Maven reactor，六个生产模块加一个不发布的 verification 模块。边界由
`verification/src/test/java/com/alibaba/qwen/code/managedagent/architecture/ModuleArchitectureTest.java`
（ArchUnit）强制：无 split package、无重复类、实现模块互不可见、`contracts`
与 `runtime-broker` 不依赖 Spring、`contracts`/`control-plane`/`runtime-broker`
不依赖 SQL，`contracts` 连 `java.net.http` 与 `ProcessBuilder` 都禁止。

| 模块             | 职责                                  | 生产代码行数 |
| ---------------- | ------------------------------------- | ------------ |
| `contracts`      | 接口、共享值、协议规则                | ~24.0K       |
| `persistence`    | JDBC 仓储、schema、原子 SQL 操作      | ~57.4K       |
| `control-plane`  | Session/Workspace/Channel/自动化编排  | ~20.1K       |
| `adapters`       | Harness SDK、HTTP、OSS、Git、进程供给 | ~15.5K       |
| `server`         | HTTP 端点、Spring 装配、启动预检      | ~12.6K       |
| `runtime-broker` | Runtime 执行、绑定、租约、恢复        | ~6.4K        |
| `verification`   | 全部测试；从不 install 或发布         | ~245K        |

其他实测数字：187 个 HTTP 映射全部落在 API 包的 23 个 controller 上
（含 filter 与 resolver 共 30 个类）；1,272 行 V1 schema baseline 含 38 张
表；模块 README 2,006 行；`docs/design/` 下 200+ 篇英文设计文档（几乎全部
配有中文版）；测试/生产代码比约 1.8:1；SpotBugs 豁免恰好 1 条；生产代码中
`TODO`/`FIXME` 为零。

### 做得好且必须保留的部分

- 上述 ArchUnit 模块门禁。
- OpenAPI 文件作为契约单一来源，由 `ManagedAgentApiContractTest` 与
  `SurfaceRegistryGateTest` 双向钉住，WebShell 类型从同一文件生成。
- 持久化准入、writer 租约/generation 检查，以及发布前 V1 schema 策略
  （原地编辑、拒绝外来 catalog、不做 Flyway repair）。
- CI 中的真实 MySQL 8.4 集成与故障恢复 profile。
- 每个切片都有双语设计文档。

### 结构性债务

**D1. 上帝类。** 最大的生产类：

| 类                                 | 模块           | 行数  | 备注                                                                                        |
| ---------------------------------- | -------------- | ----- | ------------------------------------------------------------------------------------------- |
| `ManagedAgentStore`                | persistence    | 7,751 | 300+ 方法，7 个公开 setter                                                                  |
| `RuntimeBrokerService`             | runtime-broker | 6,329 | 230+ 方法；冷却与 hold 清单已提取（`ExecutionObservationCooldown`、`RuntimeHoldInventory`） |
| `ManagedSessionStore`              | persistence    | 3,931 |                                                                                             |
| `WorkspaceCsiApplicationInventory` | persistence    | 3,319 |                                                                                             |
| `ToolPublicationDataStore`         | persistence    | 2,709 |                                                                                             |
| `QwenHostedHarnessConnector`       | adapters       | 2,328 |                                                                                             |
| `ManagedAgentService`              | control-plane  | 2,120 |                                                                                             |
| `HarnessCoordinator`               | control-plane  | 1,770 |                                                                                             |

`ManagedAgentStore` 混合了会话准入、turn、event、item/message 投影、worktree、
MCP 管理、definition pin、skills 与 extension 投影。它的 7 个公开
`set*`/`configure*` 方法是构造后的可变装配：Bean 在完全装配好之前就可能被
观察到。`RuntimeBrokerService` 把 provisioning、绑定 CAS、租约、取消、恢复
扫描与 extension 命令揉在一个类里；observation 冷却与 tool hold 清单是
首批委托给已提取协作者的关注点（见下方 P1 提取切片）。测试
镜像了同样的形状：`RuntimeBrokerServiceTest` 8,002 行，
`HarnessCoordinatorTest` 4,910 行。

**D2. 望远镜式会话创建 API。** `insertWorkspaceSessionCommand` 在
`AgentStateStore`（contracts）与 `ManagedAgentStore`（persistence）中各有
9 个重载。每个能力切片（approval mode、plan mode、skills、public children、
模型选择、extension pins、worktree plan）都追加一个参数和一个委托重载。最长
签名有 20 个参数。承载接口 `AgentStateStore` 声明了约 150 个方法，任何消费方
都被迫看见全部能力。

**D3. contracts 里的重型协议引擎。** `CsiNativeActivationProof`（2,038 行）
是一个自带 `ObjectMapper` 的完整 JSON 规范化/摘要/证明引擎；
`ManagedExtensionRecords` 1,799 行；`ApiModels` 是 1,102 行的单文件 record
容器。Server 与 Broker 共享字节级协议规则是正确的，但 `runtimebroker` 根包
在已有子包旁边仍平铺着 45 个文件。

**D4. 配置面。** `ManagedAgentProperties` 1,114 行、36 处 `@DurationUnit`
注解；server config 包有 21 个类。`RuntimeBrokerService` 的
`MIN_V3_RESULT_WINDOW` javadoc 记录了一个真实的绑定陷阱：同一个不带单位的
数字，在 server 属性里按秒绑定，在其他消费方按毫秒绑定。目前靠注释和启动
sweep 管理这个陷阱。各字段的单位本身是一份被钉住的绑定契约：
`ManagedAgentPropertiesTest` 遍历全部 36 个 Duration 字段，钉死 9 个毫秒
例外（含 `Auth.allowedDrift`）、`Retention.maxAge` 按天、其余按秒，因此
"统一单位"是配置行为变更，不是内部清理。（#15939 已开始从元数据生成配置
参考；那是互补工作，不能替代本项。）

**D5. 文档可导航性。** 2,006 行的 README 已是百科全书，200+ 篇设计文档是按
时间排列的"地层"。缺一篇"今天这个系统如何工作"的横切导览。

## 目标

- G1：在首个 release 冻结 `contracts` 之前，把会话创建重载链收敛为一个
  参数对象 API。
- G2：沿聚合/关注线为 `ManagedAgentStore` 与 `RuntimeBrokerService` 开出
  内部缝，不改变行为。
- G3：保持所有现有门禁常绿：ArchUnit、OpenAPI 契约、SurfaceRegistry、
  Checkstyle、SpotBugs 以及 CI 测试 profile。

## 非目标

- 不改公共或 WebShell API；OpenAPI 文件零改动。
- 不改 schema；V1 baseline 零改动。
- 不改安全语义（租户隔离、签名认证、租约/generation 检查、revalidation
  窗口）。
- 不加新功能、不改模块边界、不加新依赖。

## 提案方案

### P0 — `SessionCreationCommand`（contracts，发布前窗口）

1. 在 `contracts`（session 包）新增一个 record：

   ```java
   public record SessionCreationCommand(
           String tenantId, String actorId, String idempotencyKey,
           String requestDigest, String agentId, String requestedRevision,
           String title, List<Map<String, Object>> input, String payloadDigest,
           WorkspaceSelection selection, String requestedApprovalMode,
           boolean approvalSelectionSupported, Boolean requestedPlanMode,
           boolean planModeSupported, List<Map<String, Object>> skills,
           boolean publicChildrenSupported, String modelId,
           List<ManagedExtensionPackages.Pin> extensionPins,
           Set<String> extensionLifecycleProfiles,
           SessionWorktreeStore.Plan worktree) {
   }
   ```

   分量清单就是今天最长重载的参数，在定义处一次命名清楚。有两个显式
   边界。其一，canonical 构造器仍是位置式的：交换两个同类型实参（例如
   都是 `String` 的 `tenantId` 与 `actorId`）依然能编译，所以 record 收敛
   的是 store API，并没有消除构造点上的错位风险。如果消除该风险也是
   目标，P0 必须同时提供具名构造路径——按分量设值的 builder，例如
   `SessionCreationCommand.builder().tenantId(...).actorId(...).build()`
   ——P0 已附带交付：全部迁移后的调用点都使用具名构造，而非位置式
   canonical 构造器。其二，新增分量会改变 canonical 构造器签名，既有构造调用点在
   源码与二进制层面都会失效，必须在同一改动内更新；发布前硬切让这在
   当下可接受，首个 release 之后则不行。P0 的承诺范围是收敛 store 重载
   链，包括迁移每一个构造调用点。

2. 把 `AgentStateStore` 与 `ManagedAgentStore` 中的 9 个重载替换为单一的
   `Admission insertWorkspaceSessionCommand(SessionCreationCommand)`。
   硬切，不留 deprecated 桥：release 尚未发生，模块门禁使每个调用方都可
   枚举，留桥只会让重载链继续活着。同一改动内更新全部调用方。

3. 把 `AgentStateStore` 拆成角色接口。已落地（2026-10-31）为六个角色——
   `SessionAdmissionStore`、`SessionLifecycleStore`、`SessionQueryStore`、
   `SessionPolicyStore`、`EventProjectionStore`、`TurnExecutionStore`——
   `AgentStateStore` 保留为继承它们的组合接口，实现与测试继续使用完整
   表面，嵌套 record/常量经继承解析（嵌套类型的 import 必须写拥有它的
   角色）。角色组合 pin 保证组合接口自身为空、不拥有任何表面。消费方
   审计（调用级，评审后更正）：18 个单角色消费方已直接注入其角色——
   生命周期（`RenameEvidence`、`TurnInputEvidence`、
   `ChildLifecycleAdmissions`、`ActionResponseCoordinator`、
   `ContextCompressionCoordinator`、`ContextCompressionService`、
   `ManagedTaskCancelService`、`OperationReconciler`）、查询
   （`ManagedRuntimeCoordinator`、
   `SessionRecoveryService`、`ManagedExtensionCommandVerifier`、
   `ManagedSessionStore`）、策略（`ManagedMcpManagementService`、
   `ManagedExtensionManagementService`）、事件投影
   （`MessageMaterializer`、`ReplayFloorAdvancer`、`ManagedToolResultStore`）、
   Turn 执行（`SessionWorktreeService`）。其余消费方多数跨角色，或把
   store 透传给多角色依赖（Harness 与 broker 装配），继续
   使用组合接口。另有四个单角色消费方暂缓迁移、仍用组合接口，在此
   记录供 P1 跟进：`ChildWorkspaceService`、`WorkspaceRuntimeResolver`、
   `ManagedAutomationService`（查询）与 `TaskCancelCoordinator`（生命
   周期）——它们的 `this(...)` 是本类构造委托而非透传。
   `AcceptanceEvidence.settle` 现已直接接收 `SessionLifecycleStore`，
   `OperationReconciler` 也因此收窄。更窄的注入会随 P1 沿同一
   条缝拆分实现而进一步扩散。先接口隔离，后实现拆分（P1）。

4. 在 `verification` 中按 `SurfaceRegistryGateTest` 的风格加 pin 测试：断言
   `AgentStateStore`（及其后继角色接口）中名为 `insertWorkspaceSessionCommand`
   的方法恰好声明一次。数量只允许棘轮向下，不允许向上。

### P1 — 拆分两个上帝类（后续切片）

- `ManagedAgentStore`：按聚合拆分——准入/命令、事件与投影、turn/message
  查询、worktree、definition/skills——共享同一个 `JdbcTemplate` 与事务
  管理器。模块 README 已允许共享连接的 SQL helper 留在同一包。用构造
  注入替换 7 个公开 setter；真实循环依赖用 `ObjectProvider` 或 `@Lazy`
  显式表达，而不是可变装配。镜像的测试文件在同一批切片中拆开。
- `RuntimeBrokerService`：为恢复扫描、取消、tool hold、observation 冷却
  提取模块内协作者；服务本体退为门面。模块已经存在，不需要动任何跨模块
  契约。这是风险最低、可读性收益最高的拆分。observation 冷却是第一条
  提取的缝（2026-10-31，`ExecutionObservationCooldown`）：它只拥有自己
  触及的状态、无独立生命周期。tool hold 清单同日跟进
  （`RuntimeHoldInventory`）：持久化分页与 RELEASED 过滤逐字迁移，服务
  保留准入、租户解析与错误映射边界。恢复扫描随后调研，证实深度耦合——
  `scanExecutions` 驱动 `reconcileInContext`，后台进程 settle 族拥有
  `SessionContext` 内存索引与 CAS settle 循环——现在提取会造出注入十来个
  回调的协作者而非干净的缝；它等待对账路径先成为独立协作者。取消遵循
  同一原则：只在缝干净处提取。带入对账切片的已知覆盖缺口：`lookupOnce`
  中"先 stamp 后释放
  在途槽位"的顺序没有测试钉住（base 上即存在的缺口）；待对账路径提取
  为独立协作者、该顺序成为缝级契约而非私有 lambda 内部时序时再钉。
- 对账、恢复扫描与取消**不是**干净的独立缝（2026-10-31 调研）。与冷却、
  hold 清单（各自拥有自己的状态）不同，这些路径共享服务的核心可变状态
  与生命周期机制：`sessions`、`liveBindings`、`reconciliations` 三个并发
  map，绑定生命周期助手（`requireAnswerableBinding`、`requireLiveBinding`、
  `invalidateBinding`、`provisioner.isUsable`），以及 CAS 执行 settle
  （`absorbRuntimeStatus` → `settleUnstartedBackgroundSiblings`）。现在
  提取其中任何一个，都会把十来个 map/助手/回调注入一个换个名字的上帝类
  "协作者"。前置条件是一个**共享状态注册表**切片：把三个 map 与绑定生命
  周期助手移到一个拥有它们的 `RuntimeBindingRegistry`（或类似）之后，
  服务转为委托。注册表就位后，对账/恢复/取消依赖的是一个窄所有者而非
  服务内部，从而可提取，M6 顺序也成为测试可钉的缝级契约。该注册表切片
  比两条干净缝更大、风险更高，应在实现前单独设计与评审。
- 之后对 `ManagedSessionStore` 与 `QwenHostedHarnessConnector` 做同样处理，
  各自独立成切片。

### P2 — 卫生项（见缝插针）

- 把 `runtimebroker` contracts 根包的 45 个平铺文件归入子包；在不改任何
  摘要与规范化字节的前提下，把 `CsiNativeActivationProof` 拆成按协议划分
  的无状态类。把"contracts 里的引擎类必须是无状态协议规则"这条线写进模块
  AGENTS.md。
- Duration 绑定：各字段单位是一份被钉住、与安全相关的契约（9 个毫秒
  字段含 `Auth.allowedDrift`、`Retention.maxAge` 按天、其余按秒）。
  `auth.allowed-drift=120000` 今天是 2 分钟；按秒重释会把签名重放窗口
  扩大到 33 小时 20 分，而直接拒绝无单位值会拒掉绑定测试当前接受的
  配置。因此统一绑定是带有兼容与迁移义务的配置行为变更，超出本
  "不改行为"提案的范围；任何这类统一都需要单独提案，写清迁移策略与
  验证要求。范围内的工作是保持每个字段既有单位与接受语义，同时让
  契约更显式，例如在生成的配置参考中呈现各字段的单位。
- README 瘦身为 quickstart + 模块表 + 安全边界 + 索引；深节移到已有的
  `docs/` 页面。新增一篇双语横切架构导览。

## 设计决策与理由

- **参数 record 优于继续加重载。** 重载链本身就是缺陷；record 在定义处
  把每个参数命名一次，并让 store 方法签名在能力增长时保持稳定。record
  并不让构造变得位置安全（同类型交换仍能编译），且每新增一个分量仍会
  改变 canonical 构造器签名，因此每次扩展都要处理构造调用点与二进制
  兼容——发布前硬切下可接受，之后则不行。若以消除错位风险为目标，
  具名构造 builder 才是相应机制；P0 已附带交付，全部迁移调用点均使用
  具名构造。
- **硬切优于 deprecated 桥。** 发布前窗口，简单优先；桥会保住重载链，
  并在迁移期让契约面翻倍。
- **先拆接口，后拆实现。** 消费方立即获得隔离，行为风险近乎为零；有风险
  的物理拆分在接口缝已就位后再做。
- **维护者发起。** 根 AGENTS.md 对外部 500+ 行核心重构硬阻塞。本提案由
  维护者撰写，正是为了让 P1 切片能在该规则下推进。

## 约束

- 适用模块 AGENTS.md 的验证策略：JDK 21、共享 10 分钟预算内的聚焦本地
  测试、完整套件归 CI。触及 SQL 的拆分需要真实 MySQL 证据；broker 恢复
  拆分需要 CI 的 Hosted/fault profile。
- `contracts` 保持无 Spring、无 SQL、无 HTTP 客户端；ArchUnit 门禁原样
  通过。
- 公共路由、`SurfaceRegistry`、OpenAPI 文件必须零 diff；仍要跑
  `ManagedAgentApiContractTest` 与 `SurfaceRegistryGateTest` 作为回归门禁。
- 字节级协议语义（摘要、规范化、签名输入）在每个切片中保持不变。

## 风险

- **diff 体量与评审负担。** 缓解：P0 单独交付；P1 每个聚合各自一个 PR；
  任何切片不混入行为变更。
- **移除 setter 暴露初始化顺序假设。** 缓解：构造注入让顺序显式化；现有
  集成与恢复套件是回归网。
- **并行的功能切片与拆分冲突。** 缓解：先落 P0（它是时间关键项）；P1
  切片安排在功能波次之间并及时 rebase。
- **数字漂移。** 所有计数都是分析基线的快照；下方验收标准是结构性的，
  不是数字性的。

## 验证计划

- P0：新 record 与每个迁移调用方的聚焦单测；预算内本地
  `mvn -Dtest=<affected> test checkstyle:check`；
  `ManagedAgentApiContractTest`、`SurfaceRegistryGateTest` 与新 pin 测试；
  CI 完整 `mvn verify`。
- P1：每个提取类的聚焦测试加镜像拆分的测试文件；触及 SQL 的拆分跑
  `mysql-integration` 用例；broker 恢复提取在 CI 跑 Hosted/fault profile。
- P2 文档：Prettier 与相对链接检查；两个语言版本在同一改动中更新。

## 验收标准

- `contracts` 中恰好声明一个 `insertWorkspaceSessionCommand`，接收
  `SessionCreationCommand`；pin 测试常绿且棘轮生效。
- `ManagedAgentStore` 不再有公开 setter/configure 装配；两个目标上帝类
  完成分解（P1 完成的标志：`persistence` 与 `runtime-broker` 中没有任何类
  超过约定的体量棘轮）。
- OpenAPI 零 diff、schema 零 diff，ArchUnit/Checkstyle/SpotBugs 门禁全绿，
  被接受修订上 CI 完整 profile 全绿。
- README 与架构导览以双语存在并互链（P2）。

## 开放问题

- 已解决（2026-10-31）：`SessionCreationCommand` 放在 `AgentStateStore`
  旁边的 contracts session 包。
- 已解决（2026-10-31）：P0 附带具名构造 builder，全部迁移调用点均已
  使用；重载收敛与 builder 在同一改动落地。角色接口拆分（P0 第 3 步）
  作为独立切片跟进。
- 类体量棘轮门禁是在 P1 之前引入（阻止继续长大），还是在拆分落地之后
  再引入。
- P1 切片与同批类上进行中的功能工作如何排序。
