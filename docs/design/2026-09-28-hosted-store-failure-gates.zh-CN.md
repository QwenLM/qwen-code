# Hosted Session Store 故障门禁（FG6b）

[English](2026-09-28-hosted-store-failure-gates.md) | [简体中文](2026-09-28-hosted-store-failure-gates.zh-CN.md)

## 问题与范围

Issue #12872 要求用可执行证据证明 Hosted Workspace 工具遵守 Session Store
提交边界。FG6a 覆盖 Broker 回复丢失；FG6b 覆盖 Store 失败和提交已生效但回复
丢失。本变更扩展现有打包 Harness → Spring Store → 真实 MySQL/MariaDB 和
Broker → worker fixture。不实现崩溃恢复、自动工具重放、shell 工具、provider
故障或后续 FG6 门禁。

## 当前行为

发布资源只在 Harness 暂存字节，首次引用资源的事务才将字节发送到 Store。因此
工具参数和 `tool.intent` 共用一个原子 HTTP/SQL 事务。Broker prepare 先于该
提交；prepare 只预留执行，不运行工具。`await_runtime` checkpoint 必须在
Broker start 前提交。

执行后，Harness 先提交工具结果消息，再提交包含 outcome 资源的 `results_ready`
checkpoint。写入失败或未收到确认会停止该 authority 的后续写入，活动会话阻止
新 prompt。已经生效的终态提交仍可由全新 authority 读取持久日志恢复。

## 故障与预期行为

| 场景                | 注入方式                                             | 必须提供的证据                                                   |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `arguments`         | SQL 资源插入拒绝 `managed-tool-input`                | 无 start、无副作用；整个 intent 事务不存在                       |
| `intent`            | 资源插入后，SQL 日志插入拒绝 `toolIntent`            | 无 start、无副作用；资源和引用均回滚                             |
| `await-runtime`     | SQL 日志插入拒绝 `await_runtime` checkpoint          | 无 start、无副作用；checkpoint 事务及暂存资源回滚                |
| `result-message`    | SQL 日志插入拒绝工具结果消息                         | 恰好一次副作用；无后续模型调用或终态                             |
| `result-checkpoint` | SQL 日志插入拒绝 `results_ready`                     | 恰好一次副作用；结果消息已提交；无后续模型调用或终态             |
| `result-reply`      | 转发并完整读取成功的结果消息提交响应，再关闭下游连接 | 恰好一次副作用；冷读取包含一次已提交事务；未完成的 turn 继续阻塞 |
| `turn-reply`        | 转发并完整读取成功的终态提交响应，再关闭下游连接     | 恰好一次副作用；活动会话阻塞，但冷加载恢复已提交的终态 turn      |

所有场景使用非幂等 `edit`（将全部 `x` 替换为 `xx`），意外执行第二次会产生
`xxxx`。Harness 工作目录中的诱饵文件和 Workspace 父目录中不存在的同名文件
共同检查实际执行路径。

## Fixture 设计

复用已保存 Workspace/Session 的初始化和现有 Maven profile。安装名称唯一、
仅匹配生成的 tenant 和 session 的测试 SQL trigger，要求捕获的服务端输出包含
各 trigger 的 SQL 异常标记，避免把无关 HTTP 500 当成有效故障，并在 fixture 清理时删除。
不新增生产路由或 schema。透明 HTTP 代理按事件语义和 checkpoint 资源识别目标，
记录选中的完整事务，并转发原始 tenant 和 writer 凭据。SQL 拒绝与回复丢失是
不同故障：只有实际收到上游提交成功响应后，才丢弃下游回复。

对于回复丢失，直接向 Store 重放完全相同的请求，要求返回原 receipt，且
`replayed: true`。这验证 Store 幂等契约，不为 Harness 新增自动重试。

观察活动会话失败后，停止旧 Harness，等待其短 writer 和 activation lease
过期，再启动全新 Harness 冷加载；失败的 authority 无法可靠提交 detach 所需的
activation release。观察真正返回给新 Harness 的事务。未结算输入必须返回
`hosted_turn_recovery_required`；已提交终态的场景必须加载成功。两条路径都不能
访问 Broker 或重放工具。Activation 记账可以新增事务，因此按原始身份计数，
不能假设整个日志完全不变。

独立 JDBC 断言检查物理副作用、执行身份及 dispatch generation、Workspace
所有权、回滚、提交字节、事件唯一性、日志连续性和持久 head。代理报告仅描述
尝试的操作，不作为提交成功的事实来源。

驱动位于 `integration-tests/helpers/hosted-store-failure-driver.ts`；
Spring/SQL fixture 扩展位于
`packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedWorkspaceToolTurnIT.java`。

## 验证与验收

先尝试全局 CLI 基线；不支持 Hosted 的 CLI 记为不可用，不能作为行为通过的证据。
用新打包 CLI 和真实数据库运行 `hosted-workspace-tools`，保留原正常路径及 FG6a
场景。执行 build、typecheck、相关定向测试、格式和 Java 检查。通过临时 mutation
移除提交顺序、回滚、幂等和恢复保护，要求相应门禁失败；恢复后重跑原始门禁。

验收要求每个选定故障均实际触发，七个场景满足物理和持久化断言，冷加载不重放
工具，并完成连续两轮干净的无方向及反向审计。第五轮之后只接受 Critical 级别的
正确性、安全、数据丢失或回归修复。SQL trigger 需要专用测试数据库中的相应权限；
该 fixture 不应运行在共享生产数据库。
