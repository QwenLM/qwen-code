# Managed Agent 首发契约清理

[English](2026-10-23-managed-first-release-contract.md) | [简体中文](2026-10-23-managed-first-release-contract.zh-CN.md)

## 状态与范围

已实施并进行本地验证；发布验收仍需完整 CI 门禁。Managed Agent 尚未正式发布，因此本次支持全新状态，以及同一版本的
Server、Broker、Harness、WebShell 和 Managed SDK。不迁移开发数据库，不改写已保存的命令。
既有环境应保留原制品和状态，或另建独立的全新环境。

## 问题

当前实现保留了无生产调用者的适配器、旧 checkpoint 结构、历史结果回填、混合版本授权路径，
以及同一个 durable command 的多种响应方式。这些分支增加首发契约的复杂度，却没有需要兑现的正式版本兼容承诺。

## 决策

删除无调用者的 Runtime Provider 包装，保留共享错误类型与 Broker client 的消费者。
Session authority 打开时必须提供 journal，checkpoint 使用完整的可空字段结构。
MCP close 必须先持久化 drain receipt 再释放原 owner；缺失 receipt 不能被视为清理成功。
Prompt digest 只使用规范化的发送字节。

删除历史 O3 回填、缺失 recorder stamp 的宽松命令授权、旧 rename 状态、废弃转发类和旧 WebShell 表示。
当前 journal commit 仍原子捕获工具结果。保留 reader lease、幂等性、writer generation 和未知结果对账。

Public 与 WebShell 的 Turn submit/cancel 始终返回持久化 operation，不再通过 admission profile
或部署开关隐藏它。Session 创建及内部 child 响应保留各自的结构。
Session 分页只保留一种同时绑定 archive state 和规范化标题查询的格式，归档筛选只保留一个参数名。

将当前 schema 合并为一个首发基线。Managed Agent 首次正式发布前，直接修改 V1，不新增 V2+ 迁移，
也不递增数据库 schema 版本；基线变化后重建开发数据库。Server 和 Broker 验证同一套最终列、索引与约束。
保留 Broker 先初始化的启动顺序支持，在写入前拒绝外来、部分初始化及系统数据库。
不保留从早期开发基线升级的路径。

Publication 授权使用当前 activation head 字段。删除 journal 回退前必须确保当前 activation 输入
能够完整表示于这些字段；非法或过期证据必须拒绝。保留原始 intent、有效期、作用域与 writer 检查。

## 边界

普通 daemon 执行、未绑定 Session、文件/Shell/MCP/CSI 能力及 lifecycle 协议，在仍有当前生产者时继续保留。
内部 child 的 owner 回退保留到所有当前写端都明确写入 owner。
不同 namespace 的协议版本号不能互换。本次不修改用户数据库、运行中的服务或已有 Session。

## 验证与验收

执行根目录 build/typecheck、受影响的 Core/CLI/WebShell 测试，以及 Managed API/OpenAPI 一致性检查。
验证 checkpoint 往返、当前格式冷恢复、MCP close 崩溃窗口、重放授权、规范化 digest 字节、
响应丢失后的 durable cancellation，以及分页筛选隔离。

验证两种启动顺序的全新 schema 初始化与重启、约束负例和不兼容数据库拒绝。
SQL 行为必须使用真实 MySQL 8.4，H2 不能替代。Java 本地工作共享模块规定的十分钟验证预算，
完整 suite 和 Hosted/fault profile 留作 CI 门禁。未完成或环境不可用的检查要明确记录，不能声称已验收。

验收要求生产代码不再引用被删除的适配器或旧格式成功路径，当前格式消费者完整，恢复与归属语义保留，
受影响检查通过。最后一次修复后完整审视 diff 两轮。实际结果单独记入执行报告，与本设计区分。
