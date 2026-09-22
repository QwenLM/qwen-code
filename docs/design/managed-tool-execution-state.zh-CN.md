# Managed Tool Execution 状态

[English](managed-tool-execution-state.md) | [简体中文](managed-tool-execution-state.zh-CN.md)

状态：已在内存和 JDBC Repository 边界实现

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
`SETTLED` 和 `UNKNOWN` 状态。Repository 更新分为三种形态：受隔离的派发
路径、开放的取消路径，以及不需要 claim 的恢复路径。

受隔离路径是 `compareAndSet`。调用方在 `expected` 快照之外，还必须出示
自己的派发 owner 与 generation；只有当存储记录与该快照在不可变身份、
claim 和 version 上一致、出示的 owner 与 generation 与存储的 claim 一致、
租约未过期、且记录既不处于 `SETTLED` 也不处于 `UNKNOWN` 时，写入才成功。
replacement 必须重复 claim 字段，不能转移或抹掉派发所有权，不能使结果
sequence 倒退，也不能清除已记录的取消意图。这道 fence 防的是出示自己令牌
的"过期但诚实"的 dispatcher，不能防御从最新读取中复制 claim 的恶意进程内
调用方。结算（`withResult`）、dispatcher 状态迁移和 dispatcher 上报的
`UNKNOWN` 结果都走这条路径，因此在受隔离路径上，租约过期或被接管后的旧
owner 无法结算或修改执行。

受隔离路径同时强制迁移合法性：写入不得把 execution 倒退回 `PREPARED`，
且只有已处于 `DISPATCHING` 的记录才能被改写为 `DISPATCHING`。合法迁移为
`PREPARED` → `DISPATCHING`（认领）、`DISPATCHING` → `EXECUTING`
（dispatcher 在 Runtime 可能物理启动 Tool 调用之前先标记记录——正是这个
顺序使接管后的 `DISPATCHING` 记录可以安全地重新派发）、`EXECUTING` →
`CANCEL_REQUESTED`、`DISPATCHING` / `EXECUTING` / `CANCEL_REQUESTED` →
`SETTLED` 或 `UNKNOWN`，以及 `UNKNOWN` → `SETTLED`（恢复）。其余迁移一律
被 Repository 拒绝。

派发所有权只能通过 `claimDispatch` 和 `renewDispatch` 转移。有效 claim 排斥
其他 owner；过期后新 owner 递增 generation，使旧 owner 的更新失效；该接管
规则只适用于执行从未到达 Runtime 的记录。接管 `EXECUTING` 或
`CANCEL_REQUESTED` 记录不会重新派发：物理 Tool 调用可能仍在运行，因此记录
转为 `UNKNOWN`，保留过期 claim 供对账，且不授予所有权。`UNKNOWN` 记录不能
claim 或续租。租约是否过期由 Repository 的时钟判定；多实例适配器必须在
数据库内判定，而不是在应用进程内判定。

开放路径是 `requestCancel`，只凭记录 version 即可记录取消意图，因为取消来自
派发所有权之外。`PREPARED` 执行立即以 `cancelled` 结算，因为不存在能观察到
该意图的 dispatcher。`DISPATCHING` 记录保持原状态，使 claim 持有者看到标记
后不得开始物理执行。`EXECUTING` 记录转为 `CANCEL_REQUESTED`。对 `UNKNOWN`
记录，取消只会记录意图（置位标记、递增 version）而不结算，因此正在进行中的
`resolveUnknown` 快照会失效、必须重新读取。在 claim 持有者以真实结果或物理
停止证据结算之前，取消意图只是建议性的。

恢复路径是 `resolveUnknown`，也是离开 `UNKNOWN` 的唯一出口。它要求完整不可
变身份、当前记录 version 和 `UNKNOWN` 状态，且刻意不需要派发 claim：被接管
栅栏置为 `UNKNOWN` 的记录，其 claim 按构造已过期，因此适配器不得为它追加
租约谓词。结算后的记录保留最后一次 claim 供对账。

已结算记录必须包含允许的 execution status、结果和结算时间，并且结算后不可变。
结果 sequence 不能倒退。活跃 execution 查询以 Runtime Session 为范围，并排除
已结算记录。

## 并发边界

`InMemoryToolExecutionRepository` 对所有复合操作进行同步。它是单进程参考实现，
不是多 JVM 协调机制。后续 JDBC 适配器必须通过数据库约束和行锁保持相同的身份、
幂等、version、租约、迁移合法性和 fencing 语义。

## 安全与租户

记录保留可信 Broker 层提供的 binding 和 Session 身份，但自身不鉴权 tenant 或
workspace 值。调用引用与结果属于 Broker 私有载荷；若没有独立的投影和脱敏契约，
不得记录到日志或作为公开 API 资源暴露。

## 验证

- 同一幂等键的并发创建收敛为一次 execution。
- 有效派发 claim 排斥其他 owner；对从未到达 Runtime 的记录，过期 claim 只能
  以更高 generation 被接管。
- 结算与 dispatcher 变更要求调用方出示存储的 owner 与 generation 且租约未过期；
  即使 version 匹配，出示旧 generation 的旧 owner 或从未认领的调用方也会被拒绝。
- 状态迁移不得倒退回 `PREPARED`，且只有 `DISPATCHING` 记录才能被改写为
  `DISPATCHING`；dispatcher 自报的 `EXECUTING` → `UNKNOWN` 保持合法。
- 接管已过期的 `EXECUTING` 或 `CANCEL_REQUESTED` claim 会将 execution 标记为
  `UNKNOWN`，而不是重新派发；只有 `resolveUnknown` 能将其结算。
- 取消意图不依赖派发 claim，未派发的 execution 立即结算，意图在所有权接管后
  保留，且后续 replacement 不能清除该意图。
- 结果 sequence 在创建时与 compare-and-set 中都不得倒退。
- execution 结算后从活跃 Session 计数中移除。
- 重复幂等键返回原身份，供调用方检测冲突。
- 使用 Java 21 运行 Maven 测试、Checkstyle 和 package verification。

## 验收标准

- Repository 不会为一个幂等键创建两条记录。
- 不能使用过期 generation 续租或修改派发所有权。
- 在受隔离路径上，不出示存储的派发 owner 与 generation 的调用方不能结算或修改
  execution。
- 已过期的 `EXECUTING` 或 `CANCEL_REQUESTED` claim 转为 `UNKNOWN`，而不是新的
  派发。
- 不持有派发 claim 也能记录取消意图，且意图在所有权接管后保留。
- 不可变 execution 身份不能通过 compare-and-set 被替换。
- 已结算 execution 不能再被修改或重新激活。
- 结果状态、sequence 和结算约束失败关闭。
- 内存 Repository 边界不引入 JDBC、Runtime transport、Hosted Harness、Spring
  或公开 API 依赖。

## 后续工作

该契约的 JDBC 实现见 `JdbcToolExecutionRepository`，参见
`managed-runtime-broker-jdbc.md`。Runtime 派发集成在响应不明确后必须查询原
`executionCallId`，不能重放 Tool 调用。
