# Managed Agent Java 规约整改

[English](2026-11-04-managed-agent-java-guidelines.md) | [简体中文](2026-11-04-managed-agent-java-guidelines.zh-CN.md)

## 状态与范围

2026-11-04 已在本 PR 实现，并与 #16330 已合入的线程池策略整合，完整 CI 验收尚未完成。同一个 PR 包含低风险清理、并发与异常处理、聚焦的可维护性整理。数据库规约、持久化实现、表结构修改、PMD 接入和大范围生命周期重写不在范围内。验证结果必须区分本地检查与尚未完成的 CI 验收。

## 问题

Alibaba Java 手册审查发现两个没有线程数上限的 cached 平台线程池、未命名的虚拟线程池、请求路径上重复编译的正则、缺少 Override、未使用的私有成员、通过异常进行的空值校验，以及静默的清理失败。

主分支现已提供 executor 上限及独立的 reader/stop 容量。Broker 恢复必须区分资源准备或 worker 启动阶段的准入拒绝与 worker 启动后的错误。将准入拒绝视为普通启动失败会把临时压力变成永久阻断；将身份验证错误视为准入拒绝则可能允许不安全的恢复。worker 返回 READY 后，其 stdout 必须保持打开并持续排空。

## 低风险清理

修复已核实的 Override、未使用私有成员、浮点后缀、虚拟线程名称和高频 action cursor 正则。现有 Checkstyle、SpotBugs、测试和 profile 门禁继续保留。

## 并发与异常处理

沿用主分支的[线程池策略](2026-11-04-managed-runtime-thread-pools.zh-CN.md)：Broker 私有 HTTP 分发使用 32 个具名 daemon 平台线程及容量为 64 的分发队列。本地操作、完整生命周期的 stdout reader 和停止升级使用独立的具名平台线程池，上限分别为 16、64、4，无排队积压。生成进程前预留 reader 容量，READY 后持续排空，停止升级被拒绝时立即强杀。本 PR 不改变这些池大小、队列或拒绝策略。

容量拒绝保留主分支要求的 local-process 类型、可重试的 `503 runtime_local_capacity` 及 `RejectedExecutionException` cause。只从资源准备或启动阶段记录该拒绝，不能来自后续身份验证。保留原 binding 与 seed，并释放操作 claim。资源准备可能在保存任何 handle 前被拒绝，此时保留首次启动的空状态供重试。保留支持启动恢复的持久化 handle。首次非持久化启动时，只通过既有 compare-and-set claim 校验清除本轮创建且精确匹配的 v1 占位 handle，否则下次会把占位误判成需要恢复的丢失 worker。compare-and-set 失败时返回 fencing 错误，不能清除其他 owner 的 handle。后续身份验证阶段即使返回相同错误码和拒绝 cause，也不能触发此例外。其他失败维持现有的恢复封堵行为。

这些固定上限是资源安全限制，不是经过测量的部署容量。reader 池也限制了持续持有 stdout reader 的非持久化存活 worker 数量。HTTP 池限制分发任务数，不限制所有尚未完成的异步业务操作。部署方仍需在这些限制下验证实际负载。本次不增加公共配置项。

保留主分支将完整生命周期 stdout reader 与 READY 等待分离的实现，包括大小限制、超时清理和中断标记保留。取消启动 future 时，如果握手仍在运行，不能提前释放操作池容量。复用主分支 executor 测试，并在 16 个操作的上限下保留聚焦的真实进程取消回归。

用显式空值检查替换 deferred-reference 的 `NullPointerException` 捕获，同时保留失败 stage 上的 400 与错误码。清理诊断只标识操作与异常类型，不泄露凭据、worker 输出、请求内容或含路径的异常消息。清理仍尽力执行，不覆盖原始失败。

## 可维护性

将持久化启动失败分类与本地容量识别移入包内可见的处理类。失败分类以续租后的持久化 claim 请求为准；既有恢复封堵回调保留其 CAS 和 suppressed-error 行为。进程生成与登记、关闭快照、释放时集合转移及回收继续使用同一把 `ReentrantLock`，与 local store 的锁风格一致，清理仍保留在 `finally`。沿用的平台操作池已不在虚拟线程上启动 worker，因此不宣称载体线程负载改善。为重复 cursor 与协议大小限制命名。根据实际调用方补充 RuntimeWarmer 生命周期责任与 RuntimeObservation 结果语义。避免通用辅助框架、批量格式化和无关方法拆分。

清除前只识别首次启动时精确匹配的非持久化占位句柄；仅凭不支持启动恢复，不能证明句柄可以安全丢弃。重试回归测试从真实本地 provisioner 获取占位句柄，使生成格式变更会触发测试失败。不新增 provider SPI。提取后下调 Broker 类 pin 和全局类大小上限，不提高任一限制。

公共 snake_case 字段、语义错误码、JSON 规范化、精确二进制浮点转换及现有持久化和租约协议保持原有语义。特别是用于规范化摘要的精确 `BigDecimal(double)` 转换属于有意设计。

## 涉及区域

涉及本地 Runtime 生命周期锁、Broker 准入失败处理、SSH 清理、action cursor 校验、部分配置与适配器，以及公共生命周期契约。HTTP 分发及三套本地线程池保留主分支实现与测试。所有 Java 回归测试继续位于 `verification`。

## 验证与验收

遵循模块共享十分钟本地验证预算，使用 JDK 21、任务隔离的 Maven 仓库及与当前源码一致的 sibling SDK 安装。CLI dry-run 无法覆盖这些私有 Java 路径，因此使用聚焦 Java 测试和真实 worker 进程。覆盖操作池和 reader 饱和、拒绝时不生成进程、失败或取消后容量恢复、并发清理、关闭、READY 后 stdout，以及使用原持久化身份的重试，包括 handle 尚不存在时的资源准备准入拒绝。确认其他启动失败和带容量错误形态的身份验证失败仍封堵恢复，空值引用仍以异步失败返回。与主分支整合前的结果只属于历史证据；整合中改变的路径需要当前 CI 证据。

运行受影响的 action、SSH、Broker、本地进程测试及两套 Checkstyle 配置。现有完整单元测试、SpotBugs、真实 MySQL、Hosted 和故障门禁继续作为 CI 验收要求。预算内无法本地运行相关真实 MySQL 路径时，明确记录等待 CI，不能用 H2 证据替代。固定并发上限与聚焦测试通过均不代表部署验收。

## 开放问题

实现范围没有待决问题。负载容量设置留待后续依据负载证据决定。
