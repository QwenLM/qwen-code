# 私有 CSI 的 Managed Agent 写入边界

[English](2026-10-10-k2-managed-agent-mutation-boundary.md) | [简体中文](2026-10-10-k2-managed-agent-mutation-boundary.zh-CN.md)

状态：K2 写入准入收口的拟议增量，2026-10-10，基于
`5e8dc04f9a8c2837bae29eff33598e7eb0d5f88d`。关联 #12380、#13395；
实现归入 Draft PR #13526。

## 问题与当前状态

私有 CSI CREATE 持久化不可变的 `csi-files-retirement/1` profile 和
`runtime_request_key`。其 Hosted producer 使用私有原生 Session Store、
Broker 和 worker 路径，不使用旧 Managed Agent 的 turn、operation、dispatch
或消息投影写入路径。公开选择入口仍关闭。公开 service 检查已拒绝子会话创建
和通用生命周期操作，但没有覆盖每个直接 store writer。例如，事件追加、
replay floor 和 materialization 更新可以绕过原 CSI parent fence 修改私有
Session。构建 K2 退役流程期间，旧写入路径不应接纳这些修改。

生成列 `managed_agent_session.csi_guard` 在持久化 profile 是私有 CSI，或
不可变 request pin 非空时为 true。生产代码不会在 CREATE 后修改这两个来源
字段。该判别器是排除边界，不是原 binding、activation、result 或退役状态的
证明。

## 决策与实现

在 `ManagedAgentStore` 每个既有 Session 写入入口的第一次修改或子对象写锁
之前明确拒绝私有 CSI（指该入口自身将获取的子锁，嵌套回调可能已持有外层锁）。使用 `(tenant_id, session_id, csi_guard)` 上精确的
TRUE 当前锁定读取；MySQL/MariaDB 强制使用已有唯一索引，与原生 guard 的
负向 probe 契约一致。probe 查询超时为十秒，每次修改增加一次固定查询；
materialization 预算按每批一次计数，保留已有逐事件查询和快照写入限制。
普通 Session 的 FALSE 行不被选中。方法已获取
placement domain 时，保持先获取该 domain、后执行 probe 的顺序。probe
不会在 Session 锁之后获取 placement domain。

返回语义 HTTP 409 `csi_managed_mutation_unavailable`。在 binding provision
之前，以及 READY、DRAINING 和终止状态，均拒绝私有行：这组旧路径没有已经
验证的 CSI 延续操作可以接纳。profile 改变但 request pin 保留时仍拒绝。
不能将检查放入共享的私有 CREATE request reader，因为 reader 必须继续验证
原 pin。子会话创建和重放保留已有明确拒绝契约。

覆盖 turn 准入和取消、展示信息修改命令、生命周期和 cwd 准入及完成、
operation 投递、turn lease/dispatch/admission/recovery、输出回撤和事件追加、
投影及 replay floor 写入。为现有单语句 turn lease/retry 方法增加 Spring
事务边界，使当前 probe 与更新处于同一事务。只读查询仍可使用。后台投影、replay floor、turn dispatch 和 operation delivery 发现查询跳过私有行，
避免私有 backlog 占满一页并阻塞普通工作；写入 guard 仍处理陈旧发现结果或直接调用。

## 范围与锁边界

本增量仅修改旧 Managed Agent store、相关测试及这组关联设计文档。不增加
schema、公开 CSI 选择入口、新 capability、新退役状态或物理操作。原生 CSI
写入继续使用现有完整的 parent/binding/history 证明。旧创建入口不会创建私有
profile；私有 CREATE 和 pin reader 保持独立。

TRUE probe 是拒绝机制，不是原 membership 认证。它不验证 profile 普通且
pin 为空，但存在矛盾 CSI slot history 的 Session。完整退役 inventory 仍必须
识别该矛盾。Retention collector/read metadata、extension/action/result store
以及原生 cut/finalizer writer 仍需各自完成审计与收口。本批不能证明聚合
`DRAINED`、writer 终止、NodeUnpublish、`RELEASED` 或卷复用。

## 验证与验收

先尝试全局安装的 CLI，记录公开 CLI 无法到达该私有 Java 写入路径的事实。
随后使用真实私有 CREATE producer 和当前 Flyway schema，通过 JDBC
测试脚本复现。实现前复现无 guard 的事件追加，观察全部受影响行的前后
变化。fixture binding 和时钟过期都不是退役授权。

实现后验证每个受保护入口均在修改之前拒绝，包括子行不存在的情况，并确认
相关表的完整快照不变。验证 profile 不同时，保留的 pin 仍触发拒绝。验证
普通 Session 的事件追加、投影和 turn lease 行为，以及私有 CREATE 的重放
和 request 读取。独立验证当前读取争用；H2 检查不能替代 MySQL 隔离级别验证。
运行相关 Java 回归、Java 打包及静态分析、仓库 build、typecheck 和适用
bundle 检查。完整 diff 自审两轮，并进行独立审查。

本增量以稳定拒绝且不破坏普通行为为验收标准。完整 K2 仍为进行中，直到其余
writer、不可变 cut、物理终止、精确 CSI unpublish、原子 release/reuse、
公开接入和 Linux/云上验证全部实现并完成验证。
