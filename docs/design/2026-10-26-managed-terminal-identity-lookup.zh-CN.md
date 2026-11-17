# Managed activation 与 inbox 终态身份查询

[English](2026-10-26-managed-terminal-identity-lookup.md) | [简体中文](2026-10-26-managed-terminal-identity-lookup.zh-CN.md)

## 问题与当前状态

Issue [#13184](https://github.com/QwenLM/qwen-code/issues/13184) 跟踪 Managed 状态增长。[有界保留设计](2026-10-19-managed-session-bounded-retention.zh-CN.md) 要求先提供持久历史身份查询，再允许终态离开内存。本次是该剩余工作的 PR1。

`FileManagedActivationStore` 与 `FileManagedSessionInbox` 已在权威 journal 和快照中保留终态结果。打开存储会在内存重建全部身份。重复准入查询这些驻留 Map，尚无按身份读取持久终态的路径。Activation/inbox 转换压缩并不约束终态身份数量。

这两个适配器要求单进程、本地 owner。消费者为 `EmbeddedHarnessScheduler` 与 `ManagedPromptAdmissionController`，两者均未接入公开 Hosted 应用。原生 HTTP Session journal 是另一个存储。本次不宣称 Hosted 服务内存或启动读取量已经有界。

## 目标与范围

- 按 tenant、Session 和 activation/message 身份物化并读取完整、不可变的终态结果。
- 保留原始规范化数据、排队/准入位置、时间、结果、取消状态和 processing fence。
- 保持准确重复重放与身份冲突拒绝，包括当前准入容量已满的情况。
- 在不改变终态提交确认的前提下，建立有实际消费者的持久查询路径。

内存淘汰、身份过期、journal 删除、原生 Session 快照、Java/HTTP API 与自动完成 inbox 留给后续工作。驻留 Map 和现有同步查询保持不变。

## 方案

### 权威与索引布局

现有 journal 仍是唯一权威。相邻的 `<journal>.terminal-identities` 目录保存派生的不可变记录。文件名为 JSON 编码身份元组 `[tenantId, sessionId, activationId/messageId]` 的 SHA-256。Activation 与 inbox 记录分别位于各自 journal 旁，并包含不同的记录 kind。

每条 version-1 记录包含 kind、完整身份元组、原始终态快照和快照的 SHA-256 摘要。编码使用 journal 派生的原始快照，不使用重试请求的属性顺序。读取必须匹配完整的规范化预期记录，包括身份、类型与摘要。只有已验证的 journal 终态才能重建缺失文件。损坏或冲突文件使查询失败，不能视为新身份或静默覆盖。

孤立的旁路记录不能建立 journal 中不存在的身份、覆盖活跃状态或恢复缺失的 journal。索引不是独立权威。未来淘汰前必须先引入持久完整性/发布边界；仅有这些文件还不允许淘汰。

### Read-through 与实际消费者

两个适配器均暴露异步 `readTerminal` 查询。查询进入现有串行队列，验证并捕获请求身份，对 journal 中缺失或非终态的身份返回无结果。对已知终态读取或物化按 key 记录，再返回原始快照的克隆。

`enqueue` 与 `admit` 的既有重复路径，在完成现有规范化、容量参数校验和深相等冲突判断后，对终态使用同一 read-through。非终态重复保持原路径。属性重排与数值规范化仍使用现有语义比较，请求 JSON 字节不充当幂等 key。

这也保持 reconciliation：未完成 inbox 重新提交一个已释放 activation 时返回原 activation，不会再次排队执行副作用。Reconciliation 仍不自动完成 inbox。

### 发布与失败行为

只在终态查询或重复重放期间物化索引。`release`、`cancelQueued`、`finish` 和取消操作继续只提交原 journal。因此，索引写失败不能把已提交的终态操作转成一次对外报告的 release/finish 失败。

索引目录使用 `0700`，记录使用 `0600`。父目录与索引目录必须是真实目录，叶子读取复用现有 no-follow opener。有界读取先检查预期记录长度，再分配缓冲区。这些检查保持可信单 owner 边界，不证明能隔离恶意同 UID 进程。

记录先写唯一 pending 文件并 flush，再以独占 link 发布最终文件名，随后在受支持平台同步目录。最终文件已存在时读取并验证，不能覆盖。正常清理删除 pending 文件，查询从不把它当作结果。崩溃可遗留被忽略的 pending 文件；反复进程崩溃可能积累这些文件，孤儿回收留给后续工作。

查询失败直接拒绝，不改变权威 journal、准入计数或驻留结果。派生文件缺失时后续查询可重建；冲突/损坏仍持续拒绝。不引入新的可用性降级或终态转换重试行为。

## 受影响组件

| 组件                                 | 改动                                          |
| ------------------------------------ | --------------------------------------------- |
| `managed-terminal-identity-store.ts` | 共享派生索引、有界校验与不可变发布。          |
| `managed-activation-store.ts`        | 串行终态查询与已释放身份的重复 read-through。 |
| `managed-session-inbox.ts`           | 串行终态查询与已完成消息的重复 read-through。 |
| 定向 store/admission 测试            | 持久化、规范化、拒绝、故障与 reconciliation。 |

不增加依赖、配置开关、迁移或公开协议。既有 version-1 journal 与 version-2 转换快照仍可由新旧代码读取。旧代码忽略相邻索引；PR1 保留全部权威身份，因此兼容。

## 验证与验收

- 先确认全局安装的 CLI 无法暴露这些内部适配器 API，再以直接适配器脚本执行基线与本地验证。
- 对 completed/failed activation、排队取消、已完成 inbox 消息和无 processing fence 的取消，验证进程重启后的查询与原结果重放。
- 验证规范化/属性重排的 payload 重试、不同 payload/descriptor 的身份冲突、tenant/Session 身份隔离及准入满时的重复请求。
- 删除索引记录，证明由原 journal 终态重建；损坏或替换记录，证明拒绝查询且不产生第二次准入或副作用。
- 注入 pending 写、file-sync、发布和 directory-sync 失败。验证终态 journal 操作的确认独立不变、重试保留原结果、pending 从不成为权威。
- 验证对已释放 activation 的 reconciliation 不会产生第二个排队 activation，并保持现有 FIFO/epoch/fence 测试。
- 以严格未处理拒绝检查运行受影响包测试，完成 build、typecheck、bundle、改动文件 lint/format、连续两轮干净自审和独立审查。

验收目标是具有实际重复路径消费者的持久按 key 终态查询。本 PR 不宣称服务内存为常量、启动重放有界、物理历史回收完成或归档查询可独立充当权威。

## 风险与后续

索引在磁盘上重复保存终态字节，并为终态重复重放增加 I/O。记录含有私有 inbox payload，因此目录保持本地私有。索引损坏可使重复查询失败，即便 journal 仍有效；本次不做自动破坏性修复。

内存淘汰前，需持久化完整性边界，证明哪些终态身份已具备安全持久查询结果，并迁移历史消费者，定义淘汰后的崩溃恢复与索引缺失行为。原生快照/HTTP/本地重放及 authority 窗口仍属后续 PR。完整 #13184 保持开放。

## 开放问题

该本地索引切片没有待定选择。归档权威、淘汰和回收的决策留给后续。
