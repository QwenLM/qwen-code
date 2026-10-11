# Workspace 退役期间原 Hook 的恢复

[English](2026-10-08-original-hook-recovery.md) | [简体中文](2026-10-08-original-hook-recovery.zh-CN.md)

状态：已实现恢复；验证要求如下。

## 问题

闲置本地 `hosted-workspace-files/1` Workspace 可以保有原命令 Hook
RuntimeSession。End 和 Delete 效果持久化后，Broker 重启会丢失进程内
Session 上下文。释放仍存活的原 READY Session 随即返回
`runtime_reconciliation_required`，使 Hook detach 无法完成。如果原 worker
也已退出，现有 drain 路径则要求已经不存在的 worker 应答 Session 释放。
两种情况都可能在生命周期效果已结算后继续阻塞退役。

新原生基线通过 Spring 重启复现了存活 worker 的故障。此前全产品进程崩溃
和操作系统重启的观察定位了 worker 已退出的路径；这些证据保留其原提交
归属，需要新的最终验证。上述用例未观察到不安全退役。

一个原生混合故障候选还复现了保留 holder 的依赖冲突：已结算的 Hook
Session 仍持有存储时，managed provisioner 拒绝停止已经不存在的原 worker。
正常传输释放是唯一清除该 holder 的路径，但已经不存在的 worker 无法应答。

## 范围和约束

保留现有闲置 ACTIVE Workspace 准入、End 后 Delete 顺序、签发凭据、当前
生命周期 claim、原 journal writer、ACL、永久 DRAINING 屏障和原子退役
事务。保留独立的 L2 CLOSED/ARCHIVED 删除。未知执行或不完整的原 worker
身份可以无限期阻塞。

不创建替代 Runtime、不重放效果、不从 HTTP 404 或传输失败推断物理停机、
不修改迁移、不扩展 Shell/MCP/CSI/L4 生命周期。原生命令 Hook 测试使用私有
认证 catalog；它不建立新的公开 producer 或 profile。

## 恢复行为

对 Harness 已持久化进入 draining 的原 managed Session，用保存的 provision
seed、resource handle、Runtime instance、lease、epoch 和 endpoint 重新观察
原 READY worker。只恢复这个原 Session 上下文，继续使用既有释放事务、执行
sweep、busy 检查和已确认的传输应答。普通未设置屏障的释放，以及 LOST
generation 中未释放的 Session，仍按原规则拒绝。

在既有已 claim 的 binding drain 内，只有不存在活跃执行时，匹配的
NOT_FOUND 观察才能请求 provisioner 已有的 `stopDrained` 操作。NOT_FOUND
和 JOURNAL_LOST 不是停机 receipt。provisioner 仍须校验原持久注册和原生
PID/boot 身份，包括现有受信任的同机器重启规则。

Hook detach 可能先于 Workspace close 的 binding drain 遇到原 worker 已退出。
在持久 Harness drain 屏障和匹配的原缺失证据下，将该释放导向同一已 claim
的 binding drain。它在 claim 下重新校验原身份，只在停机 receipt 持久化后
释放全部原 Session。Workspace 退役完成前仍须 seal 原 writer。

在逻辑释放任何保存的 Session 前，先在可续约的 operation claim 下持久化
匹配的原停机 receipt。随后使用已有受保护的 Session 释放事务，不再联系
已经证明停止的 worker。managed provisioner 只在本地 DRAINING generation
拥有有效 claim、精确 holder tuple 且零活跃执行时，允许保留原 holder 进行
物理停机；物理停机期间 holder 始终保留。专用于已停机 Session 的 repository
事务校验原身份、持久 receipt、调用方 claim owner/generation 和数据库 lease，
再原子清除该 Session 的精确 LOCAL holder 并释放 Session。同一 binding 中
另一原 Session 的有效 holder 保留到该 Session 释放；外来或损坏的 holder
拒绝事务。持续要求零活跃执行。失败、过期或被 fencing 的
claim 不能保存迟到 receipt 或释放这些 Session。如果 Broker 在 receipt
持久化后退出，下一次已 claim 的 drain 从该持久 receipt 恢复，不要求
worker 存活，也不停止新的 worker。

## 所有权和下游契约

RuntimeSession 释放仍属于原 Session 和持久 Workspace 的作用域。不增加
HTTP 路由或生命周期权威。只有 Broker drain 负责已停机 Session 的清理；
managed server 仍须在 detach 和 Workspace close 前确认当前生命周期 claim
及已结算效果。Hook detach 仍先于 writer seal，生命周期 store 仍须在原子
墓碑前检查全部原 binding 和 writer。

消费者为既有 Runtime release HTTP handler、EmbeddedRuntimeBroker
Workspace close adapter、HostedHookSession release、HostedHarnessSession
detach、SessionLifecycleCoordinator、WorkspaceLifecycleStore、
WorkspaceRuntimeProvisioner、WorkspaceExecutionStore 及 JDBC/内存 binding
repository。公开 READY
准入及执行所有权不变。

独立 JDBC Broker 初始化入口也创建既有执行 holder 表，其列、默认值、主键和
索引与 Server 当前迁移后的表结构一致。因此两种部署下的已停机 Session
事务都使用同一存储 holder 契约。既有 Server 迁移保持不变；保留其 CSI 列
不启用 CSI 退役。

## 验证和验收

执行 build、typecheck 和定向 Broker 测试。固定原 READY 的精确身份、drain
屏障、缺失证据、停机拒绝、外来 receipt、receipt 跨重启持久化和迟到完成
fencing。保留 LOST Session、未知执行和 READY 但不可用的拒绝控制。
验证过期或被替换的 claim、外来 holder 身份和未知执行会原子回滚 holder 与
Session；验证同一 claim 的合法续约，以及多个原 Session 不会清除错误 holder。
比较独立 Broker 与迁移后 Server 的 holder 表结构，并运行 managed Server
holder 回滚及 provisioner 拒绝控制。

独立 test-engineer 冻结精确产物，每种故障运行一个新原生用例：Spring
重启、全部原产品进程崩溃、实际操作系统重启，以及 Harness 保留 Hook
attachment 时 Broker 重启且原 worker 已退出。每项必须保留原
binding/generation/handle 和效果字节，End 和 Delete 各执行一次，不派发
替代 worker 或重放模型请求，确认原停机 receipt，seal 原 writer，并提交
一个退役墓碑。原始命令失败与产品结局分别记录。另以新资源验证有界的
未知 worker 拒绝。

这些检查不构成完整部署或负载验收。既有 O(history) 扫描和 tenant 串行成本
仍需维护者进行架构和负载评审。
