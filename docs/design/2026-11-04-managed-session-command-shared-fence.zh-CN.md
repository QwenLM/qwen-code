# Session 命令准入使用共享的存储 fence

[English](2026-11-04-managed-session-command-shared-fence.md) | [简体中文](2026-11-04-managed-session-command-shared-fence.zh-CN.md)

## 问题与现状

[锁范围设计](2026-11-04-managed-lock-scope.zh-CN.md)把存储 fence 检查拆成两种：只读准入在
MySQL 上加共享锁，存储写入方保留排他锁。Turn 准入、改名与 mutation 准入、普通 journal
commit 以及内联工具结果都已使用共享形式。还有六个 Session 命令准入使用排他形式，因此同一
存储上的所有 Session 在只是检查存储是否可用时，也要在其别名行和目录行上排队：

| 准入           | 调用                                                    |
| -------------- | ------------------------------------------------------- |
| MCP 管理检查   | `AgentSessionPolicies.requireMcpManagement`             |
| 扩展管理检查   | `AgentSessionPolicies.requireExtensionManagement`       |
| 模型与审批修改 | `AgentSessionPolicies.requirePolicyChange`              |
| 上下文压缩     | `AgentExecutionOperations.beginContextCompression`      |
| 任务取消       | `AgentExecutionOperations.beginTaskCancelOperation`     |
| action 响应    | `ManagedActionStore.admit`（经由 `requireSessionOpen`） |

## 设计

六处都改为调用 `requireOpenForAdmission`；action 响应调用新增的
`requireSessionOpenForAdmission`，它像 `requireSessionOpen` 一样解析 Session 的存储。在 H2
上两者都保留排他锁兜底。

锁范围设计的规则对这六处都成立：检查之后，事务不会再更新或以排他方式锁定同一别名行或
目录行。它们写的是 Session 行、命令回执、操作行以及 journal 相关的行。
`requirePolicyChange` 只被模型修改和审批修改调用；MCP 与扩展检查在各自的只读事务中执行。

fence 写入方（迁移 prepare、物理 fence、维护）以排他方式锁定这些行，因此它仍会等待所有
已准入的命令，然后关闭准入；任务取消和 action 响应会创建迁移统计的工作，迁移 prepare 基于
已提交数据的空闲检查能看到它们。

## 保留排他锁的路径

- `JournalWriterLifecycle.lockPublicationWriter`：回执车道
  （`ToolPublicationAdmissionStore.commitReceipt`）在同一事务中 commit，而带生命周期授权
  或 CSI original 的 commit 使用排他形式。这里改为共享锁会在同一事务中从 S 升级到 X，两个
  这样的事务落在同一存储上会死锁。
- 生命周期 begin 与完成、Session 创建（之后的 worktree 准入会以排他方式锁定同一行）、
  writer 获取、存储注册、成员关系、维护、恢复与迁移。

## 风险

- 若以后的改动让这些事务写入被检查的存储行，就会引入 S 到 X 的升级。锁范围设计的不变量
  （也写在 `requireSessionOpenForAdmission` 的代码注释中）明确了这条规则。

## 验证与验收

1. `ManagedLockScopeConcurrencyMySqlIT`（MySQL）：一个事务持有某存储上一个 Session 的
   Session 级只读准入时，同一存储上另一个 Session 的准入能够完成，而 fence 写入方要等第一个
   事务结束。
2. 现有的模型、审批、MCP、扩展、上下文压缩、任务取消、action、迁移准入与锁契约测试继续
   通过，包括 CI 中的 MySQL profile。
