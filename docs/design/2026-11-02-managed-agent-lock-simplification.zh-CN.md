# Managed Agent 锁精简

[English](2026-11-02-managed-agent-lock-simplification.md) | [简体中文](2026-11-02-managed-agent-lock-simplification.zh-CN.md)

## 状态与边界

实现基于 #16090 的 Store 拆分，已核对版本为 `66d23ceb1a5bee7e9cb6362cfc238eb64297f3e6`，该 PR 于 2026-11-02 以 `d9d6fc4a4b8e654d405dbb1d01bf3404e6435a1c` 合并。本分支已 rebase 到 `main` 的 `73474ef094ea1c6bb2a95a9a2a33a28b0ec58e9e`。rebase 后原实现补丁完全一致。后续 CI 分类修复记录在下文，该修复不修改生产代码。实现与验收分别记录；本地结果及待完成的 CI 资格见下文。

保留公共 API、schema、事务管理器、传播方式、隔离级别、错误码、重放回执和 writer/CSI fencing。生产修改限定在 persistence。现有租户 guard 和 CSI 特殊顺序保留超时及错误映射。本次不引入通用锁管理器，也不跨事务缓存锁的持有状态。

## Agent 行访问

`AgentStoreRows` 提供返回 `LockedSessionTurn` 的普通和 legacy 成对读取，保持现有 Session root → event stream → Turn SQL、行映射及失败顺序。恢复标记、Harness 绑定、恢复准入、撤回及事件接受中的七处相邻调用使用这些方法。时钟采样仍在原有等待之后。空批次和撤回参数检查保持原位置。条件取消等分阶段读取继续分阶段执行；仅操作 Turn 的 CAS 路径不增加 Session/event-stream 锁。

## Journal 行访问

分离完整 root/head 获取与已持有 root 时的 head 获取，共享 head 查询、映射、退休检查和缺失 head 错误。仅当前序 CSI 准入位于同一数据源且已关闭 autocommit 的事务连接时复用后者。其他事务通过 Spring synchronization 绑定的连接仍可能处于 autocommit，因此显式检查连接状态，在这种情况下保留完整 root 获取。continuation 为 null 本身不能证明已持有 root。standalone 路径保留完整获取及原有 CSI 拒绝；普通 standalone heartbeat 的行为也保持不变。

应用于 commit、seal、recovery blocking、tool-result/publication writer、CSI renewal，以及 owner read 的两个事务阶段。commit 在修改前复用已取得的 CSI head。普通重复回执的查询和返回仍先于 head 获取。保留后续数据库时间、租约、generation、token 和 CSI authority 校验。acquisition/root/event-stream 初始化及其他生命周期路径保持原有行为。

## 条件更新

现有 claim、renew、release、retry 和 submission-marker 条件更新继续作为快路径契约。两个新增候选为 `cancelBeforeAdmission` 和 `settleFailedTurn`，其 Session 锁、终态事件、命令结算及事务必须保持完整。

两个候选均保留原实现。`RecoverySettlementStoreMySqlIT.removingThePreReadWouldChangeAnOldSnapshotOwnerDecision` 已证明取消、普通失败、recovery-blocked 失败存在合法差异：事务 A 读到 owner A，另一事务释放 A 并由 B 抢占，随后事务 A 携带 B 调用终结操作。原实现的快照前读会拒绝，候选条件 UPDATE 看到当前 B 后成功。测试将候选更新回滚。移除前读会改变结果，因此两处转换均不满足约定的等价性条件。

| 路径                                                | 裁决及契约                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| claim / renew / release / retry / submission marker | 保留现有条件 UPDATE；断言恰好一次 Turn UPDATE，不获取公共 Session/event-stream 锁 |
| `cancelBeforeAdmission`                             | 保留 Session 锁和快照前读；旧快照的 owner 拒绝与 UPDATE-first 不同                |
| `settleFailedTurn`，含 recovery-blocked             | 因同一已验证差异，保留 Session 锁和快照前读                                       |
| 旧值计算、跨表判断、多资源结算                      | 保留现有读取和锁，不属于本次转换范围                                              |

