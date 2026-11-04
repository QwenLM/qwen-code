# 去掉队列派发与工作区 Session 创建的租户 guard

[English](2026-11-04-managed-session-admission-tenant-guard.md) | [简体中文](2026-11-04-managed-session-admission-tenant-guard.zh-CN.md)

## 问题与现状

Turn 准入、Session 命令和普通 journal commit 都已不再获取租户 placement guard
（[Turn 准入](2026-11-03-managed-turn-admission-tenant-guard.zh-CN.md)、
[Session 命令](2026-11-03-managed-session-commands-tenant-guard.zh-CN.md)、
[journal commit](2026-11-03-managed-journal-commit-tenant-guard.zh-CN.md)）。
普通流量中还有两个准入以它开头：

- `ManagedUserMessageStore.startNext`：把下一条排队的用户消息作为 Turn 启动，每条排队
  消息执行一次。
- `AgentSessionAdmissions.insertWorkspaceSessionCommand`：在工作区中创建 Session。其注释
  要求事务的第一次一致性读发生在某个锁之后。

因此它们都要排在该租户的其他 guard 持有者之后。

## 队列派发

`startNext` 先获取 guard，再锁 Session 行（`lock`），读写该 Session 的队列行，然后调用
submitter；submitter 在同一事务中执行 Turn 准入。自 #16223 起 Turn 准入不再获取 guard，
它锁定同一 Session 行，再锁存储 fence 行。向 Harness 派发在事务提交后执行。

这个 guard 来自 Turn 准入还持有 guard 的时期，用来保持"guard、Session 行"的顺序。去掉后，
第一条语句就是 Session 行锁，它让派发与该 Session 的生命周期 begin、其他队列命令以及 Turn
准入排序。队列行按 Session 划分，且只在该行锁下写入。去掉 guard。

## 工作区 Session 创建

新 Session 还没有可以排队的行。创建路径先用普通读查幂等键，再用锁定读解析工作区（其
`ma_workspace` 行和操作者的 access 行），检查存储 fence（别名行和目录行），然后插入
Session、事件流、命令回执和创建模式声明。不带工作区的普通 Session 创建，本来就在不持有
guard 的情况下走这条插入路径。

| guard 的作用                | 替代方式                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一次一致性读发生在锁之后  | 第一条语句用 `resolveForCreation` 相同的条件锁定所选 `ma_workspace` 行，之后的锁是同一行。                                                                                                                                             |
| 两个请求使用同一幂等键      | 不变：由回执的唯一键裁决；创建模式声明先插入、再锁定重读；服务层对 `DuplicateKeyException` 返回已记录的准入。                                                                                                                          |
| 迁移                        | 任何插入之前都会锁定存储 fence 行，迁移 prepare 基于已提交数据检查空闲（#16223）。迁移不锁 `ma_workspace`，不存在反向顺序。                                                                                                            |
| 常驻工作区退役、工作区删除  | 它们锁定同一 `ma_workspace` 行，该工作区内的创建排在其后。                                                                                                                                                                             |
| 常驻工作区的单 Session 检查 | `ResidentWorkspaces.requireCreation` 对工作区内未关闭的 Session 和运行时会话加范围锁；两个相邻工作区的范围共享一个间隙，两次创建都会向其中插入。可能解析到已配置常驻工作区的选择仍先获取 guard，这一判断在任何读取之前仅依据配置完成。 |

默认工作区原先用 `tenant_id = ? AND is_default = TRUE` 加 `FOR UPDATE` 解析，这会扫描
`(tenant_id, workspace_id)` 键的租户前缀，锁住该租户所有工作区行。现在改用生成的唯一列
`default_tenant = ?`，只锁一行。

团队负责人创建和子 Session 创建保留 guard。子 Session 创建会在 `ChildWorkspaceStore.admit`
中再次获取 guard，并与父 Session 的子运行记录串行；两者频率都低。

## 风险

- 同一工作区内的创建仍在其行上排队；每次创建仍以排他方式锁定存储别名行，共享同一存储的
  创建会在那里排队。
- 若审计漏掉创建路径中某处对不存在键的锁定读，会表现为同一租户两次创建之间的 InnoDB
  死锁。下面的 MySQL 测试专门覆盖这种情况。
- `mayContain` 是保守的：只要租户配置了任一常驻工作区，其默认工作区的创建就仍获取 guard。

## 验证与验收

1. `ManagedUserMessageStoreTest`：另一连接持有租户 placement guard 时，`startNext` 仍能
   认领排队消息并准入其 Turn。
2. `ManagedModelSelectionTest`：持有 guard 时，工作区 Session 创建仍能完成。
3. `ManagedSessionGuardConvoyIT`（MySQL）：四个 writer 同时在同一租户的四个工作区中各创建
   十个 Session，不出现死锁。
4. 现有的队列、创建、工作区、迁移与锁契约测试继续通过，包括 CI 中的 MySQL profile。
