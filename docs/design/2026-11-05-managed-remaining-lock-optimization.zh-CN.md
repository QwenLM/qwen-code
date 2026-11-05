# Managed Agent 剩余锁优化

[English](2026-11-05-managed-remaining-lock-optimization.md) | [简体中文](2026-11-05-managed-remaining-lock-optimization.zh-CN.md)

## 状态与范围

调研和本地验证基于 2026-11-05 的 `main`：`6fe5bca8e1a13ffb17be93123f75063f48181f44`。本次实现 SSH 收尾和主 worktree 创建的并发优化，不宣称已测得吞吐量提升。PR #16369、#16370 已合并：rewind 不再独占整个目录，普通 journal/发布收尾不再获取存储行锁。

本次未引入通用锁管理器、新锁表或 profile 开关。Session 顺序、writer 代际、幂等、授权和精确的执行停止证据仍是独立要求。普通工作区文件并发修改继续沿用已确定的 CLI 语义。

## 调研结论与决策

| 范围           | 当前保护的内容                                       | 决策                                                                                                 |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 剩余存储准入   | 接收新工作前的逻辑迁移标记和物理注册状态             | 不全局替换成无锁读取；区分新准入和已接收操作的元数据收尾。                                           |
| `member_count` | Runtime Session 成员和运行中上传，供排他维护判断空闲 | 暂时保留。它在加入、退出和上传边界更新，并非每次工具执行都更新。                                     |
| 维护占用       | 物理 Git 操作，包括重启恢复和执行结果不明的情况      | 主 Session worktree 创建允许普通成员并行；维护之间的互斥和持久归属仍保留。                           |
| 租户 guard     | 一部分跨资源约束，以及一部分具体操作的多余串行       | 移除 SSH 注册三个收尾入口的 guard，同时精确定位 owner 更新；跨资源 placement/retirement guard 保留。 |

## 首个实现：SSH 注册收尾

在 [SshWorkspaceStore](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/SshWorkspaceStore.java) 中，仅移除 `complete`、`completeParked`、`releaseParked` 的租户 `runtime_placement` guard。三者已经通过 `requireClaim` 或 `parkedRow` 锁定现有注册 operation，同一 reservation 的完成、失败和恢复因此串行。发布只在同一事务写入该 reservation 的 alias、owner、Workspace 和 OWNER grant，不选择租户默认工作区，也不维护租户总配额。

删除 guard 时一起修改了一条 SQL。`publish` 原先按 `mount_registration_id` 更新 `ma_storage_owner`，基线 schema 没有该列的索引。本次从已经锁定的 alias 行取得 `physical_key`，改为按现有唯一键 `storage_key` 更新 owner，同时保留注册身份和 `SSH_LOCAL` 条件；发布 Workspace 前必须确认预期 owner 存在。不能从 `intent.registration()` 推导 key：正常调用方保留的是 reservation 之前取得的 Intent，该字段可能为空。

`begin` 和 `reserve` 保持不变，它们处理 operation 不存在时的创建和物理目录预留。尤其是 [LocalStorageOwners](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/LocalStorageOwners.java) 中的 host 级目录重叠 guard，协调同一主机上的不同租户，不能当作多余的租户串行删除。这个切片无需修改 schema 或 API。

## 存储准入与成员计数

[WorkspaceMigrationAdmission](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/WorkspaceMigrationAdmission.java) 目前合并了两项检查。`requireOpenForAdmission` 在 MySQL 上用共享锁读取 `ma_storage.fence_operation_id` 和物理注册。十个直接的共享准入调用点覆盖 Turn 提交、Action 响应、上下文压缩、任务取消、Session 修改和配置/策略变更，其中多处会排入新工作，与普通 journal 回执不同。

新工作的逻辑 fence 顺序暂时保留。当前约定是 fence 写入方等待已准入事务，之后的准入看到已关闭的入口。将它换成快照读是协议变化，也涉及事务已经建立 REPEATABLE READ 快照的情况。物理迁移要求离线，并不能单独证明这项独立准入约定没有作用。Workspace/权限锁以及最终物理写入准入也不在本次删除范围内。

已接收操作的元数据收尾是另一类候选：`AgentSessionCommands.completeSessionMutation` 更新 Session 元数据、回执和事件，同时保留 Session/回执锁。后续可以考虑像普通 journal 提交一样，允许这种收尾穿过逻辑迁移 fence，并复用现有无锁物理检查；必须明确延迟 `FAILED` 回执和后续修改覆盖的行为并测试。它不属于 SSH 切片。

仅移除物理 owner 的共享读锁并不能完整解决争用：Runtime claim/上传仍会获取 alias 和 owner 排他锁，`storageKey` 中也有隐含取锁。反过来，仅删除 `member_count` 而保留这些读取，大部分串行仍然存在。