错误 owner 的拒绝仍为一次非锁定 Turn SELECT、零次 Turn UPDATE。成功结算保留原 UPDATE、事件追加和命令结算的锁定读取。原有缺行、租约、重复调用和 recovery-settlement 测试继续保留，本次不改变其语义。

## 运行时验证

用明确入口清单、实际 JDBC 执行轨迹及真实 MySQL 竞争替换跨文件 Java 调用图解释器。清单记录声明类及完整参数签名、事务属性、行为分类和对应场景套件，覆盖 facade 方法、接口默认入口、包可见桥接及兄弟 Store。轻量源码清单固定包含受保护表 SQL 的文件，不推导方法调用，也不证明未执行分支。

JDBC 记录器观察执行尝试及完成、绑定的身份参数、JDBC 连接借用身份、事务边界、提交和回滚。准备语句不等于获得锁。记录器本身不执行 SQL。用固定语句模式识别受审资源；其他 Session、连接、事务或失败语句不能提供所需锁。分别覆盖真实 Spring 代理、外部事务、standalone 调用和 owner-read 事务阶段。

| 原保护                                  | 替代验证                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Facade 入口及重载集合                   | 完整签名入口/事务清单                                                                             |
| 跨 helper 推导 Session-before-Turn      | 真实 Agent 工作流及 JDBC 顺序断言                                                                 |
| Root-before-head 及重复获取             | Journal 工作流及 SQL 次数断言                                                                     |
| 默认接口事务委托                        | 现有代理事务测试及真实 Store 代理场景                                                             |
| 兄弟 Store 边界                         | 受保护 SQL 源码清单；Action、UserMessage、WorkspaceRecovery 场景                                  |
| 未知 Java receiver/overload/lambda 解析 | 删除解释器机制；变化的执行分支必须有场景                                                          |
| 将其他锁误认为目标锁                    | 错误 Session、连接、事务、失败执行、反序及漏锁的负向轨迹                                          |
| 数据库并发及旧快照                      | MySQL event-sequence、recovery-settlement、physical-fence、guard-convoy 和 publication-order 测试 |

`SessionRowLockOrderTest` 现在检查 286 个精确入口，以及受保护 SQL 字面量/文件清单；JDK 解析只提取字符串字面量，注释不能冒充 SQL。不再解析 receiver、猜测重载、递归构建调用图或维护歧义豁免。入口清单登记对应测试套件，并不声称每个入口的每条分支都已经运行。新文件或新字面量中的受保护表 SQL 必须更新清单；通过既有常量间接组装的 SQL 仍需场景和评审覆盖。

`StoreLockTrace` 使用固定表名、锁定读取和身份谓词写法，记录 prepared/plain/batch 执行的尝试、成功和失败，复制批次参数，并在事务结束后清除锁证明。记录器不执行任何数据库探测查询。连接 ID 标识借用的 JDBC 连接，并非数据库服务端连接 ID。`StoreLockTraceTest` 还实际执行漏锁、反序、跨连接、提前提交和错误 Session 的 JDBC 反例。

优化次数还匹配 journal 读取器固定的 WHERE 形式。CSI replay 准入使用相同的完整 head 投影和不同的身份谓词，执行必须保留的 authority 复核；该读取仍参与 head 锁序及事务断言，但与优化的 journal 读取分别计数。replay 在同一事务内保留四次有序 head 访问：优化的 journal head、checkpoint 身份读取、activation authority head，以及第二次 checkpoint 身份读取。两次 checkpoint 探测来自 activation 准入之前及内部的历史验证。分类回归验证两种 authority 投影先于 root 时均被拒绝，并将两者排除在优化的 journal 成本之外。

