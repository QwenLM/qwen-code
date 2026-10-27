# Managed Session 状态的有界保留

[English](2026-10-19-managed-session-bounded-retention.md) | [简体中文](2026-10-19-managed-session-bounded-retention.zh-CN.md)

## 问题与范围

Issue #13184 跟踪 Managed Agent journal 与驻留状态的增长。本次变更是
**第 1 片**：压缩本地 activation 与 inbox journal，同时保持身份、去重、租约、
fence、顺序和结果契约。它相对于当前状态约束重复转换与续租记录的数量，
**不**约束已完成身份的数量，也不代表 #13184 已全部完成。

下文将剩余原生 Session journal 与 authority 工作及其依赖标为后续实现。
资源存储限制、已结算 dispatch 淘汰、续租循环停止分别属于配套 PR
#14656、#14657、#14658，不在本次变更范围内。

## 当前状态与边界纠正

Activation store 与 inbox 追加 v1 JSONL 事件，并从 sequence 1 重放。
两者都无限期保留所有身份。即使重建当前状态已不需要较早的转换，
activation 续租与消息的历次 processing fence 仍会在磁盘累积。
目前不存在身份过期或去重时间窗口。

下列三个现有字段描述不同领域，必须保持独立：

| 字段                                                             | 所属层与含义                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ma_event_stream.replay_floor_sequence` 与 `current_snapshot_id` | Java 公共事件投影及不可变 Item 分页快照，不能用于恢复 Harness authority。        |
| `ma_session_head.compacted_through_revision`                     | 原生 Harness journal 压缩位置。目前仍为 0，尚无原生 journal 快照发布或读取端点。 |
| `LocalManagedSessionAuthority.compactedThroughSequence`          | 模型历史 `context.compacted` 摘要的覆盖范围，不是物理 journal 重放下界。         |

之前的提案把公共投影快照视作原生 journal 快照，把上下文摘要覆盖范围视作
物理下界。本文纠正这些假设。第 1 片不修改上述任何字段。

## 目标

1. 用经过完整性校验的当前状态快照和连续尾部替换冗余 activation/inbox 转换。
2. 在压缩、崩溃和重新打开后保留所有已接受身份及其准确重放结果，包括终态。
3. 保持 sequence 位置、Session FIFO、activation epoch、processing fence、
   取消状态、规范化 payload 和结果不变。
4. 替换失败时停止写入，不丢失任何已接受操作。

## 非目标

- 让已完成身份过期、删除 inbox payload，或限制驻留 Map 大小。
- 压缩原生 Session authority journal，或修改公共事件下界。
- 修改 admission、调度器续租或 HTTP 行为。
- 支持同一本地 activation/inbox 文件的多个并发 owner；这些适配器继续要求
  单进程、单 owner。

## 方案

### 快照格式与重放

JSONL 第一条记录可以是 v2 `activation.snapshot` 或 `inbox.snapshot`。
其 `state` 对象由 JSON 编码的 SHA-256 `digest` 保护。各存储在接受尾部记录前
校验快照状态结构和不变量。快照只允许出现在第一条记录。未知版本、摘要冲突、
重复身份、非法顺序、无效 lease/fence 关系都必须拒绝读取。

Activation 快照保留 `nextSequence`、所有 activation 当前状态和完整的
Session `nextEpoch` Map，包括已释放与已取消的 activation，保留原始 queue
sequence，并为 assigned activation 保留最新 lease。Inbox 快照保留
`nextSequence` 和所有消息，包括已完成消息、payload、admission 位置、就绪状态、
取消标志、最新 fence、结果与完成时间。

后续事件保持现有 v1 格式，必须从 `nextSequence` 准确连续。快照不消耗
sequence、epoch、队列或 admission 位置。不支持 v2 的读取器拒绝第一条快照，
不能把保留下来的尾部误当作完整历史。公共方法及返回值保持不变。

### 自动压缩与增长上界

各存储跟踪快照与完整 journal 的字节长度。在新事件追加前，若尾部字节已达到
`max(64 KiB, 快照字节数)`，则执行压缩。旧格式文件的快照字节数为 0，
达到 64 KiB 后即可压缩。只读打开不压缩健康文件。

替换序列化已经持久化的状态，随后才正常追加本次请求。因此压缩错误发生在
请求操作之前，不会把已经提交的操作报告为失败。不追加事件的幂等调用也不触发压缩。

替换后只保留一份当前状态快照。下一次替换前，尾部不超过阈值加一条现有记录
的大小。重写阈值随快照大小增长，避免每追加固定少量事件就重写不断扩大的
身份集合。无论续租多少次，一个存活 activation 都只需最新 lease 和有界尾部。
已完成身份及 payload 仍占据快照空间；这明确属于剩余范围，不能据此声称整个
服务的磁盘或内存已经具有常量上界。

### 持久替换与失败处理

两个存储共享小型快照编解码与原子替换辅助实现。现有通用 atomic-write 工具
存在原地写入回退行为，不能提供这里需要的替换契约。

1. 删除残留的固定 `<journal>.snapshot.pending` 文件。它从来不是 authority，
   也不是恢复候选。
2. 以 `0600` 权限独占创建 pending 文件，写入完整快照，fsync 后关闭。
3. 原子 rename 替换 journal，然后在支持目录 fsync 的平台同步父目录。
   Windows 保留原子替换与文件 flush；Node 在该平台不提供相同的目录 fsync 能力。
4. 仅成功后更新进程内字节计数，再追加新事件。不累积备份链；进程崩溃后
   最多遗留一个 pending 快照。

Rename 前崩溃保留旧 journal，之后崩溃保留新快照；两者描述同一已提交状态。
任何替换错误都会停止该实例，直到重新打开，包括 rename 后的目录 fsync 失败。
打开包含快照的文件时，在允许追加前同步父目录，防止未完成持久化的目录项
之后接受新写入。不完整的快照行必须拒绝，不能修复成空存储。
现有 torn-tail 修复只继续适用于完整快照或旧事件前缀之后的尾部。

## 剩余原生 journal 与 authority 设计

以下是必须完成的后续工作，第 1 片不包含其实现。身份存储和原生快照契约可以
并行开发；快照契约稳定后，HTTP 与本地重放可以并行推进。Authority 窗口
依赖身份存储以及经过验证的两条重放路径。
实现边界及无损首版 payload 见 [PR2 协议设计](2026-10-26-managed-native-journal-snapshots.zh-CN.md)。

PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) 已合入 PR2 分支；[#15569](https://github.com/QwenLM/qwen-code/pull/15569) 将原生快照存储和 [HTTP 恢复](2026-10-26-managed-http-snapshot-recovery.zh-CN.md)一起交付到 main。它们仍是该 PR 内独立的设计与验收切片。本地租约感知恢复、完整历史读取器迁移、紧凑状态与 authority 窗口仍是后续工作；合并交付不启用 journal 删除或内存淘汰。

1. **身份存储：** 从驻留 Map 移除终态前，先把终态正文与去重证据放入可持久查询
   的存储或归档结构。`enqueue` 与 `admit` 对旧 key 仍返回原结果，并拒绝冲突复用。
   TTL 过期绝不能允许重复副作用。Inbox reconciliation 仍须找到对应 activation 结果。
2. **原生快照契约：** 单独增加原生 journal 快照发布与读取契约，包含 writer 的
   tenant/Workspace 范围、revision CAS、lease/generation fence、摘要和完整资源引用闭包。
   快照状态必须同时包含 command replay、authority 索引和执行恢复状态；只有 Harness
   checkpoint 不足以恢复 authority。
3. **原生 HTTP 重放：** 消费原生快照与连续尾部。在删除任何仍可查询的原生事务前，
   迁移 `WakeRecoveryStore`、original-CSI 恢复与资格校验、lifecycle 清理、publication
   证明、工具详情与结果、child relay、恢复导出等消费者。
4. **本地原生重放：** 为 `SessionWriterLease` 增加验证 owner 的替换操作，同时重新
   固定 inode、元数据、rolling hash 与 sealed commit proof。在 journal 适配器中
   直接 rename transcript 会违反当前 lease 的身份校验。先持久化原生快照，再推进
   新的原生重放下界；该下界独立于上下文摘要覆盖范围。
   [PR4 本地设计](2026-10-26-managed-local-journal-snapshots.zh-CN.md) 实现仅一次的
   sealed 恢复转换，保留完整前缀；不实现轮换、GC、紧凑状态或内存/存储有界。
5. **Authority 窗口：** 淘汰前增加持久历史查询或 read-through，并迁移从 sequence 1
   开始的同步消费者。除 `events` 外，还要约束 `transactions`、event ID、receipt、
   checkpoint、domain、extension 索引、Action 和 extension 唯一性证据。
   Approval/model/Plan 选择、wake/cancel 恢复、工具结果、task、hook、automation、
   channel、transcript 投影和 SSE 都必须保持历史查询语义。

[本地终态身份查询切片](2026-10-26-managed-terminal-identity-lookup.zh-CN.md)
增加派生的按 key 查询，并用于终态重复准入。它保留 journal 权威与驻留 Map；
独立权威的归档及完整性边界仍是淘汰前置条件。

## 验证计划

- 在全局 CLI 支持的范围内复现基线；CLI 不暴露这些适配器方法时使用直接存储脚本。
- 比较快照、重新打开前后的全部 activation/message 状态，包括 released/finished
  身份、多 Session、FIFO、epoch 推进、取消消息、pending 工作、准确重试和冲突重试。
- 单 activation 至少续租 1,024 次，单消息重复提升 processing epoch，验证旧转换行
  被替换，最新状态和 fence 在重新打开后仍然有效。
- 注入 pending 写入/fsync、rename、目录 fsync 失败。失败实例必须停止；重新打开后
  已接受状态相同，可安全重试，sequence 连续，且仅最新 fence 有效。
- 拒绝 torn/checksum-invalid 快照、重复快照、重复身份、计数回退、不可能的状态组合、
  不连续尾部。
- 执行 activation/inbox、scheduler、admission 和增长用例的聚焦测试，然后完成
  必要 build、typecheck、bundle、自查和代码审查。

## 验收标准

- 两个存储满足条件后在下一次追加前自动压缩冗余转换，不增加无人使用的配置开关。
- 所有现有身份、重放结果、顺序与 fence 保持不变。
- 存活 activation 保留的续租行数不再随生命周期无限增长。
- 替换失败既不能确认新事件，也不能允许失败实例继续写入。
- 终态身份的内存/磁盘增长，以及原生 journal/authority 工作，仍明确属于 #13184 未完成项。

## 开放问题

第 1 片没有待定行为选择。剩余工作需要原生快照协议与持久历史索引存储，
公共投影快照或身份 TTL 都不能代替它们。
