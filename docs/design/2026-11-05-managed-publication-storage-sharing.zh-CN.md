# 普通工具结果发布取消存储行锁

[English](2026-11-05-managed-publication-storage-sharing.md) | [简体中文](2026-11-05-managed-publication-storage-sharing.zh-CN.md)

## 问题与范围

普通 LOCAL 和 SSH_LOCAL 工具及上传已经共享 Workspace。发布仍对存储别名和物理所有者加锁，尽管它只读取身份、登记及挂载状态。将排他锁替换为共享锁允许读取者并发，但仍会等待所有者行上无关的成员计数更新。

使用普通无锁存储读取，包含最终发布回执。仅删除 writer 的锁，会在 journal 提交时留下另一把存储锁。rewind 行为、目录成员计数和维护粒度不属于本次增量。

## 状态写入方与维护

已有 LOCAL 存储的身份变更、物理冻结、恢复和迁移均属于离线维护。生产命令要求 `--offline-confirmed`；[服务 README](../../packages/managed-agent-server/README.md)要求冻结前停止准入、服务和外部写入进程，禁止在仍被使用的共享存储上操作。Fencing 持久拒绝后续工作，并不能停止任意进程。

在线 LOCAL 创建先登记存储，再发布 Workspace。SSH 登记在同一事务中发布 REGISTERED/READY 存储和 Workspace；失败登记的清理仅删除 FENCE_ONLY 别名和 UNVERIFIED 所有者。这些路径不会使已有可用 Workspace 失效。在线执行、上传和子工作区维护更新成员或 holder，而发布的物理可用谓词不读取这些字段。LOCAL 逻辑迁移围栏在物理所有者仍开放时，原本就允许已准入的最终结果收尾。

因此，普通查询足以完成普通发布的物理状态检查。它读取当前事务可见的已提交快照，并拒绝其中的非法状态。不承诺等待不受支持的并发离线维护，也不刷新外层 REPEATABLE READ 事务的旧快照。不增加额外连接、隔离级别覆盖或协调服务。

## 实现

增加 `WorkspaceMigrationAdmission.requirePhysicalOpenForRead`，以空锁后缀复用原有物理可用谓词，并通过 `JournalFencing.requireSessionStorageOpenForRead` 转发。`JournalWriterLifecycle` 仅在没有 placement 且原始资源不是 CSI 时使用它。依赖 placement 的 writer 保留现有排他检查。

`ToolPublicationAdmissionStore` 已校验原始 binding、资源、单个回执事件以及不存在 Hosted cleanup。placement 和 CSI/生命周期 guard 均不存在时，首次回执与重放都使用包内可见的 `ManagedSessionStore.commitPublicationReceipt` 入口。其内部 journal 路径复用同一事务中 publication writer 已完成的物理状态检查，不再重复获取存储锁。writer、根行、head、生命周期和回执校验保持完整。

公开 repository 的 commit 方法维持原行为。不能根据 `operation = recordToolResult` 或资源类型选择内部捷径：这些都是请求值，不能证明已执行发布校验。不增加公开 API、schema、配置或请求开关。

## 保留的保证与边界

- 普通 reserve、renew、生产方 fencing、close-not-started、两段 admission 和已验证回执不获取存储行锁。dispatch、upload、verification 和 finish 原本就不调用 publication writer 检查。
- 别名身份、登记和物理所有者可用性的谓词保持不变。事务快照建立前已提交的非法登记或 FENCED 所有者仍拒绝新的发布工作。
- Session writer 凭据、代次、binding 和 execution 所有权、journal 串行化、保留期、发布身份及回执幂等继续使用原有保护。通用 journal 提交保留存储锁。
- CSI、Resident、带生命周期授权和快照路径保留原有检查与锁。执行成员资格和维护占用不变。
- 保留离线 FENCED 机制。本改动不保证不受支持的并发物理维护安全，也不承诺跨 Session 文件合并或无冲突写入。

## 影响组件

改动涉及物理读取 helper、journal fencing 与 publication writer、具体 Session store 与内部 journal commit，以及发布回执路由。公开 Session repository 契约保持不变。更新真实 MySQL 发布测试，以区分普通读和共享锁，并包含真实回执提交与重放。先前的共享锁测试结果仅作为历史证据保留。

## 验证与验收

1. 实现前，由独立事务持有别名或所有者排他行锁，复现普通发布等待。使用无害的行锁或成员计数更新，不模拟不受支持的并发离线 fencing。
2. 实现后，Session 独占和 Workspace 共享的 reserve、renew、admission、回执及重放均能在无关存储行锁仍被持有时完成。覆盖外层事务。反向顺序中，成员计数更新应在发布事务释放前完成。
3. 已提交的非法别名或 FENCED 所有者仍拒绝发布，不写入成功的新 capture/admission/receipt。
4. 通用 journal 请求，包括仅命名为 `recordToolResult` 的请求，保持原加锁路径。验证依赖 placement 的 writer、Session 所有权和回执幂等。
5. 复用有效的 rewind/schema 证据。在原共享十分钟 Java 预算内，执行受影响的 journal/publication 测试、变更的 MySQL 用例和 Checkstyle。记录精确命令、基线失败、最终结果和遗漏。完整 Java/MySQL、Hosted/fault、SSH 进程和 SpotBugs 验收仍交给 CI。

## 未决问题

本次改动没有未决问题。取消用户自有目录的成员资格或缩小 worktree 维护范围属于独立后续工作；本次不提议删除离线 FENCED 机制。