现有计数对 owned-root LOCAL 和 imported LOCAL 都有作用：导入根目录禁止整体物理维护，但仍支持 Session/child worktree 维护。SSH_LOCAL 没有对应的 LOCAL worktree 维护消费者，但仅为它删除计数会增加生命周期分支，对普通工具路径收益有限。不能因为租约到期或连接断开，就清除结果不明或 pending 上传以及保留的 Runtime 成员。

如果以后测得加入/上传争用足以支撑替换计数，可复用现有 Runtime 成员行和运行中上传行。准入共享 owner 入口，维护独占同一入口，再用当前读检查两类成员。简单 `COUNT`/`NOT EXISTS` 存在空集合之后插入的竞态，也可能看到旧快照。备选协议必须一起覆盖所有 claim/release、LOST/停止证明清理、pending 上传和空闲判断路径。目前暂缓，不增加第二套记账。

## 主 worktree 创建协议

[SessionWorktreeGit.prepare](../../packages/managed-agent-server/adapters/src/main/java/com/alibaba/qwen/code/managedagent/adapters/workspace/SessionWorktreeGit.java) 从冻结的 commit SHA 创建单独分配的目标目录和分支，不对源目录未提交文件做快照。因此，另一个 Runtime Session 正在修改源目录，本身不必成为等待整个物理根目录空闲的理由。

普通成员可以与身份已验证的主 `SESSION_WORKTREE` 创建并行，维护操作之间仍通过现有 owner 和持久执行记录互斥。原始创建 operation ID 等于 worktree ID，cleanup 使用不同的 operation ID。分类匹配这一不可变身份、tenant、Session、逻辑及物理存储、claim 代际和 holder 摘要，不依赖会变化的 worktree/operation 状态或 claim 到期时间：Git 结果不明时，worktree 可能已标记 BLOCKED，而原物理执行仍持有维护占用。

Runtime 准入/执行、上传准入/收尾以及 Runtime 停止/恢复共用这一条件。计数更新仍在 owner 行锁内完成。Operation/worktree 分类使用独立无锁查询，避免在 owner 锁之后获取 operation 锁。REPEATABLE READ 旧快照无法匹配当前代际时拒绝放行。原有挂载就绪检查保留在原调用位置，停止 Runtime 的清理路径不新增 READY 要求。结果不明、过期或未证明停止的维护，仍不得让后继维护进入。

创建仍会修改 Git common directory、refs 和 worktree 注册。并发用户 Git 操作采用 CLI 冲突语义：返回冲突，不重置或收编已有目标。这不表示创建只操作新目录。共享容器和目标冲突沿用现有失败语义及 marker/身份校验。

首个 worktree 改动不扩大到 cleanup 或 child 操作。Cleanup 会删除 checkout，需要排除该目标的使用者和上传。Child 创建会读取父仓库的工作文件做快照；merge/apply 读取并写入父仓库；discard 也会修改共享 refs。仅凭 `cwd` 或 `worktreeId` 不能确定完整冲突范围，Shell 执行也没有被限制在该目录内。缩小这些操作需要单独设计源目录、目标目录和公共 Git 元数据的协议。

也不能独立删除维护路径的租户 guard。目前取锁路径同时存在 owner 先于 operation 和 operation 先于 owner 的顺序，较大的 guard 正在避免这些路径并发。缩小 guard 前需要先统一顺序。

## 验证与交付

SSH 收尾和 worktree 创建保持可独立审阅。SSH 的 MySQL 验收覆盖：

1. 持有同租户 placement guard，或另一物理 owner 的行锁，都不会阻塞目标注册收尾。
2. 同一 parked operation 并发完成和释放，只能形成一种有效结果：完整的 Workspace/grant/READY owner，或注册失败且仅释放自己的未完成 reservation。
3. 包括跨租户在内，对同一或重叠目录的竞争预留保持目录归属。延迟的旧请求不能发布或删除新 owner 的注册。

Worktree 验收覆盖 Runtime/上传在创建占用前后两种顺序下准入、BLOCKED/claim 到期之后的 pending 上传收尾、过期代际，以及 cleanup 继续排他。真实 Git 检查验证冻结 commit 和源 dirty files/index 不变，中断创建不覆盖已有目标。未证明 worker 停止时始终不允许后继维护。Child merge/discard 的现有覆盖保持不变。

Runtime placement 仍扫描跨 binding/slot 的恢复障碍。Runtime retention、CSI 和 Resident retirement 仍依赖资源引用和更大范围的生命周期切换。普通 collector 以后可能继续缩小，但本次审计尚未完整确认 reader/recovery/归属交接的竞争关系，不能据此宣称这些 guard 可删。

实现修改五个持久化类及针对性测试，未新增 schema/API。本地验证通过 131 个去重后的针对性用例（包含 17 个真实 Git 用例）、45 个真实 MySQL 用例及 Checkstyle。全量 Java/MySQL/Hosted CI 和 UI 验收仍待完成；命令、失败尝试及限制记录在 `.qwen/e2e-tests/2026-11-05-registration-worktree-locks.md`。加入/上传的实际等待频率以及现有当前读约定，仍是后续存储准入/计数重设计必须明确的输入。
