# ManagedAgentStore 与 ManagedSessionStore 拆分设计

[English](2026-11-02-managed-store-decomposition.md) | [简体中文](2026-11-02-managed-store-decomposition.zh-CN.md)

## 状态与范围

本文是已接受 Store 拆分方案的实施契约。基线为 main `e3c7a6d7efc6df6c58ffa8ddd9c42dbb0e1784c4`。R0（[#16061](https://github.com/QwenLM/qwen-code/pull/16061)）已作为 `1bdad7d4b7949a6f8370c95965ec55901e75f67a` 合入；R1 准备开始时，其 [full gate](https://github.com/QwenLM/qwen-code/actions/runs/41322812090) 仍在运行。合并和验收是两份独立证据。[#16029](https://github.com/QwenLM/qwen-code/pull/16029) 已合入，没有额外前置工作。

R1 交付完整双语契约、下文入口/事务/调用者清单及跨文件锁检查。A1–A9 与 B0–B6 现在在实现分支中一并落地，保留下文逐阶段归属和验收清单。两个 facade 保持稳定，实现仍位于 persistence 内。实现与验收分开记录：完整改动必须通过 full Managed Agent gate 才能验收。

相关设计：[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md)、[Agent 构造装配](2026-11-01-managed-agent-store-wiring.zh-CN.md)、[Maven 边界](2026-10-29-managed-agent-maven-modules.zh-CN.md)。

## 问题与决策

两个 Store 把事务入口、SQL、可变业务状态和多个不同的操作状态机混在一起。按方法名称搬移会掩盖副作用，也可能使原有单文件锁顺序检查失效。保留稳定 facade 和明确组件归属，使整个提取过程中的事务行为和调用者可以逐项评审。

保留公共业务接口、DTO、异常映射及包可见兼容桥接。新增协作者均为同包、包可见的 `final` 类，由 facade 构造一次。不增加 Spring Bean、Maven 模块、公开业务接口、可变依赖装配或通用 Context/Support 容器。已有 worktree、definition 和 skills 组件继续承担原职责。

组件通过明确类型单向依赖。不为绕开回环新增 facade 回调或构造函数集合。现有 lazy Spring 回环、调用内 fencing 回调和兼容值类型保持原语义。提取需要共享规则时，随首个实际消费者迁移完整依赖闭包，不提前建设未使用的 helper 框架。

## Agent 职责归属

| 切片 | 组件                       | 职责                                                                                  |
| ---- | -------------------------- | ------------------------------------------------------------------------------------- |
| A1   | `AgentSessionQueries`      | 普通 Session/Turn 读取、分页、批量摘要、worktree 描述及生命周期展示视图               |
| A2   | `AgentEventJournal`        | 公共事件写入、序号与 identity、去重、事件读取及提交通知                               |
| A3   | `AgentMessageProjection`   | 物化、消息分页、覆盖进度、replay floor 及撤回后的修复                                 |
| A4   | `AgentSessionPolicies`     | model、approval、MCP、extension 的准入与配置提交约束                                  |
| A5   | `AgentSessionCommands`     | Turn 输入/取消命令、rename、一般 Session mutation、命令回执与结算                     |
| A6   | `AgentSessionAdmissions`   | 普通/workspace/child/内部/CSI Session 准入和重放；definition、skills 与 worktree 准备 |
| A7   | `AgentLifecycleOperations` | close/archive/delete/unarchive、投递扫描及共用 operation claim/retry/completion       |
| A8   | `AgentExecutionOperations` | cwd、context compression、task cancel 和接受结果未知的结算，含 compression 投影补写   |
| A9   | `AgentTurnExecution`       | dispatch、租约、Harness admission/events、恢复等待、重试及 Turn 终态                  |

`AgentStoreRows` 持有共享 Session/Turn 行映射与加锁读取。Commands 持有共享回执/结算，EventJournal 持有事件 identity 和通知，MessageProjection 持有投影修复。高层准入、生命周期和执行工作流依赖这些明确的下层协作者。操作扫描与对应状态机一起迁移。

Queries 不能成为每个 writer 都依赖的另一个 facade。writer 通过 Rows 共享行访问。`contextCompressionState(s)` 会补写投影，归 ExecutionOperations。`deliverableRenames` 会更新投递状态，归 Commands。保留 `markRenameSubmitted` 等写入口原本没有事务注解的行为。

worktree 展示入口 `findSessionWorktree(s)` 和 `listSessions` 会通过已有 `SessionWorktreeStore` 校验及其 `REQUIRES_NEW` 隔离事务持久化 BLOCKED。这三个名称不进入 A1 的纯查询首片；完整实现保留到 A6 将 worktree 协作迁入既定 Queries 展示路径。明确该路径具有副作用，复用现有 worktree 组件，不新增同用途包装或事务。A1 的边界小于最终 Queries 职责。

## Journal 职责归属

| 切片 | 组件                            | 职责                                                                       |
| ---- | ------------------------------- | -------------------------------------------------------------------------- |
| B0   | 现有 facade 构造装配            | 将八个注入 setter 涉及的九个引用改为构造确定                               |
| B1   | `JournalWriterLifecycle`        | acquire、renew、seal、quiesce、release、block recovery 及 live-writer 检查 |
| B2   | `JournalLifecycleAuthorization` | ordinary/lifecycle 授权、approval selection 及生命周期派发授权             |
| B3   | `JournalHistoryQueries`         | restore、分页/近期事务、command transaction 查询及初始 journal 完整性      |
| B4   | `JournalResourceWrites`         | instructions、skills、继承资源、tool result 发布及 commit 内资源写入       |
| B5   | `JournalResourceReads`          | 普通/snapshot/owner 读取、验证更新、隔离、读取租约与回执                   |
| B6   | `JournalCommit`                 | 普通/lifecycle commit、CSI terminal 预检/提交、关联投影与通知              |

`JournalStoreRows` 持有共享行访问/映射，以及解释这些行所需的完整性检查。B1 已需要 activation/head 检查和资源回执校验：`activationLeaseRow`、`restoreHead`、`verifyStoredResource` 及其 `toolResultLimit` 依赖随首个消费者迁移。这些校验可以进行只读 capture/quarantine 查询，但不读取对象流、不获取读取租约、不隔离对象，也不更新验证时间戳；这些副作用留在 ResourceReads。其他 helper 仅在实际使用时迁移。

`JournalFencing` 持有凭据、writer 和 CSI fencing，以及有界锁等待错误映射。检查保留在原有的小粒度调用点。WriterLifecycle、LifecycleAuthorization 和资源操作使用 Rows/Fencing；Commit 依赖实际调用的明确资源/授权组件。不让 WriterLifecycle 经 facade 回调 HistoryQueries 或 ResourceReads 来倒置依赖图。

现有 `ensureSessionRoot` 同时被 writer 获取和生命周期授权使用。B1 首次需要时，将此明确且窄的 root 初始化放入 Rows，保留 root 锁及 event-stream INSERT。因此 Rows 是行访问边界，不是只读服务；不把 writer 或 operation 状态机放进去。

## 事务、锁与原子性

每个 facade 入口保留原 transaction manager、传播方式、隔离级别、readOnly 及无注解行为，包括 `MANDATORY`、`NOT_SUPPORTED` 和 `READ_COMMITTED`。普通协作者不创建事务代理，不引入 `REQUIRES_NEW`。原程序式事务的位置和超时保持不变。

同时锁 Session 和 Turn 的路径继续 Session 在前。placement、retention、root、head 保留各路径的现有顺序。CSI continuation 例外和有界锁等待/死锁映射单独保留，不引入新的统一全局顺序。

资源变更、extension/action/message 投影、journal transaction 和 head 更新原子提交。保留重复提交返回位置、writer/CSI 复核、配置读取时点和通知时点。回滚和重放不新增通知，无同步上下文的 standalone 行为不变。

资源读取不是纯查询。普通和 snapshot 读取保留各自的验证/隔离行为及 retention 租约。owner read 继续拒绝环境事务，保持短事务准入、对象读取、短事务复核/回执/收尾。compression 投影补写保留程序式事务。

保留已有外部 `REQUIRES_NEW` 边界：worktree 隔离及 snapshot 调用者的独立 `READ_COMMITTED` 模板。禁止的是新增事务边界，不是删除调用者已经依赖的边界。

提取过程中不改变 SQL、摘要、JSON 或协议字节、schema、HTTP/OpenAPI 契约及算法。

## 构造装配与兼容

B0 在构造时解析必需依赖，并保留 standalone 默认值。可选 lifecycle 双依赖任一缺失时仍两者均不启用。CSI bindings 仍只接受同一数据源上的 JDBC repository。两个维护入口、手工夹具和工厂创建的 Spring Bean 一起迁移。验证必需/可选依赖缺失、真实 lazy 回环、代理身份、实际 `@Bean` 工厂及 standalone 构造。

publication/snapshot 方法、`PublicationWriter`、`TerminalCandidate`、同数据源检查和已有静态锁工具继续从原 facade 提供。CSI terminal 凭据检查、预检和提交必须使用调用方授权绑定的同一物理连接。Agent CSI 准入/凭据桥接及静态 binding 映射也保持兼容。精确桥接归属见入口清单。

## 锁检查器实现

保留基于 JDK 语法树的检查及有界解析模型。加载 facade 与同包的 `Agent*.java` 或 `Journal*.java` 协作类族，不依赖手工逐类更新的允许列表。其他 persistence 文件保留已有边界扫描。新增包含 SQL 的文件仍须显式改变精确固定的 sibling 集合。

跨选定文件按 owner、名称和参数类型采集成员。各文件的 import 和常量环境独立；共享常量使用限定名，避免一个文件覆盖另一文件的 SQL 文本。每个选定源文件及嵌套类的解析成员都与编译后的类交叉核对。

只追踪引用为 final、声明类型是已解析的具体 final 类的字段接收者。字段类型按声明它的类解析。支持裸字段及显式 `this.field`；参数/局部变量遮蔽裸字段时不能遮蔽显式字段访问。外部导入类型不能借用同名已解析协作类的成员或 SQL 常量。不可解析、多态、重载歧义、泛型/局部类和延迟执行体只要候选涉及 Session 锁或 Turn 行，继续按失败处理。不通过扩大歧义豁免或删除集合断言让搬移后的代码通过。

保留现有 facade 入口集合、事务检查、sibling 边界集合，以及歧义/延迟执行体断言。入口集合按所属 facade 采集，不能由协作类的同名方法满足；锁顺序、歧义及编译成员覆盖仍检查整个协作类族。回归覆盖多文件传递委托、把 Session 锁移到 Turn 访问之后、完全删除锁（由固定的 locker 集合捕获）、隐藏到不可解析接收者、遮蔽、歧义重载及文件独立的常量/import。

检查器证明源码层面的顺序，不证明运行时事务语义或数据库无死锁。后续切片仍需相应运行时及 MySQL 证据。

## 实施清单

此表为唯一阶段清单，英文版本完整同步。入口清单是其方法级明细，不另立独立状态表。两种语言同步记录各阶段实现、精确验证版本、相关证据和未完成项。各阶段一起交付；代码已迁移不代表已验收。

| 顺序 | 交付                                            | 入口清单     | 状态 / 证据                                                            |
| ---- | ----------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| R0   | 完成 Agent 构造装配及实际 Spring 工厂回归       | 已有装配设计 | #16061 已合入；full Hosted 两项失败，待归因                            |
| R1   | 双语契约/清单及跨文件锁检查                     | 下文两个清单 | R1 版本：56 个定向用例及全部 reactor Checkstyle 通过；新版本证据见下文 |
| A1   | Agent 普通查询及首次需要的行 helper             | Agent A1     | 已实现；待验收                                                         |
| A2   | 事件 journal                                    | Agent A2     | 已实现；待验收                                                         |
| A3   | 消息投影                                        | Agent A3     | 已实现；待验收                                                         |
| A4   | Session 策略                                    | Agent A4     | 已实现；待验收                                                         |
| A5   | 命令、回执与结算                                | Agent A5     | 已实现；待验收                                                         |
| A6   | Session 准入                                    | Agent A6     | 已实现；待验收                                                         |
| A7   | 生命周期操作                                    | Agent A7     | 已实现；待验收                                                         |
| A8   | 执行操作                                        | Agent A8     | 已实现；待验收                                                         |
| A9   | Turn 执行与 Agent facade 收尾                   | Agent A9     | 已实现；待验收                                                         |
| B0   | Session 构造装配                                | Journal B0   | 已实现；待验收                                                         |
| B1   | 行访问、fencing 与 writer 生命周期              | Journal B1   | 已实现；待验收                                                         |
| B2   | 生命周期授权                                    | Journal B2   | 已实现；待验收                                                         |
| B3   | 历史查询                                        | Journal B3   | 已实现；待验收                                                         |
| B4   | 资源写入                                        | Journal B4   | 已实现；待验收                                                         |
| B5   | 资源读取                                        | Journal B5   | 已实现；待验收                                                         |
| B6   | 普通/CSI terminal commit 与 Journal facade 收尾 | Journal B6   | 已实现；待验收                                                         |

## 验证与交付标准

R1 不改变 CLI/HTTP 行为，全局 CLI baseline 或模型调用无法验证此源码检查器。使用多文件合成夹具和真实 persistence 源码树，编译 verification 模块，运行 `SessionRowLockOrderTest` 及 reactor Checkstyle。检查双语结构、链接、格式和完整 diff。遵守模块共享本地 Java 预算，保留失败记录，只复用输入未变的证据；新 SHA 或继续会话不会重置预算。此前 272 个装配用例不能验收改动后的检查器。

R1 本地证据：macOS/JDK 21 上原有 44 个锁检查用例和新增 12 个回归全部通过，失败、错误和跳过均为零。已测检查器源码 SHA-256 为 `bc6317d65f0d68dc9837f1d49f85e9a18ed41506e04ef395d33c326c65cd0052`；8 个 reactor Checkstyle 均通过。共享本地 Java 预算累计 413.575/600 秒，含保守延续的 R0 耗时及保留的修复尝试。这仅是定向证据：R1 的完整 verify、SpotBugs、真实 MySQL、Hosted/故障及跨平台资格仍待 CI。

A1–A9/B0–B6 在基于 `77a0d4a4d7cbc9eeab2213b8bf45af117b47d83d` 的实现工作树上的本地证据：修复新增装配夹具的两项失败后，17 个已完成 Java 测试类中的 260 个不同用例通过；17 用例装配复测仅替代这两项失败。生产源码已编译；全部验证源码在最后仅静态修改锁审计断言前完成编译。七次 reactor Checkstyle（parent 与六个生产模块）通过，verification 模块最后的 Checkstyle 尚未执行到。根项目 build/bundle、typecheck 及 54 个专用脚本测试通过。日志、XML 报告和源码指纹保存在 `.qwen/investigations/managed-store-split-implementation/`。

两次受限 Maven 调用均到达截止时间，不能称为整次运行成功。包含此前工作和保留的失败尝试，共享 Java 账本为 598.655/600 秒。`SessionRowLockOrderTest` 开始后被中断；更新的入口集合，以及随后仅静态修复的断言排序、SQL 文件归属集合和精确同名引用标识仍未验证。另十个已选择测试类未完成：`JournalEventPublicationPointTest`、`ManagedEventReplayTest`、`ManagedSchemaJournalAtomicityTest`、`ManagedSessionCreationSkillsTest`、`ManagedSessionNativeReadTest`、`ManagedSessionStoreBindingTest`、`ManagedSessionStoreCredentialTest`、`ManagedTaskCancelOperationTest`、`ReplayFloorRetractionTest` 和 `WorkspaceSessionCloseTest`。这些检查与 verification 模块 Checkstyle，以及 full verify、SpotBugs、真实 MySQL、Hosted/fault 和跨平台资格项均须由 CI 补齐；不宣称新版本已通过 CI 验收。

各已实现阶段的验收需覆盖 tenant/actor 隔离、游标语义和批量查询次数；含 definition/skills/worktree 的准入/重放；序号/去重/投影缺口/撤回/replay floor；提交后通知及回滚/重放不通知；租约 generation/token/到期及接受结果未知时不重复派发；journal 原子回滚/重放；资源损坏/读取租约失效/owner read 收尾；publication/snapshot 锁顺序和 CSI 同连接原子性。

SQL/并发路径需要真实 MySQL 证据。CI 承担完整 verify、SpotBugs、完整 MySQL、Hosted/故障及跨平台检查。当前 push 的 fast tier 缺少必需资格项，接受版本的 full Managed Agent gate 才是交付标准。所有未运行项都单独列明。

每片均需完整 diff 连续两轮干净自审及独立评审。最终两个 facade 只保留装配、事务入口和兼容转发，不包含业务 SQL 或状态机。协作者实例依赖无环，公共契约和各路径事务语义保持一致。定向测试通过不等于完整验收。

## 风险与待决事项

已接受的架构方向没有未决产品问题。主要实施风险是隐蔽查询副作用、共享回执/资源校验、lazy 构造回环、事务边界搬移和源码检查盲区。发现意外依赖时，在最小受影响切片内解决，并在改变设计前同步两个语言版本。不把算法、SQL、存储或协议重设计悄然并入搬移 PR。

## 已实现的依赖边界

facade 按原顺序只计算一次配置和 catalog 校验，再把相同值和依赖实例传给协作类的 final 字段。Agent 构造顺序为 Rows → Queries/EventJournal → Policies/Projection → Commands → Admissions/Lifecycle/TurnExecution → ExecutionOperations。Journal 构造顺序为 Rows → Fencing → WriterLifecycle/HistoryQueries/LifecycleAuthorization/ResourceWrites/ResourceReads → Commit。协作类不接收 facade 或构造器回调集合。

共享 Session/Turn 单点读取位于 Rows；Queries 的三个兼容读取入口转发至这些实现。Policies 持有共享准入谓词，Rows 持有它们已有的 key 编码和数据库时间读取。九参数 Session 准入默认方法仍在 facade 上按原样转发到接口默认实现，保留虚分派和事务边界。资源行校验与对象 IO、租约、隔离分别保留。Commit 在原位置调用提取出的生命周期派发授权块，传入已有的调用内资源 reader。

Session 构造现在确定原 setter 涉及的全部九个引用。Spring 必需依赖仍必需；standalone 构造保留原 null/in-process/unbound 默认值。生命周期双依赖任一缺失时，两者均不启用。CSI 仅接受同数据源 JDBC runtime binding repository。维护入口与夹具在创建下游消费者前传入依赖；实际 Spring 工厂构造另有覆盖。

锁检查保留 facade 入口集合，并按 owner/name/arity 钉住已迁移的 24 个 private helper 重载。协作类与完整源文件族一起分析，同时逐文件保留显式 SQL 归属边界集合。编译成员覆盖、不可解析接收者的拒绝规则和原有反例仍为必需。下文原行号清单指记录的基线，不指迁移后位置。

## Agent 入口清单

源码：`packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedAgentStore.java`。

事务图例：**T** = 保留原始普通 `@Transactional`（默认 REQUIRED、DEFAULT 隔离级别、readOnly false），facade 类保留 `@Qualifier("managedAgentTransactionManager")`；**M** = 在上述基础上显式使用 MANDATORY；**RR** = 显式 transactionManager `managedAgentTransactionManager`、readOnly true、REPEATABLE_READ；**N** = 当前入口没有声明式事务。N 不代表只读，也不授权新增事务。worktree 行另行标明其现有的验证/隔离事务。

所有重载均按源码行号列出。两个构造器保留为 facade 装配；public static `readBinding` 继续在 facade 提供，可转发到行组件。下列生产调用者已按实际接收者声明核对，并单独检查了 CSI 本地 `var` 构造路径；未发现调用的入口明确注明，不意味着可以删除该方法。即使生产代码当前未调用某个兼容入口，测试仍是其消费者。

### A1 AgentSessionQueries

| 入口 / 重载行号                             | 事务 | 直接生产调用者                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `findChildWorkspaceCwd` (691)               | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findChildLineage` (980)                    | N    | ManagedAgentService, ManagedUserMessagePolicy, QwenHostedHarnessConnector                                                                                                                                                                                                                                          |
| `hasCompletedWorkspaceClose` (2283)         | N    | 未发现外部直接生产调用；保留接口、内部及测试用法                                                                                                                                                                                                                                                                   |
| `completedWorkspaceCloses` (2290)           | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `hasExecutionRegistryFacts` (3911)          | N    | ManagedActionStore, ManagedUserMessagePolicy                                                                                                                                                                                                                                                                       |
| `sessionsWithExecutionRegistryFacts` (3919) | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findSession` (4544)                        | N    | ManagedAutomationService, WorkspaceCsiRuntimeAccess                                                                                                                                                                                                                                                                |
| `findSessionById` (4556)                    | N    | ManagedRuntimeCoordinator, WorkspaceRuntimeResolver                                                                                                                                                                                                                                                                |
| `findLatestLifecycleOperations` (4648)      | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findTurn` (4674)                           | N    | HarnessCoordinator, ManagedAgentService, QwenHostedHarnessConnector, SessionRecoveryService                                                                                                                                                                                                                        |
| `findActiveTurns` (4684)                    | N    | ManagedAgentService, QwenHostedHarnessConnector                                                                                                                                                                                                                                                                    |
| `findLatestTurns` (4708)                    | N    | ManagedAgentService, SessionRecoveryService                                                                                                                                                                                                                                                                        |
| `findModelContexts` (4747)                  | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `modelOptions` (4753)                       | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findModelSelections` (4756)                | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findTurnModelSelection` (4776)             | N    | QwenHostedHarnessConnector                                                                                                                                                                                                                                                                                         |
| `findApprovalSelections` (4862)             | N    | ManagedAgentService, QwenHostedHarnessConnector                                                                                                                                                                                                                                                                    |
| `findApprovalOwners` (4881)                 | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findTurnApprovalSelection` (4895)          | N    | QwenHostedHarnessConnector                                                                                                                                                                                                                                                                                         |
| `listTurns` (5086)                          | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findTurnSummary` (5110)                    | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `findLastVisibleStatusBeforeDelete` (6634)  | N    | ManagedAgentService                                                                                                                                                                                                                                                                                                |
| `requireSession` (6647)                     | N    | ChildWorkspaceService, HarnessCoordinator, ManagedAgentService, ManagedExtensionCommandVerifier, ManagedExtensionRecordStore, ManagedRuntimeCoordinator, ManagedSessionStore, ManagedUserMessagePolicy, QwenHostedHarnessConnector, SessionLifecycleCoordinator, SessionLifecycleService, SessionRenameCoordinator |

### A2 AgentEventJournal

| 入口 / 重载行号                         | 事务 | 直接生产调用者                                                 |
| --------------------------------------- | ---- | -------------------------------------------------------------- |
| `findEvents` (5122)                     | N    | ManagedAgentService                                            |
| `findLatestEnvironmentEvents` (5140)    | N    | ManagedAgentService                                            |
| `findControlEvents` (5184)              | N    | 未发现外部直接生产调用；保留接口、内部及测试用法               |
| `findTranscriptEvents` (5199)           | N    | 未发现外部直接生产调用；保留接口、内部及测试用法               |
| `appendPublicEventIfAbsent` (6601)      | T    | HarnessCoordinator, ManagedActionStore, ManagedToolResultStore |
| `appendLiveSessionEventIfAbsent` (6612) | T    | 未发现外部直接生产调用；保留接口、内部及测试用法               |

### A3 AgentMessageProjection

| 入口 / 重载行号                      | 事务 | 直接生产调用者      |
| ------------------------------------ | ---- | ------------------- |
| `findMessagePage` (5234, 5242)       | RR   | ManagedAgentService |
| `findMessageCoveredSequences` (5413) | N    | ManagedAgentService |
| `findReplayWindow` (5435)            | N    | ManagedAgentService |
| `findReplayFloorTargets` (5454)      | N    | ReplayFloorAdvancer |
| `advanceReplayFloor` (5475)          | T    | ReplayFloorAdvancer |
| `findMaterializationTargets` (5506)  | N    | MessageMaterializer |
| `materializeNextBatch` (5516)        | T    | MessageMaterializer |
| `deferMaterializationTarget` (5620)  | T    | MessageMaterializer |

### A4 AgentSessionPolicies

| 入口 / 重载行号                                  | 事务 | 直接生产调用者                    |
| ------------------------------------------------ | ---- | --------------------------------- |
| `workspaceSessionOptions` (1096)                 | T    | ManagedAgentService               |
| `supportsPlanMode` (1113)                        | N    | ManagedAgentService               |
| `hasMcpServers` (1169)                           | N    | SessionLifecycleCoordinator       |
| `requireMcpManagement` (1180)                    | T    | ManagedMcpManagementService       |
| `requireMcpSettingsCommit` (1215)                | M    | ManagedExtensionRecordStore       |
| `requireExtensionManagement` (1228)              | T    | ManagedExtensionManagementService |
| `requireConfigurationCommit` (1266)              | M    | ManagedExtensionRecordStore       |
| `workspaceFilesEnabled` (2249)                   | N    | ManagedAgentService               |
| `workspaceShellEnabled` (2254)                   | N    | ManagedAgentService               |
| `changeSessionModel` (4790)                      | T    | ManagedAgentService               |
| `changeSessionApproval` (4926, 4935, 4944, 4954) | T    | ManagedAgentService               |

### A5 AgentSessionCommands

| 入口 / 重载行号                      | 事务 | 直接生产调用者                                   |
| ------------------------------------ | ---- | ------------------------------------------------ |
| `insertTurnCommand` (1514, 1525)     | T    | ManagedAgentService                              |
| `insertCancelCommand` (1620, 1629)   | T    | ManagedAgentService                              |
| `beginSessionRename` (1685, 1693)    | T    | ManagedAgentService                              |
| `completeSessionRename` (1833, 1840) | T    | ManagedAgentService, SessionRenameCoordinator    |
| `abandonSessionRename` (1918)        | T    | ManagedAgentService, SessionRenameCoordinator    |
| `deliverableRenames` (1933)          | T    | SessionRenameCoordinator                         |
| `claimRename` (1953)                 | T    | ManagedAgentService, SessionRenameCoordinator    |
| `markRenameSubmitted` (1979)         | N    | ManagedAgentService, SessionRenameCoordinator    |
| `retryRename` (1997)                 | T    | ManagedAgentService, SessionRenameCoordinator    |
| `beginSessionMutation` (2080, 2089)  | T    | ManagedAgentService                              |
| `completeSessionMutation` (2151)     | T    | ManagedAgentService                              |
| `abandonSessionMutation` (2225)      | T    | 未发现外部直接生产调用；保留接口、内部及测试用法 |
| `replayCommand` (4502)               | N    | ManagedAgentService                              |
| `findCommand` (4524)                 | N    | ManagedAgentService                              |

### A6 AgentSessionAdmissions

| 入口 / 重载行号                              | 事务                      | 直接生产调用者                                         |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| `insertSessionCommand` (388, 7651)           | T                         | ManagedAgentService                                    |
| `insertWorkspaceSessionCommand` (402)        | T                         | ManagedAgentService                                    |
| `insertInternalTeamLeadSessionCommand` (528) | T                         | 未发现外部直接生产调用；保留接口、内部及测试用法       |
| `findWorkspaceCreateReplay` (555)            | N                         | ManagedAgentService                                    |
| `replayWorkspaceSessionCommand` (570)        | T                         | ManagedAgentService                                    |
| `insertChildSessionCommand` (667, 677)       | T                         | ManagedAgentService                                    |
| `insertPublicChildSessionCommand` (703)      | T                         | ManagedAgentService                                    |
| `replayChildSessionCommand` (952)            | T                         | ManagedAgentService                                    |
| `insertCsiSessionCommand` (582)              | N（要求环境事务）         | WorkspaceCsiSessionCommands                            |
| `requireCsiRequest` (633)                    | N（加锁桥接；调用方事务） | WorkspaceCsiRuntimeAccess, WorkspaceCsiSessionCommands |

### A6 -> AgentSessionQueries：兼容展示路径

这些入口在 A1-A5 期间保持 facade 中的原实现。A6 处理 worktree 协作时，将它们迁入既定的 AgentSessionQueries 组件。副作用继续委托现有 SessionWorktreeStore，不引入额外的 worktree 包装层。

| 入口 / 重载行号                   | 事务                            | 直接生产调用者                          |
| --------------------------------- | ------------------------------- | --------------------------------------- |
| `findSessionWorktree` (157)       | N + 现有 worktree 验证/隔离事务 | HarnessCoordinator, ManagedAgentService |
| `findSessionWorktrees` (162)      | N + 现有 worktree 验证/隔离事务 | ManagedAgentService                     |
| `listSessions` (4564, 4569, 4574) | N + 现有 worktree 验证/隔离事务 | ManagedAgentService                     |

### A7 AgentLifecycleOperations

| 入口 / 重载行号                        | 事务 | 直接生产调用者                                                                                             |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `beginOperation` (2238)                | T    | SessionLifecycleService                                                                                    |
| `beginWorkspaceClose` (2260)           | T    | 未发现外部直接生产调用；保留接口、内部及测试用法                                                           |
| `beginWorkspaceLifecycle` (2268, 2277) | T    | SessionLifecycleService                                                                                    |
| `unarchiveWorkspaceSession` (2322)     | T    | ManagedAgentService                                                                                        |
| `beginChildClose` (2643)               | T    | ChildLifecycleAdmissions                                                                                   |
| `findOperation` (4062)                 | N    | ManagedActionStore, ManagedAgentService, SessionLifecycleService, TaskCancelCoordinator, TurnInputEvidence |
| `findDeliverableOperations` (4070)     | N    | SessionLifecycleCoordinator                                                                                |
| `claimOperation` (4108)                | T    | ActionResponseCoordinator, SessionLifecycleCoordinator, TaskCancelCoordinator                              |
| `completeOperation` (4143)             | T    | SessionLifecycleCoordinator                                                                                |
| `failOperation` (4243)                 | T    | SessionLifecycleCoordinator                                                                                |
| `renewLifecycleOperation` (4308)       | T    | ActionResponseCoordinator, SessionLifecycleCoordinator, TaskCancelCoordinator                              |
| `blockLifecycleOperation` (4363, 4371) | T    | SessionLifecycleCoordinator                                                                                |
| `retryOperation` (4418, 4427)          | T    | ActionResponseCoordinator, SessionLifecycleCoordinator, TaskCancelCoordinator                              |
| `markOperationAnswered` (4473)         | T    | ActionResponseCoordinator                                                                                  |

### A8 AgentExecutionOperations

| 入口 / 重载行号                             | 事务 | 直接生产调用者                                           |
| ------------------------------------------- | ---- | -------------------------------------------------------- |
| `beginContextCompression` (2930)            | T    | ContextCompressionService                                |
| `contextCompressionState` (3005)            | N    | 未发现外部直接生产调用；保留接口、内部及测试用法         |
| `contextCompressionStates` (3020)           | N    | ManagedAgentService                                      |
| `contextCompressionRequest` (3169)          | N    | ContextCompressionCoordinator, ContextCompressionService |
| `findContextCompressions` (3177)            | N    | ContextCompressionCoordinator                            |
| `claimContextCompression` (3186)            | T    | ContextCompressionCoordinator                            |
| `requireContextCompressionCommit` (3200)    | N    | ManagedExtensionRecordStore                              |
| `markContextCompressionSubmitted` (3217)    | T    | ContextCompressionCoordinator                            |
| `settleContextCompression` (3231)           | T    | ContextCompressionCoordinator                            |
| `retryContextCompressionPreparation` (3251) | T    | ContextCompressionCoordinator                            |
| `awaitContextCompression` (3263)            | T    | ContextCompressionCoordinator                            |
| `completeCwdChangeOperation` (3289)         | T    | SessionLifecycleCoordinator                              |
| `failCwdChangeOperation` (3406)             | T    | SessionLifecycleCoordinator                              |
| `beginTaskCancelOperation` (3434)           | T    | ManagedTaskCancelService                                 |
| `findDeliverableTaskCancels` (3539)         | N    | TaskCancelCoordinator                                    |
| `findParkedOperations` (3564)               | N    | OperationReconciler                                      |
| `settleParkedOperation` (3582)              | T    | AcceptanceEvidence, OperationReconciler                  |
| `turnInputAcceptance` (3641)                | N    | TurnInputEvidence                                        |
| `renameAcceptance` (3703)                   | N    | RenameEvidence                                           |
| `settleParkedRename` (3733)                 | T    | RenameEvidence                                           |
| `settleTaskCancel` (3804)                   | T    | TaskCancelCoordinator                                    |

### A9 AgentTurnExecution

| 入口 / 重载行号                         | 事务 | 直接生产调用者         |
| --------------------------------------- | ---- | ---------------------- |
| `findDispatchable` (5627)               | N    | HarnessCoordinator     |
| `findRuntimeRecoveryParked` (5639)      | N    | HarnessCoordinator     |
| `claimTurn` (5654)                      | T    | HarnessCoordinator     |
| `renewTurn` (5675)                      | T    | HarnessCoordinator     |
| `releaseTurnLease` (5685)               | T    | HarnessCoordinator     |
| `markTurnRecoveryBlocked` (5698)        | T    | HarnessCoordinator     |
| `markTurnFailureRecovery` (5721)        | T    | HarnessCoordinator     |
| `requestRecoveryRecheck` (5739)         | T    | HarnessCoordinator     |
| `parkTurnForRuntimeRecovery` (5759)     | T    | HarnessCoordinator     |
| `deferTurnRetry` (5779)                 | T    | HarnessCoordinator     |
| `scheduleTurnRetry` (5786)              | T    | HarnessCoordinator     |
| `bindHarness` (5804)                    | T    | HarnessCoordinator     |
| `bindRecoveredHarness` (5831)           | T    | HarnessCoordinator     |
| `markSubmissionAttempted` (5862)        | T    | HarnessCoordinator     |
| `withdrawSubmissionAttempted` (5887)    | T    | HarnessCoordinator     |
| `recordAdmission` (5904)                | T    | HarnessCoordinator     |
| `recordRecoveryAdmission` (5948)        | T    | HarnessCoordinator     |
| `retractContinuationOutput` (6009)      | T    | HarnessCoordinator     |
| `retractHarnessTurnOutput` (6079, 6087) | T    | HarnessCoordinator     |
| `recordHarnessEvents` (6304)            | T    | HarnessCoordinator     |
| `cancelUnadmittedTurn` (6461)           | T    | HarnessCoordinator     |
| `cancelBeforeAdmission` (6505)          | T    | HarnessCoordinator     |
| `failTurn` (6535)                       | T    | HarnessCoordinator     |
| `failWorktreeInitialTurns` (6541)       | T    | SessionWorktreeService |
| `failRecoveryBlockedTurn` (6562)        | T    | HarnessCoordinator     |

### Rows 兼容转发

| 入口 / 重载行号      | 事务 | 直接生产调用者                                                      |
| -------------------- | ---- | ------------------------------------------------------------------- |
| `readBinding` (7569) | N    | WorkspaceFileStore, WorkspaceMigrationMain, WorkspaceMigrationStore |

清单覆盖 **136 个不同入口名 / 153 个声明**，包括两个包可见的 CSI 桥接方法和一个 public static 映射器，不包括两个构造器。

### worktree 展示路径的决定与副作用

worktree 展示入口不是纯读取。`findSessionWorktree` / `findSessionWorktrees` 调用 `SessionWorktreeStore.descriptor(s)`（107-145），`listSessions` 在批量分页 SQL 后调用 `descriptors`（4645）。`verifiedDescriptor`（112-120）验证文件系统身份并读取当前分支；遇到 `ManagedAgentException` 时调用 `blockIdentity`（368-378），后者通过已有的 `TransactionTemplate` 和 `PROPAGATION_REQUIRES_NEW` 将 READY 改为 BLOCKED 并增加 revision。该独立事务特意保证调用方准入失败回滚后，隔离结果仍然保留。最终决定：首个 A1 纯查询切片排除这三个入口名，保留其 facade 原实现直到 A6。A6 将它们迁入既定 AgentSessionQueries 组件，作为明确带副作用的兼容展示路径，复用 SessionWorktreeStore 验证/隔离及其现有事务。不得添加 readOnly、跳过验证、复制隔离代码、删除现有事务，也不增加另一层 worktree 包装。

策略/执行准入也会通过 `requireCwdChangeRegistryFacts`（3894）进入同一条 worktree 验证路径：先执行 `SessionWorktreeStore.requireReady`，再执行 `hasExecutionRegistryFacts`。必须保留 worktree 验证先于 creator/binding 事实检查的顺序，包括持久化隔离语义。

### 事务与桥接例外

- `findWorkspaceCreateReplay`（555）没有事务声明；`replayWorkspaceSessionCommand`（570）带普通 `@Transactional`。二者都会重新检查重放摘要、internal-team-lead 身份、workspace 绑定和当前读取权限。不得统一这两种事务模式。
- `insertCsiSessionCommand`（582）为包可见方法，没有事务注解，显式要求活动事务并拒绝 journal event transport。`requireCsiRequest`（633）保留相同的 transport 隔离，锁定 Session 和 runtime-request key，并验证 CSI profile/request 身份。调用方 `WorkspaceCsiSessionCommands.create`（19-47）拒绝环境事务，创建新的 10 秒 TransactionTemplate，检查原始物理事务连接，先锁 placement 再锁 retention，验证 registration，随后在该连接上调用两个 Store 桥接入口。此调用方使用 standalone 的 `var sessions = new ManagedAgentStore(...)` 构造路径。
- `requireCsiRequest` 也由 `WorkspaceCsiRuntimeAccess.request`（183-190）调用；该调用方原有的 continuation/retention 锁行为全部保留。保留 facade 方法的包可见性和七参数 standalone 构造器。
- `readBinding`（7569）是 public static 方法，由 `WorkspaceMigrationMain`、`WorkspaceMigrationStore` 和 `WorkspaceFileStore` 直接使用；实际映射迁入行组件后，仍需保留 facade 转发入口。
- `requireMcpSettingsCommit`（1215）和 `requireConfigurationCommit`（1266）使用 MANDATORY。`requireContextCompressionCommit`（3200）没有注解；它在 `ManagedExtensionRecordStore` 的已有提交流程中被调用，不得额外增加 MANDATORY/REQUIRES_NEW 包装。
- `findMessagePage` 重载（5234/5242）显式使用 managedAgentTransactionManager、readOnly true 和 REPEATABLE_READ。普通 Query 入口没有注解，应继续保持。
- `deliverableRenames`（1933）是事务内的修改型扫描：先停放过期的 SUBMITTED claim、重置过期的 PREPARING claim，再选择待处理工作。`markRenameSubmitted`（1979）是没有声明式事务的带条件写入。二者均归 Commands，并保留该差异。
- `contextCompressionState`（3005）调用 `ensureCompactionProjection`（3066）；缺少投影时，通过 DataSourceTransactionManager 创建默认 TransactionTemplate 并重放 journal 行。批量方法 `contextCompressionStates`（3020）可能回落到此写路径，并标记不可用状态。二者归 A8，保留同一程序式事务，不归 A1。
- `publishAfterCommit`（7489）仅在事务同步提交后发布；没有同步上下文时立即发布。空事件不执行任何操作。EventJournal 提取必须保留 standalone 回退行为，不得增加重放或回滚通知。

### 实际锁路径（不统一为一个全局顺序）

- 行 helper `requireSessionForUpdate`（7061/7066）先锁 PUBLIC Session 行，仅在取得该锁后才读取并锁定对应 event-stream 计数器。列表映射器与严格单 Session 映射器对缺少 stream 的处理不同。需要同时锁二者的路径随后通过 `requireTurnForUpdate`（7106）锁 Turn；提取后保留其 NOT_FOUND 映射。
- 许多准入、修改和策略入口首先执行 `WorkspaceMigrationAdmission.lockTenant`，然后按路径依次处理 Session/stream、Turn/receipt/operation。MCP/extension 的 idle 复核（1340）专门按此顺序进行新鲜加锁读取：Session plan -> 活动 Turn -> 未结算 child-run record -> requested action records -> 活动 operation/rename/receipt。已有 journal 快照是这些读取不能改成普通一致性读取的原因。
- 生命周期准入 `beginLifecycle`（2695）先锁 migration tenant，按条件锁 retention tenant，再锁 Session/stream；保留失败操作的重放/恢复、状态授权和 idle journal 检查，按原顺序写 operation/fence/head 及事件。`completeOperation`（4143）先执行 legacy CSI guard，再按条件锁 placement 和 bounded retention，随后根据生命周期协议在 Session 之前或之后加 deletion 锁，最后处理 operation claim。不得统一其分支顺序。
- `ManagedLegacySessionGuard.requireLegacyMutation` 本身通过 `ManagedSessionStore.namedRootDeadlock` 进行使用索引的 CSI root 加锁读取，查询超时为 10 秒。一些 Turn lease 路径采用此 guard 加带条件 UPDATE，准入/终态路径则取得完整 Session/stream 锁后再处理 Turn。保留差异；通用的行 helper 事务或锁会改变语义。
- 物化和 replay-floor 推进在检查 Turn 证据或更新 coverage 之前先锁 Session/stream。撤回修复 `rebuildTurnText`（6172）只在外层 Turn 工作流已经取得原有 owner/epoch 锁之后，才锁 stream coverage 和 message 行。

### A1 依赖闭包与边界

A1 普通查询子集需要 JdbcTemplate、已配置的 ObjectMapper、HarnessRules（用于审批规则解码）、构造时固定的 modelCatalog 快照及 Session/Turn 映射器。WorktreeFiles 和三个 worktree 展示入口推迟到 A6 -> AgentSessionQueries 交付。共享行职责包括 `readSession`、sessionMapper/sessionListMapper、turnMapper/turnSummaryMapper、readBinding、nullable/additive 列 helper、StreamCounters 和已有的加锁 Session/Turn 读取器；各项只在首次实际需要时迁移，保留严格读取与列表读取的 stream 差异及全部 schema projection。JSON 解码仅在具体行映射器确实需要时共享，不引入通用 Support/Context 对象。

`findLatestTurns` 按最后一个 turn.accepted 事件选择，而非最新 gmt_create。A6 迁移 `listSessions` 时，必须保留 tenant/actor 授权、archive/title/cursor 过滤、limit+1 语义、批量 worktree 元数据及验证/隔离；查询次数、顺序和字节表示不变。`findSessionById` 是运行时解析已有的跨 tenant 查询，不得擅自增加 tenant 过滤，也不得将其暴露为新的 HTTP 操作。

单点读取和展示视图可以归 Queries；操作任务扫描跟随其状态机（rename -> Commands、materialization/replay floor -> Projection、compression/task cancel/parked -> ExecutionOperations、lifecycle dispatch -> LifecycleOperations、Turn dispatch/recovery -> TurnExecution）。策略、命令和生命周期共享的只读 Session busy 谓词，应在首次迁移时确定唯一的窄职责持有者，不得为了复用它们而让组件回调 facade。

### 后续切片的具体单向协作边界

- A2 EventJournal 持有 appendEvent/appendEvents、event identity/source-key 处理、eventMapper 和提交后发布；可以依赖 Rows，不依赖工作流组件。它不执行同步消息物化。
- A3 MessageProjection 持有投影扫描、物化、replay-floor 状态及 `rebuildTurnText` 修复 helper。事件读取依赖单向指向 EventJournal/Rows。public `retractContinuationOutput`（6009）和两个 `retractHarnessTurnOutput` 重载（6079/6087）仍是 A9 工作流入口：owner/lease/epoch 检查以及 event/identity 删除先于 A3 修复，并处于同一 facade 事务。不得给 Projection 添加指向 TurnExecution 或 facade 的回调。
- A4 策略事务拥有现有的 actor 作用域 SET_MODEL/SET_APPROVAL 重放协议，直接使用 ManagedReceipts（4790 起、4954 起）。它们不调用通用 insertCommand/settleTurnCommand。保留这些作用域和原有 result JSON，不将其重写到新的通用 receipt 流程。A4 可以使用 Queries/Rows/EventJournal 和既有 definitions/skills；后续 Commands/Admissions 单向使用策略检查。
- A5 Commands 持有共同的 `insertCommand`（7156/7163/7170）、`settleTurnCommands`（2477）、`settleTurnCommand`（2532）、Turn command operation 插入（2416）、命令重放和回执。A9 的 recordAdmission/recordRecoveryAdmission/recordHarnessEvents 和终态路径调用此结算边界。A8 接受结果对账必须使用相同的命令/rename 结算语义；Commands 不反向回调 A8/A9。
- A6 Admissions 依赖下层 policy/command/event/row 组件和既有 definitions/skills/worktree 组件。保留先重放、再进行新准入解析的时点，以及 creator/child 作用域、definition 固定和回滚行为。
- A7 LifecycleOperations 持有 operation 单点读取、重放、claim/lease/retry/completion 和 operation 映射器。当前共享 API 由 SessionLifecycleCoordinator、ActionResponseCoordinator 和 TaskCancelCoordinator 使用；facade 路由保持不变。A8 按需调用 A7 的 operation 查询及共同 claim 原语，例如 claimContextCompression（3186）完成专用 CAS 后读取 findOperation；requireContextCompressionCommit（3200）通过同一查询检查操作。协调器已经负责选择通用 completion 或专用 cwd/task-cancel 结算；A7 不得变成调用 A8/A9 的派发器。
- A8 ExecutionOperations 持有专用 cwd/compaction/task-cancel/unknown-acceptance 状态机和对应扫描，向下依赖 Rows/Queries/Policies/Commands/EventJournal 及 A7 共同 operation 原语。通用 claim/retry 不接收用于专用结果处理的回调。
- A9 TurnExecution 需要 Rows/Queries、共同 Commands 结算、EventJournal 和 Projection 修复。不能仅因协调器另行调用生命周期 API 就让它依赖 LifecycleOperations，应保留两者分离，避免形成环。
- 实例构造无环是每次提取的显式验收项，不能仅凭这些职责标签宣称已证明。尤其是 hasOpenOperation/hasOpenExecutionOperation/hasPendingRenameDelivery 等共享谓词和已有 schema key 编码器，不得形成 Policies -> Commands -> Policies 或 Commands -> Lifecycle -> Commands 环。应迁移真实依赖闭包，并在适当位置直接使用现有 schema/receipt helper。无需构造器函数集合、facade 回调或可变 setter。

## Journal 入口清单

基线：`e3c7a6d7efc6df6c58ffa8ddd9c42dbb0e1784c4`（2026-11-02）。下文 `M:<line>` 指 `packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionStore.java`，共 3931 行。同包文件简称均指该 persistence 目录；Controller 位于 server，Hosted connector 位于 adapters。本清单只定义迁移边界，不代表后续切片已实现或通过验收。

### 1. 结论与边界

- 实现公开业务方法共 27 个签名、22 个名称，全部来自现有 contracts `repository.ManagedSessionStore`。构造器 3 个，装配 setter 8 个、引用 9 个；另有包内方法 17 个、包内 record 2 个、锁等待常量 1 个。下面全部列出。
- 该 Store 没有 `MANDATORY` 方法。不能把整体方案提到的 `MANDATORY` 错填到 Journal 入口；Journal 的显式特殊事务是两个 `READ_COMMITTED` history 查询和 `NOT_SUPPORTED` 的 initial-journal 检查，外加无声明式事务的资源读取及包内桥接。
- 新增内部对象不要调用 facade。B1 所需的资源行完整性检查、activation 行映射随首次实际使用进入 `JournalStoreRows`，因此 B1 不需要等待 B3/B5 或回调 facade。对象读取、lease、更新验证时间和 quarantine 均不进入 Rows。
- 公开业务接口、既有包内入口、`PublicationWriter`、`TerminalCandidate`、静态锁工具与常量继续从 facade 提供；内部 helper 的包可见化只为显式类型依赖，不能新增通用 Context/Support。
- 锁顺序按路径保留：普通 heartbeat 不获取 tenant guard，CSI continuation 先锁 root 再获取 placement/retention；publication/snapshot 又有自身先行 legacy guard/probe 和调用者锁。不要把这些路径概括成一个强制全局顺序。

### 2. 事务图例

`T`：原方法 `@Transactional`；manager 由类上 `@Qualifier("managedAgentTransactionManager")`（M:82）保持现有解析，注解未指定显式 manager；传播 `REQUIRED`，隔离 `DEFAULT`，`readOnly=false`，默认 timeout/rollback。两个 overload 的注解分别保留，原 self-call 不产生额外代理边界。

`RO`：同一 manager，`REQUIRED` / `DEFAULT` / `readOnly=true`。

`RC`：同一 manager，`REQUIRED` / `READ_COMMITTED` / `readOnly=true`。内部调用 `restore` 目前是 self-call，不能迁移成额外事务。

`NS`：同一 manager，`NOT_SUPPORTED` / `DEFAULT` / `readOnly=true`；挂起调用者事务，自己不创建事务。

`N`：无声明式事务；不得因为提取而新增代理或注解。是否在事务内取决于现有调用者。特别是 standalone 构造器从来不会自动建立 Spring 方法事务。

`P`：`N` 外壳，程序式 owner-read 流程，见第 6 节。

以下锁轨迹记录原有顺序及分支，省略重复取得同一已持有锁，不表示可以删除这些重复调用。`P`（锁列内）= placement tenant guard；`Tg`= output-publication retention tenant guard；`R`= session root；`H`= managed-session head；`D`= harness drain head；`C`= CSI binding/slot/retirement/progress 原连接锁闭包。所有 bounded tenant 等待继续 5 秒，namedRootDeadlock 仅映射其现有死锁集合。

### 3. 公开业务入口完整矩阵

| 原入口和行号                                | 归属                             | 事务 | 原主要锁/副作用                                                                                                                                                                                                                           | 生产调用者                                                                                                                                     |
| ------------------------------------------- | -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorizeLifecycle` M:211                  | B2 JournalLifecycleAuthorization | T    | credential → P → Tg → ensure R/event stream → placement → session row → lifecycle claim → H；有 kind 时验证有效 writer，无 kind 的 DRAINING 分支只校验身份/状态                                                                           | ManagedSessionStoreController:102                                                                                                              |
| `authorizeOrdinary` M:394                   | B2                               | T    | credential → R → placement → ordinary claim/drain admission（legacy-close 有例外）→ config checks → H → writer；不新增 tenant guard                                                                                                       | Controller:63,93                                                                                                                               |
| `approvalSelection` M:425                   | B2                               | T    | 调用 ordinary 授权后 `ma_session FOR UPDATE`；返回模型/approval/permission selection，不是纯查询                                                                                                                                          | Controller:72                                                                                                                                  |
| `acquireWriter` M:629,635（4/5 参数）       | B1 JournalWriterLifecycle        | T/T  | lifecycle authority 分支先 P→Tg→R→claim；公共核心 P→Tg→CSI/R→physical-open→ensure R/event stream→placement/control storage→materialize D→claim/admission→session row→H；创建/续用/换 generation；cold CSI takeover 经绑定与 history proof | Controller:113；大量手工 journal fixtures                                                                                                      |
| `renewWriter` M:807,813（4/5 参数）         | B1                               | T/T  | authority 分支的 guards 保留；placement→CSI continuation（ordinary R，pinned R→P→Tg→C）→H；普通 heartbeat 不加 Tg；writer 和 CSI lease 复核；activation renew 还更新 journal tx/head                                                      | Controller:124                                                                                                                                 |
| `sealWriter` M:891,897（4/5 参数）          | B1                               | T/T  | authority guards→placement→lockCsiOriginal（private CSI 拒绝普通 seal）→R/H；sealed 相同身份提前 replay；writer 允许过期但不允许身份变更                                                                                                  | Controller:135                                                                                                                                 |
| `quiesceOwnership` M:938                    | B1                               | T    | credential placement identity→placement current→R/H→writer→更新 session QUIESCING                                                                                                                                                         | Controller:152                                                                                                                                 |
| `releaseOwnership` M:952                    | B1                               | T    | P→Tg→R→已有 receipt/resource 的 FOR UPDATE 校验与提前 replay；新请求 placement/claim→H→writer/proof→resource/record/ref→head SEALED→session RELEASED，同一事务                                                                            | Controller:144                                                                                                                                 |
| `blockRecovery` M:1051                      | B1                               | T    | placement→CSI continuation/R→H；writer/CSI current 先于 replay，并在更新 recovery 前再次复核                                                                                                                                              | Controller:162                                                                                                                                 |
| `commit` M:1112,1118（4/5 参数）            | B6 JournalCommit                 | T/T  | authority guards→P→placement→CSI/R/C/可选H→查 command；duplicate 分支提前返回；新提交 physical-open→R/H→resource/projection/journal/head，同一事务。详见第 7 节                                                                           | Controller:173；ToolPublicationAdmissionStore:397,411                                                                                          |
| `restore` M:1485                            | B3 JournalHistoryQueries         | RO   | plain head→scope/storage-policy/read grant→activation projection；不加 FOR UPDATE                                                                                                                                                         | Controller:188；ToolPublicationAdmissionStore:282；ToolPublicationDataStore:950,2229；ManagedNativeJournalSnapshots:205,237,249,255,291        |
| `transactions` M:1560                       | B3                               | RO   | plain head/read grant→先查 revision/bytes 再读 bounded payload；保留连续性/完整性与 workspace 检查                                                                                                                                        | Controller:209；ManagedNativeJournalSnapshots:129,131,132；ToolPublicationStore:559,561,562,566,587                                            |
| `recentTransactions` M:1644                 | B3                               | RC   | 首次 restore/prefix 验证→反向分页两阶段读取→结束前再次 restore，不能改成 RR                                                                                                                                                               | Controller:221                                                                                                                                 |
| `commandTransaction` M:1700                 | B3                               | RC   | 首次 restore/prefix→command hash/size/row→结束前再次 restore                                                                                                                                                                              | Controller:232                                                                                                                                 |
| `hasPristineInitialJournal` M:1759          | B3                               | NS   | 全初始 journal/header/resource integrity 检查，开始和结束 head 一致；不获取 writer/不改变 fence；异常映射为 false                                                                                                                         | SessionRecoveryService:123                                                                                                                     |
| `readResource` M:1920                       | B5 JournalResourceReads          | N    | credential/head/read grant→retention read lease→resource FOR UPDATE→metadata/digest verify→更新 last_verified_at→可选 object IO/quarantine→lease check/close；不得迁入 HistoryQueries                                                     | ManagedToolResultProjector:176,318；ToolPublicationStore:630；ChildResultRelay:469,474,568,573,1161,1202,1212；SessionLifecycleCoordinator:937 |
| `readOwnerResource` M:1968                  | B5                               | P    | 拒绝环境事务；非 CSI 回退 readResource；CSI 是短事务 admission→独立连接 fetch→短事务复核/receipt/lease 收尾，见第 6 节                                                                                                                    | Controller:269                                                                                                                                 |
| `publishAgentInstructions` M:2328           | B4 JournalResourceWrites         | T    | scope→legacy CSI index locking probe→resource FOR UPDATE/插入或幂等验证；无 writer lease 新语义                                                                                                                                           | QwenHostedHarnessConnector:2111                                                                                                                |
| `publishAgentSkills` M:2341                 | B4                               | T    | 同上，继续使用 AgentDefinitionExtensions.skillsBytes 的原字节编码                                                                                                                                                                         | QwenHostedHarnessConnector:2121,2145                                                                                                           |
| `publishInheritedExtensionResource` M:2350  | B4                               | T    | snapshot resource 拒绝→legacy probe→kind/schema/byte/digest→resource FOR UPDATE/插入或幂等                                                                                                                                                | QwenHostedHarnessConnector:2044,2049,2052                                                                                                      |
| `publishToolResult` M:2410,2416（4/5 参数） | B4                               | T/T  | authority guards→验证 bytes→physical P→Tg→placement→CSI continuation/R→H→no-lifecycle-claim（authority 也不能豁免 v2）→writer/native-head→resource→current fence→insert/replay→CSI time                                                   | Controller:198                                                                                                                                 |
| `hasLiveWriter` M:3459                      | B1                               | T    | 直接 H FOR UPDATE，再 DB time；不补 root/tenant 锁，不改只读注解                                                                                                                                                                          | SessionLifecycleCoordinator:602,815,846                                                                                                        |

调用者扫描有两个名称相似但并非 Journal 调用，已排除：QwenHostedHarnessConnector:273 是 SDK client.releaseOwnership，:889 是 builder.approvalSelection。ToolPublicationAdmissionStore:295,342,361 和 ToolPublicationStore:493 的 `data.readResource` 也不是这个 Store。

### 4. 包内兼容入口完整矩阵

| 原入口                                   | 最终实现归属                             | 事务/连接要求                                                   | 调用者及保留点                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `usesDataSource` M:522                   | facade 或 Rows 恒等委托                  | N；`source != null && jdbc.getDataSource() == source`           | ToolPublicationDataStore:96–99、ToolPublicationAdmissionStore:53–56、WorkspaceCsiApplicationHistory:60–61；不能改 equals/unwrap/连接池同 URL 判断                                                      |
| `lockSnapshotWriter` M:577               | B1 WriterLifecycle                       | N，调用者已有事务                                               | ManagedNativeJournalSnapshots:89,108,179,200；原 P→lockPublicationWriter→ordinary admission→H→restore mapping；PublicationWriter/RestoreHead 保持值语义                                                |
| `lockPublicationWriter` M:598            | B1 WriterLifecycle                       | N，调用者已有事务                                               | ToolPublicationStore:327；ToolPublicationDataStore:1121,1181；ToolPublicationAdmissionStore:374；先 legacy index probe，再 physical P→Tg→placement→CSI/R→H→writer/native-head；不能忽略调用者之前的锁  |
| `readSnapshotResource` M:1925            | B5 ResourceReads                         | N；snapshots 自己已有隔离程序式事务                             | ManagedNativeJournalSnapshots:520；updateVerification=false：resource plain SELECT，不更新 last_verified_at，不 quarantine，但仍持有/检查/关闭 retention lease                                         |
| `requireCsiApplicationCredential` M:2581 | B1 Fencing                               | N，authority 同物理连接且已绑定 jdbc DataSource 事务            | WorkspaceCsiApplicationStore:105,119,137,184,213,230；先 authority.requireConnection，再 DataSourceUtils.isConnectionTransactional(target, same datasource)，credential→isolated journal→R/H→CSI/token |
| `requireCsiHistoricalCredential` M:2601  | B1 Fencing                               | N，无 SQL/锁；校验 credential+retained token hash               | WorkspaceCsiApplicationHistory:92，在其已有只读 RR snapshot 内调用；不能改成 live-writer/lease 检查                                                                                                    |
| `preflightCsiTerminal` M:2609            | B6 Commit                                | N，同 authority 连接；PreCut；bindings 必须同 DataSource        | WorkspaceCsiApplicationStore:125,144；strict bytes→credential/isolation→commit validation→R/H→writer/head→terminalPreflight(target)；返回原 TerminalCandidate                                          |
| `commitCsiTerminal` M:2636               | B6 Commit                                | N，同 authority 连接，Stage.FROZEN                              | WorkspaceCsiApplicationStore:192；冻结字节与摘要匹配→重复 preflight→resource fence→journal fence→SEALED head CAS→最后 time check；不调用普通 commit，不新增 transport 通知                             |
| `validateCsiTerminalBytes` M:2695        | B6 Commit 静态纯验证，facade 转发        | N，无 SQL/IO                                                    | WorkspaceCsiApplicationStore:336；保持 strict JSON 参数、exactBody 和同一验证规则                                                                                                                      |
| `lockCsiOriginal` M:3162                 | B1 Fencing                               | N；pinned CSI 必须原事务连接；ordinary standalone 仍可 null     | ToolPublicationAdmissionStore:371；保留其先行 original-settled-result 及 tenant 顺序                                                                                                                   |
| `toolResultLimit` M:2507                 | Rows 的纯资源行约束，facade 保留静态转发 | N，无 SQL/IO                                                    | 现有包内静态入口；返回 kind 固定上限，verifyStoredResource 也使用                                                                                                                                      |
| `commandKeyHash` M:3832                  | Rows 的键编码，facade 保留静态转发       | N，纯 bytes                                                     | ManagedAgentStore:3689；operation + NUL + commandId、UTF-8、SHA256 不变                                                                                                                                |
| `journalCorrupt` M:3861                  | Rows 行校验错误，facade 静态转发         | N                                                               | ToolPublicationStore:535,544,557,563；保留 HTTP/code/message                                                                                                                                           |
| `skipContended` M:301                    | B1 Fencing 静态工具                      | 执行调用者传入 TransactionTemplate；只吞 tenant_guard_contended | ManagedProjectionResourceCollector:42；SessionResourceCollectionCollector:188；不强制 REQUIRES_NEW                                                                                                     |
| `lockBounded` M:314                      | B1 Fencing 静态工具                      | 本身无事务；运行现有 Runnable                                   | ManagedToolResultStore、ManagedProjectionResourceCollector、ToolPublicationDataStore/AdmissionStore/Store、SessionResourceCollectionCollector、ManagedAgentStore、ManagedUserMessageStore              |
| `lockBoundedResult` M:321                | B1 Fencing 静态工具                      | 同上                                                            | ToolPublicationRetentionStore:156；仅 PessimisticLockingFailureException / QueryTimeoutException → tenant_guard_contended                                                                              |
| `namedRootDeadlock` M:341                | B1 Fencing 静态工具                      | 同上                                                            | ToolPublicationRetentionStore:112；ManagedLegacySessionGuard:14；只转换 DeadlockLoserDataAccessException 或链中 MySQL 1213，普通 root wait 错误保留                                                    |

还需保留 facade 上 `PublicationWriter` M:571、`TerminalCandidate` M:2577 两个既有包内 record，以及 `GUARD_ACQUIRE_TIMEOUT_SECONDS = 5` M:111。Root/retention 的已有外部调用会继续调用 facade 静态工具；静态转发不是新增实例依赖或 facade 回调。

### 5. B0 装配事实与迁移要求

| 原 setter                        | 引用及当前 Spring 条件                                                                  | standalone 默认                  | 构造迁移要求                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `configureHarnessRules` M:87     | HarnessRules，required @Autowired                                                       | null                             | Spring required 参数；保留现有 standalone null，不擅自加 SdkHarnessRules 默认                                                  |
| `configureReaderVersion` M:92    | StorageReadPolicy，required @Autowired                                                  | StorageReadPolicy.inProcess()    | Spring required；standalone 仍 inProcess                                                                                       |
| `setLifecycleExecution` M:205    | WorkspaceExecutionStore + SessionQueryStore，两参数的 `@Autowired(required=false)` 方法 | null/null                        | 任一 bean 缺失整个 setter 原本跳过；构造解析两可选参数后任一缺失必须归一化成 null/null，不能改成半启用或启动失败               |
| `setPublicationObjects` M:527    | ToolPublicationObjectStore，可选                                                        | null                             | 构造可选，不创建对象存储默认                                                                                                   |
| `setToolResults` M:532           | ManagedToolResultStore，可选                                                            | null                             | 构造可选，保留 capture 是否启用                                                                                                |
| `setJournalEventTransport` M:539 | JournalEventTransport，可选、flag-off 无 bean                                           | null                             | 构造可选，byte-identical flag-off；CSI isolation 会拒绝非空 transport                                                          |
| `setCredentials` M:546           | WriterCredentialPolicy，required @Autowired                                             | WriterCredentialPolicy.unbound() | Spring 缺失仍 fail-closed，standalone 不新增 bound credential                                                                  |
| `setCsiBindings` M:551           | RuntimeBindingRepository，可选                                                          | null                             | 仅 instanceof JdbcRuntimeBindingRepository 且 `usesDataSource(jdbc.getDataSource())` 才保存；不匹配仍转成 null，不新增启动错误 |

以下构造器及八个 setter 原本均无声明式事务（N）。已有 3 个构造器 M:177/181/187：`(JdbcTemplate)` → 新建 extensionRecords；`(JdbcTemplate, extensionRecords)` → actions=null；Spring 当前 `(qualified JdbcTemplate, extensionRecords, actions)` 三者 required。三个构造链创建同一个 DataSourceTransactionManager，分别给 ToolPublicationRetentionStore 和 ownerReads（timeout=10）；保留这两个原程序式事务对象的配置，不把它们换成新增 Spring Bean 或全局事务 manager 参数。

生产手工调用者只有两个：`server/.../maintenance/WorkspaceCsiRuntimeMain:106–107`（裸构造 + 同 datasource CSI bindings）；`WorkspaceCsiWorkerAckMain:53–54`（裸构造 + SdkHarnessRules）。两者使用场景和默认值不同，不能用一个有额外 enabled 依赖的统一 fixture 替代。

手工测试的中心路径是 `VerificationFixtures.configure(ManagedSessionStore)` :40–46，目前只赋 HarnessRules / StorageReadPolicy。B0 应像 Agent wiring 那样改成明确构造工厂，避免 final 字段反射、先造后重建及 setter 变名。当前构造调用扫描覆盖 52 文件、150 处（2 处生产、148 处 verification），另有 11 文件、16 处显式 setter 调用。B0 迁移逐点核对构造参数、原 setter 条件及 fixture 创建顺序；实施时刷新清单，扫描结果归零只能证明旧装配调用已移除，不能代替行为验证。

扫描当前源文件未发现显式返回 ManagedSessionStore 的 `@Bean` 工厂；有 `ToolPublicationAsyncVerificationTest:317` 的 `.withBean(ManagedSessionStore.class, () -> fixture.sessions)` 路径，其 context 同时提供 HarnessRules、StorageReadPolicy、credentials、bindings 和对象存储。不能依赖 bean postprocessing 继续补已移除 setter，应迁移其已构造 fixture；B0 新增 @Bean 工厂回归验证，避免重演 #16061 漏洞。

依赖图审查：ManagedToolResultStore:40 依赖 EventProjectionStore（Agent facade），WorkspaceExecutionStore:38 依赖 jdbc/transactionManager/WorkspaceStorageGuard/settings；LiteTopicEventTransport:45 只依赖 producer/provider/topic。没有理由为 B0 增加新的 lazy 回环；Agent→records、skills→records 的既有 lazy 边仍原样保留。Spring constructor injection 的 full-context、事务代理和实际工厂测试仍必需。

### 6. 资源读取的实际副作用与事务

#### ordinary / snapshot

M:1930 共享实现先做 scope/credential/resource id/head/read grant；readGrant 自己查 retention live 和 DB now。`outputRetention.read`（ToolPublicationRetentionStore:379）用其现有 `TransactionTemplate`（默认 REQUIRED、DEFAULT、readOnly=false）执行 Tg→R→H 的 `lockGenericSession`，再插入 120 秒 `ma_read_lease`。这会加入既有环境事务；外层方法没有 NOT_SUPPORTED，不能新增。

ordinary 的 findResource `lock=true`，然后 verifyStoredResource，再写 last_verified_at（M:1953），TOOL_PUBLICATION 时读取 object stream；digest/length 错会 quarantine capture/resource。snapshot 的 findResource `lock=false`、不更新 verified、不 quarantine，但 retention lease 仍会插入、按需续期、检查和关闭。两者不是只读组件。`verifyStoredResource` 本身不做这些副作用，见第 8 节。

snapshot 调用者 `ManagedNativeJournalSnapshots:56–61` 既有 isolated template 为 REQUIRES_NEW + READ_COMMITTED；:89 admission/basis、:92 build、:94 lease close、:520 resource read 都沿用该模板。**必须保留这里已经存在的 REQUIRES_NEW**；“不引入 REQUIRES_NEW”只禁止新增，不能删除或复制到新组件。

#### owner

M:1978 同时拒绝 `isActualTransactionActive()` 或已绑定 jdbc datasource 的 resource。非 CSI（M:1995）仍回退 ordinary read。CSI 路径：

1. ownerReads template（M:197–200；同 datasource manager、REQUIRED/DEFAULT/readOnly=false、timeout 10 秒）开启 admission。lockCsiContinuation → original admission 或 DRAINING checkpoint continuation → R/H → read grant → resource metadata FOR UPDATE。校验 inline-only；生成 identity evidence → CSI/read-lease复核 → INSERT `CSI_RESOURCE_READ` OPEN receipt → 再复核 → INSERT ma_read_lease（generation=0）→保存回执。
2. 退出事务后 `fetchNativeResource` M:2172 使用 DataSource.getConnection() 自己取新连接，仅 SELECT 完整 inline bytes、statement timeout=10。这里才是独立读取阶段，不能持有 admission 事务或复用其物理连接。
3. `finishNativeRead` M:2199 再开 ownerReads 短事务：重锁 continuation/original→R/H→read receipt FOR UPDATE；身份/receipt变化直接拒绝。fetch 未知异常时记录 UNKNOWN / jdbc_fetch_unknown，原路径不删除 lease；正常返回时检查 read lease FOR UPDATE、metadata FOR UPDATE、row bytes/hash，复核 CSI/read grant，更新 verified，记录 RETURNED（verified 或具体拒绝码），最后复核后删 lease。某些早期 fencing 异常仍回滚而不强行结算，不能“优化”成 finally 删除。
4. fetch 的 RuntimeException/Error 路径尝试收尾，收尾异常作为 suppressed，原异常继续抛。不能把 owner IO 包成大事务，不能把多次 current-time/read-grant 合并成一次。

### 7. Commit 原子性、CSI 复核和通知

普通/lifecycle commit（M:1118–1459）完整保持一个入口事务。command replay（M:1176–1214）发生在新 resource/projection 写入之前；CSI replay 同样先核验当前 writer、activation replay 和 current time，ordinary replay 仍拒绝 v2 lifecycle claim。duplicate 路径不发事件。

新 commit 先 validateHead / generation / lease，再在需要时对 native `commitFileHistory`/`toolIntent`/`commitCheckpoint` 做 preflight，并重新读 DB time 检验 writer（M:1228–1245）。`commitResources` M:2809 每个 resource 在查 existing 之后、写资源之前执行传入 writeFence；这是已有调用内 callback，可原样保留，禁止把它改成构造器函数集合。

随后同事务完成 declared-resource census、checkpoint/history/hosted closure 校验、HostedCleanupReferences、lifecycle dispatch authorization（M:1313；用成对 execution/session 依赖）、extensionRecords.apply/applyNative、CSI acceptCommit + 再次 writer 检查（M:1343–1367）、actions.apply。journal INSERT 前 requireCsiWriterCurrent（M:1378），head UPDATE 前又 requireCsiWriterCurrent（M:1421），继续 capture tool result events、ManagedUserMessageStore.capture。不能把 resource/projection/journal/head 任一部分分成独立提交。

`publishJournalAfterCommit` M:1466 只由新 commit 尾部 M:1455 调用。transport null 不做事；无 synchronization（standalone）立即 publishCommitted；有 synchronization 注册 afterCommit。rollback 不通知，replay 不通知。CSI continuation/terminal 明确 `requireCsiJournalIsolation`（M:3245）拒绝 transport，因此 terminal 分支没有通知；不要为了统一 commit 加上通知。

CSI terminal 三个桥接方法使用 `WorkspaceCsiApplicationStore.tx` :402–410 创建的既有 10 秒事务和该事务物理连接的 bounded proxy。authority 持有的 connection identity、`DataSourceUtils.getTargetConnection` 和 `isConnectionTransactional` 不可替换为新连接、仅 same URL 判断或单独 helper transaction。preflight 还检查同 datasource JdbcRuntimeBindingRepository。commitCsiTerminal 在冻结字节比较后再次 preflight，每 resource 执行 authority time + writer fence，journal INSERT 前再 fence，head SEALED CAS 前再 fence，返回前再 authority time。`TerminalCandidate` 中 request/proof/token hash 原样保留。

### 8. 共享闭包与单向依赖

`JournalStoreRows` 的允许闭包限于原来的行访问、映射、读取时必要的完整性验证、固定键/字节约束，以及下表显式列出的窄行初始化。它不是纯只读组件，也不能扩展成通用业务 Support：

| 原方法                                                                                                                  | 第一次需要                                  | 是否有 SQL/副作用                                                                                                                                                                            | 迁移裁定                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| headMapper/transactionMapper/resourceMapper，HeadRow/TransactionRow/ResourceRow                                         | B1 writer 的 head 与 release receipt        | 行映射；不写业务状态                                                                                                                                                                         | Rows                                                                                                                                                                                |
| findHeadForUpdate/requireHeadForUpdate M:3119/3359；requireHeartbeatHead M:3140；requireHead M:3367；databaseNow M:3474 | B1                                          | 前两者保留 R→H 和 live read；heartbeat 只 H；plain head 不锁；databaseNow 是 SELECT                                                                                                          | Rows；不能因统一 helper 加锁或丢锁                                                                                                                                                  |
| findResource M:3393/3397、requireResourceScope M:3787、requireTransactionWorkspace M:3798                               | B1 release receipt                          | 默认 FOR UPDATE，显式 false 才 plain；scope 检查无写入                                                                                                                                       | Rows；保留 lock 参数各路径值                                                                                                                                                        |
| verifyStoredResource M:3575                                                                                             | B1 releaseOwnership M:997                   | 状态/长度/SHA256/metadata；TOOL_PUBLICATION 用 SELECT COUNT 验证 capture 对应，inline managed-tool-outcome 用 SELECT COUNT 检查 quarantine；**没有 UPDATE、对象 IO、租约或 quarantine 写入** | 随 B1 迁入 Rows 的 resource-row 完整性边界，后续 B3/B4/B5/B6 复用，不能复制                                                                                                         |
| toolResultLimit M:2507                                                                                                  | verifyStoredResource 内部调用 M:3618        | 纯 kind→固定上限 switch；无 SQL/IO                                                                                                                                                           | 同上；facade 静态入口保留                                                                                                                                                           |
| activationLeaseRow M:1512、ActivationLeaseRow、restoreHead M:1495                                                       | B1 renewWriter M:863、snapshot bridge M:591 | 只 SELECT + strict JSON/digest + head/activation 投影一致性校验，无更新/IO/lease操作                                                                                                         | 随 B1 放 Rows；B3 公开 history 稍后迁移                                                                                                                                             |
| requireHeadScope M:3742                                                                                                 | B1                                          | scope/state/counter/digest 检查并调用 StorageReadPolicy.requireReadable；不写 SQL                                                                                                            | Rows 行合法性；必须保留 reader policy 实际读取时点，不能构造期预先计算                                                                                                              |
| transactionRow M:3409、storedTransaction M:3434                                                                         | B3 或 B6 首次需要时                         | 行映射、byte/hash verify、Base64编码，无写入                                                                                                                                                 | Rows；不提前构建框架                                                                                                                                                                |
| storedResource M:2520                                                                                                   | B6 commit closure reader                    | findResource(FOR UPDATE)+state/scope/verify+DTO，无 object IO/lease                                                                                                                          | B6 首次需要时迁入 Rows；不调用 B5 公共 readResource，避免额外 lease、last_verified_at/quarantine                                                                                    |
| ensureSessionRoot M:3818                                                                                                | B1 acquire / B2 lifecycle                   | R 锁 + INSERT IGNORE ma_event_stream                                                                                                                                                         | 选定为 Rows 内显式的窄行初始化 helper，只供现有 acquire/lifecycle 路径调用。保留调用时点、R 锁和 event-stream INSERT，不扩成通用 mutation，不让 B2 回调 facade 或 WriterLifecycle。 |

Fencing（B1）承接 credential、writer/read-grant、placement、CSI continuation/current-time/lease/history-owner 和锁错误映射；`checkLifecycleWriter` M:266、`requireNoLifecycleClaim` M:482、`requireOrdinaryAdmission` M:490、lifecycleFenced/protocolFenced M:498/510 是被 writer/resource/commit 共享的底层 gate，可随首次使用进入 Fencing。B2 LifecycleAuthorization 承接 3 个业务授权入口及 commit 的“新 lifecycle effect 是否可派发”策略，不回调 WriterLifecycle。`ensureSessionRoot` 已选定归 Rows 的**明确窄行初始化**，只服务现有两个入口，DAG 保持单向；不要为此建 Support，也不要把 writer 状态机放进去。

最终实例 DAG：Rows 在底层；Fencing→Rows；WriterLifecycle→Rows/Fencing；LifecycleAuthorization→Rows/Fencing（及已有 execution/session 成对依赖）；HistoryQueries→Rows/Fencing；ResourceWrites→Rows/Fencing；ResourceReads→Rows/Fencing/既有 retention+object store；Commit→Rows/Fencing/LifecycleAuthorization/ResourceWrites（及已有 extensionRecords/actions/toolResults/transport）。Commit 内 reader callback 直接调用 Rows 的 storedResource，writeFence 是调用内已有回调。每个新对象由 facade 构造一次、字段 final，不传 facade，不引入新 Spring Bean。外部静态锁工具回转现有 facade 兼容符号不形成新的实例回调。

commitResources 是 B4 的 commit 内资源写入方法；ValidatedResource 可用同包的窄值类型或嵌套包内值类型共享，保持现有数据形状。validateCommit 是 B6 的协议/完整提交校验，不因共享资源值类型提前迁入通用 Rows。B4 提取时既有 facade commit 直接调用 ResourceWrites 完整资源闭包，不允许 ResourceWrites 再调用 facade 取查询/锁工具。
