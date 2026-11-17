# 取消 rewind 的目录排他

[English](2026-11-05-managed-rewind-concurrency.md) | [简体中文](2026-11-05-managed-rewind-concurrency.zh-CN.md)

## 问题与决定

普通工具与上传已经共享 Workspace。Managed rewind 仍要求其 Runtime Session 是目录的唯一成员，并在文件操作返回前记录排他所有者。其他 Session 或上传会阻止 rewind，而丢失 rewind 响应会阻塞整个目录。

用户明确选择让 rewind 也沿用 CLI 的跨 Session 文件并发语义。这替代了[共享 Workspace 上传](2026-11-03-managed-shared-workspace-uploads.zh-CN.md)中的 rewind 排他决定。原生文件历史恢复不获取跨 Session 目录锁，daemon 只对自身 Session 排队。Managed 文件历史的 digest/mode 检查仍是乐观检查，不是文件系统事务，也不能保证隔离外部写入。

## 实现

在精确的 Runtime Session 上保留持久化待确认 rewind 状态。`beginRewind` 校验现有 owned-root 和成员资格要求，并将该 READY Session 的 pending 标志原子地从 false 改为 true。不再要求 `member_count = 1`，也不再安装物理目录的排他所有者。同一 Runtime Session 的重复或结果未明 rewind 仍被拒绝。

传输层将已准入的 rewind 发往原始 worker，不再仅因目录存在其他成员而人工返回 conflict。worker 成功返回后清除 pending；异常或未知结果保留 pending。worker 原有的文件冲突结果保持原样返回。原 Session 仍 pending 时，其他 Session 可以执行工具、上传或 rewind。

rewind 全程保留 Runtime Session 成员资格和计数。pending rewind 仍阻止该 Runtime Session 的普通执行和 mount 归还。将归还时的 pending 检查移入释放成员资格的事务，避免与 rewind 准入竞态。确认的 worker release 或具有停止/LOST 证据的清理可以清除 pending，并仅释放原始成员资格。

删除 `ma_storage_owner.exclusive_member_key`、配套 hash helper、准入谓词和单一排他成员清理。将 Runtime Session 标志重命名为 `is_rewind_pending`，查询重命名为 `hasPendingRewind`。`beginRewind` 返回 void：准入成功或抛错。同步更新 schema 投影、布尔解码、CSI inventory 和受影响测试。

成员记账的短事务保留现有 alias/物理所有者/Runtime Session 锁顺序。mount 状态仍为当前读，pending 准入使用条件更新。SQL 锁在文件 I/O 前结束。不引入租户 guard、新表、锁服务或配置。

## 边界与兼容性

- 仍要求同 Session 的 idle/history 校验、精确 Binding/代次所有权和未知结果恢复。不增加对不确定 rewind 的自动重放。
- 与 CLI 一样，其他写入者可以在 rewind 期间修改同一文件。不保证自动合并、多文件原子恢复或无冲突结果。
- worktree 维护、物理 fencing、迁移和回收仍要求目录无人使用。pending Session 的成员资格继续阻止这些操作，即使它是唯一成员。
- owned-root 授权和现有 SSH/CSI/Resident 不支持的控制行为保持不变。仅放宽跨 Session 目录排他。
- 按发布前 schema 策略原地更新 V1，不提升版本、不添加迁移。旧开发 catalog 需要重建；本任务不修改或重建用户 catalog。

## 验证与验收

1. 实现前，期望 rewind 与已有 Session/上传并发、以及在 pending rewind 期间准入的测试复现旧拒绝行为。
2. 成功及结果未明的 rewind 期间，已有和新加入的相邻 Session/上传仍可使用目录。两个相邻 Session 可以保留独立 pending 标记。
3. 发起方 Runtime Session 在 pending 时不能再次 rewind、执行普通工作或归还 mount。成功结束或已证明的物理释放仅清理自身状态。
4. 上传结束、正常释放、停止清理和 LOST 恢复之后，成员计数仍精确。仍有成员时，维护和 fencing 继续拒绝。
5. 在共享的十分钟 Java 预算内，执行聚焦 H2、真实 MySQL 成员/上传/发布测试、schema/inventory 回归和 Checkstyle。完整 Hosted/fault、MySQL 和 SpotBugs 验收仍交给 CI。

## 未决问题

无。用户已明确将本次范围扩大到 rewind 并发。