| 源码分组 / 特殊路径                                       | 场景归属                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 七处 Agent 成对读取和 CAS 拒绝/快路径                     | `AgentLockContractTest`、`AgentLockContractMySqlIT`、`RecoverySettlementStoreMySqlIT`                  |
| Journal writer、普通重放、外部回滚、standalone 和其他事务 | `JournalLockContractTest`、`JournalLockContractMySqlIT`                                                |
| Native owner read 的准入与完成两个事务                    | `ManagedSessionNativeReadTest`                                                                         |
| Native 成功提交和重放                                     | `WorkspaceCsiNativeActivationGateTest`（需要已构建 Node 前置，本地待 CI）                              |
| Action / UserMessage / WorkspaceRecovery                  | `ManagedActionStoreTest`、`ManagedUserMessageStoreTest`、`WorkspaceRecoveryStoreTest` 中的执行顺序断言 |
| 现有生命周期、策略、查询、创建和默认委托                  | 逐签名清单；现有业务套件及 `AgentStateStoreProxyTransactionTest`                                       |
| Retention、publication、physical freeze 和租户隔离        | `ToolPublicationLockOrderMySqlIT`、`ManagedSessionPhysicalFenceMySqlIT`、`ManagedSessionGuardConvoyIT` |

所选运行时优先路线不能证明所有未执行分支。新增入口必须分类，变化的成功、拒绝、重放及特殊分支必须有可执行用例。替代场景到位后才删除旧解析器。衡量精简时统计全部替代 helper；将解析器搬到其他文件不算完成。

## 验收与验证

覆盖 Session/Turn/stream 缺失、CSI 拒绝、空批次、重复派发、旧 owner 和租约、取消/准入/失败竞争、旧读视图、journal 重放及回滚、退休/删除、跨 Session 隔离、有限等待的 CSI 死锁，以及只在提交后通知。Agent 成对读取保持 SQL 序列；每处 Journal 优化衔接减少原有重复 root 获取。条件更新的成功与拒绝成本分别报告。

使用 JDK 21、隔离 Maven 仓库及模块共享的 600 秒本地验证预算。H2 验证夹具/契约，MySQL 8.4 提供并发证据。完整 verify、Checkstyle、SpotBugs、MySQL、Hosted/fault 和平台资格仍由 CI 门禁承担。跳过或不可用检查记为待完成，不能记作通过。无需生产部署或 schema 迁移；回退本独立改动即可恢复原实现。

原检查器为 3,281 行。替代检查器、JDBC 记录器、负向夹具、Agent/Journal 场景、MySQL 适配测试及两份清单合计 1,519 行；加上现有业务/CSI 测试净增的 128 行，替代验证总计 1,647 行，净减少 1,634 行。计数已包含 633 行清单数据，没有将解析器移至其他文件。

## SQL 实测与验证记录

对比时将八个生产文件恢复为 `66d23ceb`，用同样夹具和基线次数断言运行，最后通过 `finally` 恢复候选文件。下表统计目标 root `SELECT ... FOR UPDATE` 与完整 head 行映射 SELECT，不代表操作的全部 SQL。原有 physical/CSI authority 探测有意排除在优化计数之外，其执行顺序继续保留在轨迹中。

| 场景                                                                           | 基线 → 候选                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| 全部七处 Agent 成对读取                                                        | root → Session stream → Turn 不变，最初三次锁定读取 |
| 普通 commit、seal、block recovery、publication writer、tool-result publication | root 2 → 1；映射 head 1 → 1                         |
| 普通续租                                                                       | root 1 → 1；映射 head 1 → 1；不增加租户 guard       |
| 普通重放                                                                       | root 1 → 1；映射 head 0 → 0                         |
| Standalone seal                                                                | root 1 → 1；映射 head 1 → 1                         |
| 其他 Spring 事务绑定 autocommit managed 连接                                   | 保留完整 root 获取：root 2，映射 head 1             |
| CSI 续租                                                                       | root 2 → 1；映射 head 1 → 1                         |
| 到达 native proof 拒绝的 CSI commit                                            | root 3 → 1；映射 head 2 → 1；原拒绝及回滚保持       |
| Native owner read 的两个独立事务，每个阶段                                     | root 2 → 1；映射 head 1 → 1                         |
| 终态 CAS 的错误 owner 拒绝                                                     | 快照 Turn SELECT 1 → 1；Turn UPDATE 0 → 0           |

