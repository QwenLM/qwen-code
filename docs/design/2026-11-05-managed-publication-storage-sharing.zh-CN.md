# 普通 journal 与工具结果发布取消存储行锁

[English](2026-11-05-managed-publication-storage-sharing.md) | [简体中文](2026-11-05-managed-publication-storage-sharing.zh-CN.md)

## 问题与范围

普通 LOCAL 和 SSH_LOCAL 工具及上传已经共享 Workspace。journal 提交和工具结果发布仍对存储别名和物理所有者加锁，尽管它们只读取身份、登记及挂载状态。共享锁允许读取者并发，但仍会等待所有者行上无关的成员计数更新。

通用 journal 提交、内联工具结果发布和普通 publication writer 统一使用无锁存储读取。发布回执使用公共提交入口，不设置专用绕过入口或请求开关。rewind 行为、目录成员计数和维护粒度不属于本次增量。

## 状态写入方与维护

已有 LOCAL 存储的身份变更、物理冻结、恢复和迁移均属于离线维护。生产命令要求 `--offline-confirmed`；[服务 README](../../packages/managed-agent-server/README.md)要求冻结前停止准入、服务和外部写入进程，禁止在仍被使用的共享存储上操作。Fencing 持久拒绝后续工作，并不能停止任意进程。

在线 LOCAL 创建先登记存储，再发布 Workspace。SSH 登记在同一事务中发布 REGISTERED/READY 存储和 Workspace；失败登记的清理仅删除 FENCE_ONLY 别名和 UNVERIFIED 所有者。这些路径不会使已有可用 Workspace 失效。在线执行、上传和子工作区维护更新成员或 holder，而物理可用谓词不读取这些字段。LOCAL 逻辑迁移围栏在物理所有者仍开放时，原本就允许已准入的提交收尾。

普通提交通过 SQL 写入 journal 记录、资源和投影；记录文件历史本身不修改 Workspace 文件。Session/root 与 head 锁串行化实际共享的 journal 状态。Hosted cleanup 记录保留 placement 和原始 binding 保护。Resident 存储使用 CSI 别名：此物理检查只验证别名身份，预留与退役仍使用独立的所有权和空闲检查。

因此，普通查询足以完成普通 journal 和发布的物理状态检查。它读取当前事务可见的已提交快照，并拒绝其中的非法状态。不承诺等待不受支持的并发离线维护，也不刷新外层 REPEATABLE READ 事务的旧快照。物理冻结不再等待普通 journal 事务结束；维护前必须停止写入进程。不增加额外连接、隔离级别覆盖或协调服务。

## 实现

增加 `WorkspaceMigrationAdmission.requirePhysicalOpenForRead`，以空锁后缀复用原有物理可用谓词，并通过 `JournalFencing.requireSessionStorageOpenForRead` 转发。`JournalWriterLifecycle` 仅在没有 placement 且原始资源不是 CSI 时使用它。依赖 placement 的 writer 保留现有排他检查。

`JournalCommit` 和 `JournalResourceWrites.publishToolResult` 在不存在生命周期 authority 与私有 CSI continuation 时使用相同的普通读取，否则保留原加锁路径。删除不再使用的 journal 共享锁 helper。

`ToolPublicationAdmissionStore` 继续校验原始 binding、资源、单个回执事件以及不存在 Hosted cleanup。首次回执与重放均调用公共的带事务 Session commit 方法。删除 `commitPublicationReceipt`、`publicationStorageChecked` 及特殊分流。任何判断都不依赖传入的 operation 名称或资源类型。不增加公开 API、schema、配置或请求开关。

## 保留的保证与边界

- 普通提交、内联结果、reserve、renew、生产方 fencing、close-not-started、两段 admission 和回执不获取显式存储行锁。dispatch、upload、verification 和 finish 原本就不调用 publication writer 检查。
- 别名身份、登记和物理所有者可用性的谓词保持不变。事务快照建立前已提交的非法登记或 FENCED 所有者仍拒绝新的写入。已有幂等 journal 重放继续在存储检查之前提前返回。
- Session writer 凭据、代次、binding 和 execution 所有权、journal 串行化、保留期、发布身份及回执幂等继续使用原有保护。直接调用通用入口仍不能伪造缺失的发布资源。
- 私有 CSI、生命周期 authority 和快照 guard、依赖 placement 的 publication writer，以及 Resident 预留/退役保留原有检查与锁。执行成员资格、维护占用和 action-response 准入锁不变。
- 保留离线 FENCED 机制。本改动不保证不受支持的并发物理维护安全，也不承诺跨 Session 文件合并或无冲突写入。

## 影响组件

改动涉及物理读取 helper、journal fencing、publication writer、公共 journal 提交和内联资源发布。公开 Session repository 契约保持不变。删除具体 Session store 和发布路由中的专用回执路径。更新真实 MySQL 和锁契约测试；先前的共享锁及通用入口加锁对照结果仅作为历史证据保留。

## 验证与验收

1. 复用已记录的基线：通用 journal 提交会等待独立事务持有的所有者行锁。使用无害的行锁或在线元数据更新，不模拟不受支持的并发离线 fencing。
2. 普通通用提交和内联结果均能在独立的别名/所有者排他锁仍被持有时完成。元数据更新也能在 journal 事务尚未结束时完成。普通 reserve、renew、admission 和真实回执/重放仍不阻塞，覆盖 Session 隔离与 Workspace 共享的 binding，以及外层事务。
3. 已提交的非法别名或 FENCED 所有者仍拒绝新工作。命名为 `recordToolResult` 但引用未安装资源的通用请求仍然失败且不推进 journal，只是不再等待存储锁。
4. 验证依赖 placement 的 writer、Session/root-before-head 所有权、凭据、代次、回执幂等以及独立的 action-response 准入锁。调整原来要求冻结等待 journal 提交的测试：先验证无害元数据并发，在事务结束后安装 fence 并验证拒绝。
5. 复用有效的 rewind/schema 证据。在原共享十分钟 Java 预算内，执行受影响的 journal/publication 测试、变更的 MySQL 用例和 Checkstyle。记录精确命令、基线失败、最终结果和遗漏。完整 Java/MySQL、Hosted/fault、SSH 进程和 SpotBugs 验收仍交给 CI。

## 未决问题

本次改动没有未决问题。取消用户自有目录的成员计数或缩小 worktree 维护范围属于后续工作；本次不删除离线 FENCED 机制。
