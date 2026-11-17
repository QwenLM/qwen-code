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
| 迁移                        | 任何插入之前都会锁定存储 fence 行。迁移锁定别名后，通过新连接检查已提交的工作和完整的 Session 执行配置清单。迁移不锁 `ma_workspace`，不存在反向顺序。                                                                                  |
| 常驻工作区退役、工作区删除  | 它们锁定同一 `ma_workspace` 行，该工作区内的创建排在其后。                                                                                                                                                                             |
| 常驻工作区的单 Session 检查 | `ResidentWorkspaces.requireCreation` 对工作区内未关闭的 Session 和运行时会话加范围锁；两个相邻工作区的范围共享一个间隙，两次创建都会向其中插入。可能解析到已配置常驻工作区的选择仍先获取 guard，这一判断在任何读取之前仅依据配置完成。 |

默认工作区继续使用 `tenant_id = ? AND is_default = TRUE` 加 `FOR UPDATE` 解析，这会扫描
`(tenant_id, workspace_id)` 键的租户前缀，可能锁住该租户的其他工作区行。拟采用的
`default_tenant = ?` 查询在 MySQL 8.4 上会与先更新工作区元数据、再切换默认工作区的
管理员操作死锁：读取方持有生成列唯一索引并等待数据行，管理员持有数据行并等待该索引。
因此保留原有查找顺序；缩小默认选择的锁范围需要另行设计，并保持并发切换默认工作区的行为。

团队负责人创建和子 Session 创建保留 guard。子 Session 创建会在 `ChildWorkspaceStore.admit`
中再次获取 guard，并与父 Session 的子运行记录串行；两者频率都低。

首次工作区锁定读由 `ManagedWorkspaceRegistry` 负责，其选择条件和参数保持私有。
Session 准入保留常驻工作区 guard 的判断及其锁顺序说明。本次改动经明确批准，将该类
的行数上限从 889 调整至 900，以容纳必要的逻辑和说明。这是只降不升约定的一次限定
例外；全局上限和其他类的上限保持不变。

迁移可能在等待创建方的存储别名锁之前就固定 REPEATABLE READ 快照。因此，现有使用
独立 autocommit 连接的空闲检查，还必须验证完整的 Session 执行配置清单，包括等待
期间提交的 Session，否则可能漏掉尚未初始化或不支持迁移的 Session。清单、回执、
genesis 和定义资源都通过同一新连接读取。外层事务继续持有别名锁和 publication
authority 锁；新连接不能再锁 Session 或 head 行，以免与普通流量先 Session、后
别名的顺序相反。

## 风险

- 同一工作区内的创建仍在其行上排队；每次创建仍以排他方式锁定存储别名行，共享同一存储的
  创建会在那里排队。默认选择保留租户前缀扫描，也可能阻塞该租户其他工作区中的创建。
- 若审计漏掉创建路径中某处对不存在键的锁定读，会表现为同一租户两次创建之间的 InnoDB
  死锁。下面的 MySQL 测试专门覆盖这种情况。
- `mayContain` 是保守的：只要租户配置了任一常驻工作区，其默认工作区的创建就仍获取 guard。

## 验证与验收

1. `ManagedUserMessageStoreTest`：另一连接持有租户 placement guard 时，`startNext` 仍能
   认领排队消息并准入其 Turn。
2. `ManagedModelSelectionTest`：持有 guard 时，工作区 Session 创建仍能完成。
3. `ManagedSessionGuardConvoyIT`（MySQL）：四个 writer 同时在同一租户中各创建十个
   Session，不出现死锁。覆盖显式选择四个工作区和选择默认工作区，并分别使用独立的
   存储注册和共享存储；默认选择创建的所有 Session 必须绑定到默认工作区。现有 MySQL
   默认切换测试必须在不发生死锁的情况下解析到新选定的默认工作区。
4. `WorkspaceMigrationMySqlIT`：创建和旧版 CWD 完成等待尚未提交的 `ma_storage`
   fence，在其提交后拒绝操作，同时保留原请求的幂等重放，并允许无关租户继续推进。
   迁移的 REPEATABLE READ 快照固定后提交的 Session 仍必须接受检查；尚未初始化的
   Session 应使迁移拒绝，且不遗留操作记录或 fence。
5. 现有的队列、创建、工作区、迁移与锁契约测试继续通过，包括 CI 中的 MySQL profile。
6. 源码行数门禁应接受 900 行的准入类，精确符合已批准的上限；Broker 类和全局上限
   保持 main 的 4,253 行。
