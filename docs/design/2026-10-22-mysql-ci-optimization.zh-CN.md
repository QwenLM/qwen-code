# MySQL 集成 CI 优化

[English](2026-10-22-mysql-ci-optimization.md) | [简体中文](2026-10-22-mysql-ci-optimization.zh-CN.md)

当前数据库集成 CI 仅运行 MySQL 8.4。下文双引擎描述和测量保留原优化时的记录；保留的 MySQL 任务仍为每个 fork 使用独立实例。参见[当前数据库验证范围](managed-runtime-broker-jdbc.zh-CN.md#数据库验证范围)。

## 问题与证据

main 夜间[运行 39664846210](https://github.com/QwenLM/qwen-code/actions/runs/39664846210) 执行 52 个类、1,060 个集成用例用了 33 分 41 秒。各类报告耗时累计为 33 分 39 秒，说明实际基本串行。这个时间不包含单元测试、Maven 缓存操作和 runner 的 Java 锁等待。

`EventTransportConsumerMySqlIT` 在缓存的 Spring context 仍然运行时删除数据库。同一次运行在后续 30 分钟产生了 7,320 次数据库不存在异常。独立的 Spring/JUnit/MySQL 脚本复现了这个生命周期问题，并验证了通过 Spring 测试生命周期关闭 context 后再删库的顺序。

SSH MySQL fixture 还会在数据库没有发生修改的情况下连续三次校验同一个当前版本 schema：版本断言会校验 catalog，显式校验再次执行，父类的初始化又会校验一次。

本地全量报告还显示，`ManagedSchemaLoadMySqlIT` 除了自身唯一的负载用例，还继承并重复执行 `ManagedSchemaSessionMySqlIT` 的全部 21 个用例。因此两个类针对 22 个独立场景共执行了 43 次。

## 改动

1. 在事件消费者 MySQL 测试类结束后标记 context 为 dirty，并通过测试监听器在 Spring 关闭和驱逐 context 后删除测试独占的数据库。不要在 JUnit 的 `@AfterAll` 中提前直接关闭 context，因为 Spring 后续监听器仍会使用它。
2. 仅为 `mysql-integration` 的 Failsafe profile 增加 fork 数量属性，本地默认仍为一个。每条现有数据库矩阵分支选择两个可复用的 JVM fork 和两个使用自身引擎的独立实例。MySQL 8.4 和 MariaDB 10.11 分支保留各自的镜像、启动参数、就绪探针和客户端。测试 launcher 监听器在测试发现和 Spring 初始化之前，将 `${surefire.forkNumber}` 解析为对应数据库 URL。现有逐用例 UUID 数据库和方法串行执行方式继续保留。缺少 fork 映射时直接失败，不能共用第一个数据库。
3. 让 SSH fixture 的数据源工厂返回已经初始化的数据源。H2 工厂初始化新数据库；MySQL 工厂保留两个迁移阶段和版本断言，删除末尾的重复校验。父类 setup 不再重复初始化。
4. 将唯一的负载用例及两个私有帮助方法原样移入 `ManagedSchemaSessionMySqlIT`，删除 `ManagedSchemaLoadMySqlIT`。原有逐用例数据库初始化和清理逻辑保持不变，21 个继承的会话用例和负载用例各执行一次，无需排除测试或新增 fixture 抽象。

## 决策与边界

每条数据库矩阵分支仍然只获取一次现有主机锁、准备一个 job 独立的 Maven 仓库、构建一次、执行一次单元测试并回写一次依赖缓存。Failsafe 在该分支内并行执行集成测试类，无需为每个 fork 新增 workflow job 和主机锁等待。Surefire 单元测试并发方式不变。现有完整源码树报告检查消费合并的 Failsafe 报告，无需静态测试类列表，也不削弱覆盖要求。

独立 JVM 隔离修改 `mysql.url` 和默认时区的测试；独立 MySQL 实例同时隔离应用表和实例级 InnoDB 死锁计数。`ToolPublicationLockOrderMySqlIT` 会故意制造死锁，其他测试则会断言计数没有增长，同一个服务上的独立 schema 无法满足这个契约。每个 fork 内的类和方法不得并行执行。保留 schema 修改、迁移、锁、恢复和原生 worker 断言。生产 schema 校验不变；故意修改或删除 schema 对象的 fixture 继续为每个用例创建新数据库。

涉及文件包括事件消费者 MySQL fixture、两个 SSH fixture、会话和负载 MySQL fixture、测试 launcher 监听器及其测试和服务注册、服务端 Maven profile、Java workflow 及适用的 workflow 元测试。workflow 同时提供原有 `mysql.url`，让检出旧 tag 的发布仍可串行执行。本改动不改变产品行为或产物发布步骤。

本地 Java 验证规范统一写入服务端的[构建与验证规则](../../packages/managed-agent-server/AGENTS.md#build-and-verification)。本地按受影响行为选择检查、复用仍然有效的证据，并遵守时间预算；模块完整验收仍由 CI 承担。这取代原来无条件在本地执行全量 Maven 的要求，不削弱 CI 门禁。根目录 AGENTS.md 保持不变：它已将纯 Java 改动的验证交给模块规则，跨语言改动仍保留根目录要求的 build/typecheck。处理该模块的技能、子代理和自动化提示引用模块规则，避免维护多份副本。后续仅修改文档时，不重跑未变化的 Java 套件。

## 验证与验收

- 复现 context 泄漏，再验证实际 fixture 在删除数据库前关闭 context，后续测试不再产生来自该 context 的数据库不存在异常。
- 在同一个临时 MySQL 8.4 服务上对比 SSH MySQL 测试类的改动前后耗时；保留两次迁移和版本校验，以及全部 H2/MySQL 业务测试。单独记录测试类执行耗时和 Maven 构建耗时。
- 对会话与负载测试合并，比较定向真实 MySQL 运行与归档的两个基线报告去重后的方法身份：22 个用例必须全部通过且零跳过。定向运行前移除已删除类的陈旧编译产物。相对该归档基线，合并减少一个类和 21 次重复执行，在不计后续上游新增用例时为 53 个类、1,054 个用例；当前全量套件的确认交由 CI。
- 使用两个独立 MySQL 实例的双 fork 执行完整 MySQL 集成套件。保留所有测试选择规则，将改动 fixture 的用例身份与基线对齐，记录全量类数、用例数、失败、跳过和 Failsafe 耗时，并执行完整报告检查。验证 Spring 初始化前完成 URL 选择、本地默认串行，以及缺少 fork 映射时拒绝执行。不得以漏跑测试换取加速。
- 执行模块验证、适用的 workflow 元测试、仓库 build/typecheck、格式检查和独立审查。全局 CLI 无法执行 Maven 测试 fixture 生命周期，因此回归采用实际 Java 测试套件和脚本复现，不使用模型驱动的 CLI 提示词。

历史测试类耗时推算的双 fork 理想集成执行时间约为 17 分钟，但这只是规划估算。实测结果必须区分本地 macOS 验证与 Linux CI 执行，并说明数据库、CPU 和 runner 资源竞争差异。

本地未改动的 SSH 基线对相同的 17 个通过用例分别用了 71.379、104.812 和 178.274 秒。共享的 12 核主机负载均值约为 40–50。在这种不断变化的资源竞争下，额外执行完整串行基线也不能产生可靠的改动前后速度对比，因此在启动前取消。实际 CI 提速需在 CI 上测量。

在 JDK 21 和临时 MySQL 8.4.11 实例上，实际事件消费者 fixture 的 12 个原用例全部通过。真实 database-close 调用发生时，Spring context 已停止并移出缓存，而 schema 仍存在；执行真实 DROP 后 schema 消失。在同一 JVM 再观察 3 秒，没有数据库不存在或调度任务错误。SSH fixture 优化后三轮都通过相同的 17 个原用例，耗时分别为 44.342、77.844 和 96.098 秒。主机负载也同时下降，因此这些数据用于证明测试覆盖通过并记录观测时长，不能作为精确 CI 提速比例。代码确定减少每个 SSH 用例两次全量 schema 校验，即每次执行该类减少 34 次。

在会话与负载测试合并之前，2026-10-22 完整、未筛选的 `clean verify checkstyle:check` 验证通过：Surefire 的 5,304 个单元/H2 用例通过，18 个因平台或环境条件跳过；Failsafe 覆盖全部 54 个非 Hosted 类，1,075 个用例全部通过，零失败、错误和跳过。完整源码树报告检查、Checkstyle 和 SpotBugs 均通过。所有报告属性均选择了正确的独立 MySQL 实例：fork 1 执行 25 个类，fork 2 执行 29 个类。完整日志没有数据库不存在或调度任务错误。仓库 build、bundle、typecheck 和适用的 CI 脚本回归也已通过，脚本中因平台条件跳过的项目记录在测试报告中。

本地 MySQL 测试执行耗时 1,419.755 秒（23 分 40 秒），完整 Maven 命令耗时 2,301.433 秒。此次使用共享 macOS 主机上两个原生 MySQL 8.4.11 实例，数据目录在磁盘上；CI 使用 Linux 上的 MySQL 8.4.6、MariaDB 10.11.18 容器和 tmpfs。这些时间证明实现已经在记录的本地条件下运行通过，不能作为相对历史 CI 的实测提速。

随后完成的会话与负载测试合并通过了真实 MySQL 8.4.11 定向验证：22 个独立用例各通过一次，零失败、错误和跳过。方法身份与两个归档基线报告的并集完全一致，Checkstyle 零违规。迁移的测试及帮助方法、继承的会话测试和逐用例数据库生命周期保持不变。此次定向运行不替代尚待执行的全量 CI 确认。

本 PR 同时保留 main 通过 #15003 恢复的数据库矩阵：Shell 回归覆盖两种引擎、两个 fork 的端口、引擎各自的就绪探针和客户端命令，以及任一实例启动或清理失败的路径。同步 main 后，九个工作流调用方测试文件全部通过：545 个用例通过，11 个因平台或能力条件跳过。仓库 build、typecheck、格式、ESLint、工作流大小和本地引用检查通过。真实 Linux 容器执行和 rebase 后的完整套件仍待 CI 验收。

## 状态

实现和已记录的本地检查已完成；rebase 后版本的完整验收仍等待 CI。结果及之前失败的验证轮次保留在 `.qwen/e2e-tests/mysql-ci-optimization.md`。线上 CI 耗时仍待测量，不宣称 CI 提速比例。
