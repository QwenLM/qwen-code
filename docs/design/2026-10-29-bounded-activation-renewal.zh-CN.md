# 有界的 activation 续租

[English](2026-10-29-bounded-activation-renewal.md) | [简体中文](2026-10-29-bounded-activation-renewal.zh-CN.md)

状态：已在本地实现，完整 CI 验收待完成。

## 问题与范围

空闲的 SQL Hosted Session 目前每隔 activation 租期的三分之一就追加一条完整的 `renewActivation` 事务。历史预览数据包含约 128,000 条事务，其中 97.3% 为续租。最新存活状态必须持久化，但无需为每次心跳保留独立事件和提交标记。本地 JSONL 存储保留既有日志协议。

## 决策

保持不可变的会话事件、提交摘要和日志位置不变。在 `ma_session_journal_tx` 现有 activation 事务行上，用可空元数据保存最新续租序号和有效期。每个 activation 最多由一条事务保存其当前续租元数据。同一 SQL 事务更新对应的 `ma_session_head.activation_expires_at` 投影。不新增表或 schema 版本；按既有策略原位修改尚未正式发布的 V1 基线，并重建开发数据库。

内部 writer 续租请求可以同时续租指定 activation。服务端在 writer grant 中声明支持能力。HTTP journal 使用该能力；旧服务端和本地 journal 保留事件式续租。Activation 安装、释放、撤销、接管仍写日志事件。续租元数据随所属日志事务一起删除。

## 所有权与失败语义

该操作属于现有持久化 Session writer 路由。保留租户、Workspace、凭证、placement、生命周期、writer 身份、generation、恢复状态和 CSI continuation 校验。先锁定当前 head，再修改两处投影。续租必须绑定当前 active activation ID、epoch 及其原始事务，不能复活已释放、替换或被隔离的 activation。新有效期使用数据库时间。重复的续租序号返回持久化结果，跳号或回退则拒绝。响应结果未知时，以同一序号重试，之后 authority 的工作才能观察新租约。

续租不推进 committed sequence、journal revision、UUID 链、命令重放历史或 checkpoint revision。恢复时在从不可变字节重建的 activation 上叠加经校验的当前租约元数据。前缀读取不能借用其范围之后的租约。已有原生日志快照保持不可变；当前租约状态从权威 restore head 取得。

## CSI 与历史证据

CSI 继续验证每条不可变原生事务及其摘要。在解析 activation 事务后，仅应用格式正确、单调推进且绑定该事务的租约元数据。这样保留校验后续执行记录所需的有效期，包括接管后的验证。实时 JDBC 重放和已保存应用的重放应用相同规则。规范化应用清单纳入该元数据，使退役过程冻结并验证实际租约证据。不删除授权检查，也不改用进程本地时钟作出授权判断。

## 验证与验收

- 复现当前连续 100 次空闲续租会增加 100 条日志事务。
- 启用能力后，相同续租推进持久化 activation 有效期，而日志行数、committed sequence 和摘要保持不变。
- 从持久化 head 恢复最新租约，包括原生快照早于最新续租的情况；保留旧服务端和本地 JSONL 行为。
- 覆盖重复响应、确认丢失、服务中断、旧 generation、释放和替换竞态、损坏元数据及非法续租序号。
- 通过针对性测试验证 CSI 实时与历史重放、终态退役及原生 schema 清单。
- 运行受影响 TypeScript 测试和根目录 build/typecheck。在模块共享的十分钟本地预算内选择 Java/H2 和真实 MySQL 8.4 检查，单独报告完整 CI 和无法运行的集成路径。

本变更不重写、压缩或部署现有预览数据库。历史行继续保留到正常生命周期清理；释放已有磁盘空间属于独立运维操作。
