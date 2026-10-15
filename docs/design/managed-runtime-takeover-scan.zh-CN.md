# Managed Runtime 接管对账扫描（G2）

[English](managed-runtime-takeover-scan.md) | [简体中文](managed-runtime-takeover-scan.zh-CN.md)

## 问题与范围

Issue #12952 G2 要求替代 Broker 在接管持久 Runtime Session 时对账执行记录。
目前获取会话仅恢复 Session，不检查执行记录；显式对账器只接受 UNKNOWN。
本次覆盖 Broker、内存和 JDBC 账本及恢复测试。G0/G1 准入、Harness 粘性、
周期扫描及多实例控制面策略仍属独立范围。

## 设计

原绑定完成接管与身份验证后，获取持久 READY Session 会扫描可能已派发的执行：
EXECUTING、CANCEL_REQUESTED 和 UNKNOWN。PREPARED 与 DISPATCHING 尚未
跨过持久派发边界，保留现有显式 start/retry 行为。扫描不会启动工具或认领派发。

账本每页最多返回 100 个候选，范围同时限定 binding、generation、Harness Session
和 Runtime Session。键集分页按执行 ID 哈希排序，与 JDBC 现有主键一致。
每条访问过的记录（包括未解决记录）都推进游标，避免不可用的证据使后续页饥饿。
各页顺序处理；每次 status 使用现有 operation lease 超时，同时最多一个查询。
接管总耗时随候选数量增长，但每页内存与单次查询时长有界。

查询使用已接管原代数的已验证路由，并复用现有 status/result 校验。
有效 settled 结果以原子 identity/version/state 检查提交，保留 dispatch owner、
generation、lease、取消意图和事件序号，不先将记录 fence 为 UNKNOWN。
现有仅支持 UNKNOWN 的仓库 API 保持原契约；单独的证据结算操作接受上述三个
扫描状态。并发终态写入优先，绝不覆盖。

Runtime 不可用、回答非法或回答未终结时，执行保持未结算。这些状态已经阻止
再次派发：过期 EXECUTING 和 CANCEL_REQUESTED 在显式重试时变为 UNKNOWN，
UNKNOWN 从不派发。存储故障使接管失败，而非假装扫描完成。
关闭 Broker 后停止后续查询和迟到的结算写入。

每条成功结算均在下一次查询前持久化。获取会话中断后重新枚举；已终态记录
被排除，不重复查询。未解决记录可在后续接管时再次查询。不需要持久扫描表、
定时器、公开路由或运维游标。

## 消费者与约束

`RuntimeBrokerService.acquire` 是 `RuntimeBrokerHttpServer` 和嵌入调用方使用的
接管入口。私有 acquire 路由仍限定于解析后的 Runtime Session。
`ToolExecutionRepository` 有内存、JDBC 实现及测试包装器。共享 JDBC 契约也在
Managed Agent Server 的 Flyway schema 和 MySQL 上运行，无需修改 schema。
普通 CLI 存储与 Hosted 公开准入不变。

## 验证与验收

- 接管通过原代数有效证据结算，不 execute、不 claim、不写中间 UNKNOWN，
  包括已过期 claim。
- 不可用、非法与未终结证据继续阻塞；显式重试不能再次执行这些调用。
- 即使前面的记录未解决，也能访问超过一页的记录。
- 中断后替代 Broker 跳过已持久结算的记录。
- 排除其他 Session 与代数；过期 version/identity 及并发终态写入不能覆盖回执。
- 运行 Broker 定向测试、JDBC 契约测试、build、typecheck 和 bundle；
  执行独立验证及多轮正向、反向 diff 审计。

## 待定问题

G2 范围内没有待定项。周期重试策略，以及配套持久调度器的接管总时限，延后处理，
不扩入本切片。
