# Managed MCP 保留生命周期

[English](managed-mcp-retention-lifecycle.md) | [简体中文](managed-mcp-retention-lifecycle.zh-CN.md)

## 问题与当前实现

Issue [#13883](https://github.com/QwenLM/qwen-code/issues/13883) 描述原始 stream-capture 回收器的 P2 后续工作。其 10 月 11 日基线
早于共享 schema 整合。在 `main` 的 `06efd789b1` 上，回收器已经覆盖
`PUBLISHED` 和 `REFERENCED` 两种状态的不可变 `MYSQL_INLINE` 资源，不再限制
kind。新增 MCP 回收器或扩展 kind 白名单会重复已有实现。目前缺少的是生产者专属
的生命周期见证，以及对引用闭包契约的准确说明。

Hosted 生产者发布 `managed-mcp-catalog`、`managed-mcp-arguments` 和
`managed-mcp-response`。事务还会发布 `managed-mcp_configuration` 和
`managed-mcp_operation` 记录体。这些是私有 MCP 记录；设置
`csi_guard = TRUE` 的私有 CSI Session 仍不参与此回收器。

## 契约与决策

MCP 配置与操作的引用仍然只允许设置一次。提交时会重读所引用资源的闭包；缺少任意
资源体会拒绝整个提交。重新打开持久记录库后，必须返回完全相同的 catalog、参数、
结果、操作身份和连接释放状态。MCP 调用完成或连接已释放本身都不能让字节变得可回收。

Session 的永久退役仍是保留根。配置的删除宽限期过后，现有回收器会重新检查已删除
的 writer head、读租约、恢复保护和未解决的对象写入。在同一受栅栏保护的事务内，
有界退役批次会在任何字节页执行前删除 Session 记录 owner 和 journal owner。
因此 Session 存活时，回收器不能删除仍然可达的 MCP 资源体。受恢复保护的 Session
保留其证据，包括结果未明的操作；退役不会把未知调用改成成功，也不会重放调用。

这些 owner 释放以后，通用回收器才可以清空无引用的 SQL 资源体。
`ma_resource_ref` 按 `resource_key` 检查，而非只检查退役 Session 的作用域。
资源身份、摘要、原始长度和 `COLLECTED` 墓碑仍然保留；`collectedBytes` 对各个
原子页实际清空的字节只计数一次。重启后从持久回收游标继续。退役后的鉴权读取继续
返回既有的 `tool_output_session_retired` 结果。

连接 drain/release 收据与 Runtime 所有权是生命周期层负责的前置条件。此见证提交
配置的全部四个释放状态（`active`、`releasing`、`drained`、`released`），不放松
状态转换规则。它不会引入绕过物理释放或结算未知外部效果的路径。

## 验证

回收器测试使用共享 MCP 契约 fixture，经由真实 Session 事务库提交 MCP 配置和
操作的状态转换。测试证明缺少结果体会回滚、重启记录读取器能恢复完整原始证据、
存活 Session 保留所有资源体、仅释放连接不会回收，以及永久退役先释放 owner，
随后字节回收页才清空资源体。测试将完整 SQL 字节总量与回收账本比较，以新回收器
重试，并证明默认关闭的开关同时保留字节与 owner。同一组继承用例通过
`SessionResourceCollectionMySqlIT` 在一次性 MySQL 8.4 数据库运行。

全局 CLI 不暴露内部 SQL 回收调度器。先检查其可用性，再以生产者、事务和退役测试
作为这一服务端生命周期的替代验证。这不代表 Hosted 进程崩溃或部署验收通过。
物理 GC 开关继续默认关闭；[#13090](https://github.com/QwenLM/qwen-code/issues/13090) 的部署门禁仍然适用。

## 范围与验收

此变更新增测试并纠正历史文档，不改变 schema、线协议、生产谓词或默认值。它补齐
[#13883](https://github.com/QwenLM/qwen-code/issues/13883) 中生产者专属的 SQL 生命周期证据缺口。本地文件系统保留、外部 MCP 对象存储
结果、Hosted 部署验收，以及媒体与共享输出后续 [#13884](https://github.com/QwenLM/qwen-code/issues/13884) 仍是独立范围。
