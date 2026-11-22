# Workspace 共享上传

[English](2026-11-03-managed-shared-workspace-uploads.md) | [简体中文](2026-11-03-managed-shared-workspace-uploads.zh-CN.md)

下述 rewind 排他决定已由[取消 rewind 的目录排他](2026-11-05-managed-rewind-concurrency.zh-CN.md)替代。共享上传和物理维护保护仍保留。

## 问题与范围

普通 Session 已经可以共享 Workspace 目录。上传准入仍要求没有执行成员，并设置
独占的 `holder_key`，直到原文件进程返回终态。因此一次上传会阻挡普通工具和其他
上传，即使它们写入的是不同文件。

允许普通编辑、命令和上传共享 LOCAL、SSH_LOCAL 目录。保留 rewind、目录恢复、迁移及
物理资源回收的现有互斥保护。授权、冻结的上传身份、幂等、未知结果对账和 generation
隔离仍然必须满足。

## 设计

复用目录已有的 `member_count` 表示普通使用者：携带该 `execution_storage_key`
的 Runtime Session 行，加上携带该 `physical_key` 且状态为 `RUNNING` 的
`WORKSPACE_UPLOAD` 操作。不增加 schema 字段或锁服务。

上传准入在同一事务里登记操作并增加计数。允许其他成员存在，要求目录就绪，并拒绝
独占 rewind、维护或物理所有者占用。不再设置 `holder_key`。文件 I/O 继续在提交后执行。

准入和结算都不再获取租户 placement guard。与 Runtime `claim` 相同，准入由按目录成员
锁顺序获取的行锁决定：先 alias 行，再目录行，最后是新操作行。计数更新还要求
`mount_revision` 等于计算作用域修订时读到的值，因此读取后发生的 fence、restore 或
重新注册会拒绝该回执。结算先锁目录行，再锁自己的操作行。不同目录的上传之间，以及
同一租户内上传与 Runtime placement 之间不再互相等待；同一目录的回执仍会在其 alias
行和目录行上短暂串行。

去掉 guard 后上传 ID 仍保持幂等。准入以无锁读取已有回执，并发的首次回执由唯一的
操作 key 决定胜负。失败方回滚后重新读取已提交的回执，并在相同的 actor 与请求摘要
检查下重放。

此前 guard 还负责让上传准入与 Session worktree 删除互相排序。现在删除依赖其维护
hold：hold 要求成员数为零，并在持有期间重新检查未完成上传。因此已准入的上传会推迟
删除，已持有的删除会拒绝新上传。

确认终态后，在同一事务里减计数并结束该操作。已结束操作的重放不再减计数。结果
待定或未知时，成员身份跨重启保留，并且只查询冻结的原目标。一个上传不能释放另
一个上传或 Runtime Session 的成员身份。

维护和物理 fencing 仍要求成员数为零。Rewind 要求自己的 Runtime Session 是唯一
成员，因此上传和 rewind 无论谁先准入都保持互斥。目录恢复及清理已经检查此计数或
未完成上传。Runtime drain 和已停止成员清理只处置精确的 Runtime 进程或成员；上传
使用独立文件进程，清理期间仍保留原始目标和成员身份。

上传沿用原子、不覆盖的发布语义：目标已存在时返回冲突，绝不覆盖。普通工具仍可
编辑同一文件；本次不增加跨 Session 自动合并文件的保证。

## 受影响组件

- `WorkspaceFileUploadStore`：共享准入和只执行一次的成员释放，不再获取租户 placement guard。
- `WorkspaceFileStore`：上传作用域携带其读取到的 `mount_revision`。
- 存储 owner 的 schema 注释：说明合并后的成员计数。
- 上传及成员验证：计数同时包含存活 Runtime 成员和上传操作。
- 上传及目录成员设计：说明共享上传的成员语义。

路由、请求、响应及认证没有变化。CSI 上传仍不支持。本次增量基于 PR #16205。

## 验证与验收

1. 同一目录上的两个重叠上传都能进入文件进程。
2. 上传待定时工具仍能取得和保持成员身份；工具已有成员身份时上传仍可开始。
3. 上传与 rewind、维护、fencing 双向互斥。恢复和清理不能丢弃未完成上传的原目标。
   Runtime 成员释放后，未完成上传仍计入占用。
4. 完成、失败、重试和重启后，计数等于存活 Runtime 成员与运行中上传操作之和。
   重复终态响应不会重复减计数。
5. 现有 actor、请求变化、后端选择和冻结目标测试继续通过。
6. 另一事务持有租户 placement guard 时，上传准入和结算仍能完成。
7. 同一上传 ID 的并发首次回执只写入一次文件、只留下一个操作，并只释放一次成员身份。

在模块共用的本地验证预算内运行聚焦 Java 和真实 MySQL 测试。完整 MySQL 及
Hosted/fault 检查交由 CI。执行结果和剩余验收缺口记录到 E2E 报告；本文不声明已通过。

## 未决问题

无。用户已明确选择普通执行与上传共享目录，同时保留 rewind、恢复、迁移及回收保护。