成功 native CSI commit/replay 的断言已加入原有真实 producer 套件，执行待 CI；本地 CSI 拒绝路径的次数不代表 native 成功执行。普通提交/回滚/重放测试还断言只在提交后发布，回滚不发布，重放不追加发布。提交/回滚后不得复用锁，参见 [MySQL 锁定读取契约](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)。

本地验证环境为 macOS arm64、JDK 21.0.8、Maven 3.9.14，以及任务隔离 Maven 仓库。MySQL 8.4.11 使用本任务的 loopback 实例和可丢弃测试库，`max_allowed_packet=134217728`，关闭 binary logging。macOS 不使用 Linux 的 native-AIO 参数。未清理任何共享数据库。

- 基线：首轮 46 个契约用例，以及后续 42 个基线对照用例通过。
- 候选：H2/MySQL 组合聚焦运行的 153 个用例通过；后续事务边界运行的 46 个用例通过，包含 H2 和 MySQL 上的 autocommit 检查。运行次数存在重叠，不得相加当作独立测试数量。
- MySQL：首轮选定运行的 67 个用例通过。后续选择还覆盖四个新增终态拒绝/缺行用例、租户 guard 隔离、重复提交竞争，以及其他事务的边界。
- 全部 reactor 模块的 Checkstyle 通过；最终 15 个记录器用例通过，包含实际 JDBC 顺序反例。早期尝试曾因新增夹具设置、过宽的 head 计数和测试格式失败，这些尝试均保留在本地预算日志中。
- 待完成：完整 Maven `verify`、SpotBugs、完整 MySQL profile、真实 producer 的 native CSI 成功提交/重放、Hosted/fault 消费者、Linux 和 Windows。本地缺少 Core/CLI 构建产物，因此未运行这些真实进程场景，也未记作通过。不削弱任何 CI 配置或覆盖门禁。

CI 随后在 `c6d83e08a268395011c7ceb71a9dcbfe9cf60a67` 上执行了真实 producer 套件：该轮 Java 运行的 6,100 个用例中，新 replay 成本断言有一处失败，另有 17 个用例跳过。轨迹表明锁序及单事务断言通过，但成本分类器把保留的 authority 复核误计为第二次 journal 读取。现已修正分类及 native 预期，未修改生产代码。后续本地 42 个记录器、journal、native-read 和清单用例以及全 reactor Checkstyle 通过。修正版本的真实 producer 场景仍待 CI，本地这轮运行不能证明其成功。

下一轮 CI 在 `d16d1b016b4eac9e4c86fce8a74f12696f6cb582` 上运行 6,101 个用例，一处失败、17 个跳过。新增的 head 总数断言错误地期望两次访问，轨迹显示还保留了两次部分投影的 checkpoint 读取。源码追踪确认 replay 先验证历史，再锁定 activation head 并再次验证历史。native 契约现固定四次查询的顺序及各自投影，不再假设只有两次完整 head 投影。扩展后的 16 个记录器用例及全 reactor Checkstyle 本地通过；生产代码和 SQL 未改，修正后的真实 producer 用例仍待 CI。

命令从 `packages/managed-agent-server` 运行，通过 `mvn -Dtest=... test checkstyle:check` 选择上列测试类；MySQL 选择额外使用 `-Pmysql-integration -Dmysql.url=... -Dmysql.user=...`。本地 Java 验证共耗时 590.38/600 秒，包含准备、全部失败尝试和 MySQL 清理。共享预算账本和每次尝试的日志位于 `.qwen/investigations/managed-lock-simplification/`。分类修复前已对齐依赖：`git range-diff` 确认 rebase 后实现补丁一致，与已验证修订的对比也确认 persistence 代码、受影响测试源码及锁清单均未变化。保留既有聚焦验证证据和新增分类回归；新基线中的其他集成变化仍由 CI 验证。最终验收仍待上述 CI 门禁。本次改动不包含部署。
