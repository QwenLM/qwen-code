# Managed Tool Execution 状态

[English](managed-tool-execution-state.md) | [简体中文](managed-tool-execution-state.zh-CN.md)

状态：已在内存 Repository 边界实现

## 问题

Runtime Broker 状态基础能够标识 Runtime binding 和逻辑 Runtime Session，
但无法跨重试标识一次 Tool 调用。派发响应丢失时不能产生第二次物理执行，调用方
还必须能在结果不明确时查询原执行。

## 目标

- 定义一次 Tool execution 的不可变身份和可变生命周期。
- 使用稳定幂等键使并发创建收敛。
- 使用 owner、过期时间和单调递增 generation 隔离派发所有权。
- 使用乐观 compare-and-set version 保护更新。
- 保留取消意图、不明确结果、有序结果进度和最终结果。
- 为测试和单进程原型提供同步的内存 Repository。

## 非目标

- JDBC 或 MySQL 持久化。
- 派发 Tool 调用或与 Runtime 通信。
- 定义公开 Agent Event、Item 或 API schema。
- 恢复或重新拉起 Runtime 进程。
- 跨 Session 共享同一个 Runtime。

## 记录身份

`ToolExecutionRecord` 将 `executionCallId` 和 `idempotencyKey` 与 Runtime
binding generation、Harness Session、Runtime Session、Turn、Tool call、请求
摘要和不可变调用引用绑定。引用必须重复 Session、Prompt、call 和参数摘要身份，
使格式错误的记录在构造时失败。

幂等键是收敛键。`findOrCreate` 返回该键最先保存的记录，即使后续候选记录带有
不同的请求身份也是如此。调用方可以比较返回记录与候选记录并拒绝内容变化，
且不会创建另一次执行。若使用不同幂等键复用 `executionCallId`，Repository
会拒绝该请求。

## 生命周期与 fencing

记录提供 `PREPARED`、`DISPATCHING`、`EXECUTING`、`CANCEL_REQUESTED`、
`SETTLED` 和 `UNKNOWN` 状态。Repository 更新使用完整不可变身份和记录 version
执行 compare-and-set。

派发 claim 包含 owner、过期时间和 generation。有效 claim 会阻止其他 owner；
过期后新 owner 必须递增 generation，从而使旧 owner 的更新失效。续租保持
generation 不变并递增记录 version。`UNKNOWN` 记录在调用方通过原执行身份解决
不明确结果前不能再次 claim。

已结算记录必须包含允许的 execution status、结果和结算时间，并且结算后不可变。
结果 sequence 不能倒退。活跃 execution 查询以 Runtime Session 为范围，并排除
已结算记录。

## 并发边界

`InMemoryToolExecutionRepository` 对所有复合操作进行同步。它是单进程参考实现，
不是多 JVM 协调机制。后续 JDBC 适配器必须通过数据库约束和行锁保持相同的身份、
幂等、version、租约和 fencing 语义。

## 安全与租户

记录保留可信 Broker 层提供的 binding 和 Session 身份，但自身不鉴权 tenant 或
workspace 值。调用引用与结果属于 Broker 私有载荷；若没有独立的投影和脱敏契约，
不得记录到日志或作为公开 API 资源暴露。

## 验证

- 同一幂等键的并发创建收敛为一次 execution。
- 有效派发 claim 排斥其他 owner；claim 过期后只能使用更高 generation 接管。
- 过期 version 不能结算当前 execution。
- execution 结算后从活跃 Session 计数中移除。
- 重复幂等键返回原身份，供调用方检测冲突。
- 使用 Java 21 运行 Maven 测试、Checkstyle 和 package verification。

## 验收标准

- Repository 不会为一个幂等键创建两条记录。
- 不能使用过期 generation 续租或修改派发所有权。
- 不可变 execution 身份不能通过 compare-and-set 被替换。
- 已结算 execution 不能再被修改或重新激活。
- 结果状态、sequence 和结算约束失败关闭。
- 不引入 JDBC、Runtime transport、Hosted Harness、Spring 或公开 API 依赖。

## 后续工作

以独立 PR 增加保持同一契约的 JDBC 实现，并使用 MySQL 证明跨实例收敛。Runtime
派发集成在响应不明确后必须查询原 `executionCallId`，不能重放 Tool 调用。
