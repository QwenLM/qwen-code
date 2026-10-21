# Managed Workspace 会话并发

[English](2026-10-21-managed-workspace-concurrency.md) | [简体中文](2026-10-21-managed-workspace-concurrency.zh-CN.md)

## 状态与范围

本次允许普通 Managed Session 在 LOCAL、SSH_LOCAL 的同一目录并发执行，覆盖 Session 隔离和 Workspace 隔离的 worker。同一 Session 仍然一次执行一个 Turn。Resident 和私有 CSI profile 保留当前准入、预留和退役规则。现有 Agent/Workflow 子任务准入限制不在本次范围。

## 问题与当前行为

Legacy daemon 按 Session 排队，允许不同 Session 使用同一目录。修改前，Managed 在整个工具 Turn 期间，将一个 Runtime Session 写入物理存储 owner 的唯一 holder 列。第二个 Session 会轮询 `workspace_busy`，界面没有可见的等待原因。UNKNOWN 执行保留原 owner，因此无关会话可能一直等待到消息截止时间，即使其 worker 本来可以独立执行。

唯一 holder 还保护物理维护、丢失 worker 清理、操作员恢复、保留清理和文件撤销。仅删除冲突检查会破坏这些消费者。Runtime worker 已分别维护每个 Session 的配置、工具日志、后台进程和取消身份，不需要修改进程全局 cwd。

## 占用模型

在持久化 Runtime Session 中新增可空 `execution_storage_key` 和默认 false 的 `execution_exclusive`。非空物理 key 表示该精确 Session 的执行成员资格，独立于生命周期状态。READY 无法表达这一点，因为归还 mount 后会故意保留 READY。UNKNOWN、获取失败和释放失败保留成员，直到现有证据门槛允许清理。

物理 `ma_storage_owner` 行继续标识已注册 mount 和独占维护 holder。获取时短暂锁住该行，验证原 tenant、Workspace、storage、binding、generation 和 mount，拒绝迁移、维护或独占撤销，再仅记录请求成员。允许其他普通成员。释放仅移除原成员，不清除同目录其他成员。准入和物理维护使用的成员扫描都在同一物理行锁下进行当前锁定读，覆盖 storage alias。

仍识别已发布格式的 Runtime singleton holder。允许其他成员加入前，验证其精确 Runtime Session 和 holder digest。首次兼容获取会先将原 holder 原子转移为精确成员，再清理 singleton 列，不丢弃执行占用。转移前的释放仍通过原有证据约束的清理路径。损坏 holder 明确拒绝。不会按超时抢占，也不会因为取消已请求就认定命令停止。

## 文件历史

并发编辑采用 Legacy 的共享文件语义：不同 Session 可能覆盖彼此文件，Shell、Hook、MCP 的效果不是事务。其他 Session 若在写入完成和最终指纹读取之间修改文件，现有指纹检查无法可靠归因。

过去发生过执行重叠不会禁用文件撤销，包括仅有读取的重叠。不存储持久的重叠标志，普通执行获取也不为此创建或更新历史 head。其他成员释放后，该 Session 可以通过现有 runtime/history 实现请求撤销。保留现有逐文件历史检查；本次不增加跨 Session 文件事务或修改归因保证。

撤销前，在物理行锁下确认没有其他成员或旧 holder，将自身成员升级为独占。若仍有其他成员持有占用，则返回现有冲突结果。新的获取会拒绝，直到撤销结果返回。成功完成后降回普通成员；结果不确定则保留独占成员，供原操作恢复。复用现有 Hosted 冲突回执和 pending-undo 处理，不修改历史 wire 格式或 UI API。

## 生命周期与恢复

物理注册、fence、恢复原目录、子 Workspace 维护和存储迁移，除现有 holder、writer 检查外，还要求不存在任何成员。即使 Runtime Session 被本地标记为 RELEASED，残留成员仍算占用。维护先获取则排除后续执行；执行先获取则阻止维护进入物理步骤。

停止已排空 worker 时，只验证该 binding 的执行和 Session 证据。同目录另一个 worker 的正常使用不应阻止停止本 worker。丢失 worker 清理要求原持久化停止证据和操作 claim，然后仅清除该 binding/generation 的成员。停止后的 Session 释放仅清除该 Session。保留清理不能删除仍有成员引用的 binding。

操作员恢复继续绑定精确 Runtime Session 身份。若一个 binding 有多个持有成员，仅凭 binding 准备恢复会明确拒绝，其他成员需先正常结束。已准备操作继续验证其精确成员和 digest。UNKNOWN 的 status、cancel 保留原执行身份，并继续禁止重放。

现有 Runtime placement 恢复屏障保持不变。binding 仍为 READY 时，工具结果 UNKNOWN 不再排除另一个普通 Session。binding 进入 LOST、DRAINING、OPERATOR_RECOVERY，或已完成 attestation 的 RECOVERY_BLOCKED 后，其恢复范围内的新 placement 仍须等待现有物理恢复门槛通过。本次不允许替换 worker 绕过该门槛。

## 各组件改动

| 组件                                  | 改动                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| 共享 schema 与 projection             | 新增 V15，不改已发布迁移；严格 CSI inventory 纳入新字段，要求 CSI 行没有普通成员资格。 |
| Workspace execution store             | 共享获取、精确释放、独占撤销、旧 holder 验证、完整维护占用和限定范围的丢失清理。       |
| Runtime transport                     | 获取和执行仍验证原成员；当前占用冲突复用现有结果，撤销结果不确定时保留独占。           |
| Storage guard                         | inspect、注册、fence、restore 和捕获注册验证均检查所有成员。                           |
| Binding repository 与 retention guard | CAS 保留成员；精确停止释放、关闭检查和保留引用。                                       |
| 操作员恢复                            | 解析并约束精确持有成员；拒绝有歧义的 binding 准备。                                    |
| Hosted Harness 与 Runtime worker      | 复用执行、状态、取消和历史协议，不新增公共路由或模型选项。                             |

## 发布与边界

应用 V15 和重新开放执行前，排空并停止所有旧 Broker、控制面和维护写入端。旧二进制不理解成员资格，不支持混合写入端。保留旧数据和原执行证据。回滚需要兼容版本或完全排空的 catalog，不能删除成员或未知执行强行回滚。现有 CSI 限制不变。

本次让 READY binding 上的 UNKNOWN 工具结果不再阻塞无关普通 Session；不修复未知结果、不绕过 placement 恢复、不证明逃逸 writer 已停止、不增加文件事务隔离、不实现 CSI 并发、不改变子任务准入，也不修复独立的 Skill 空展示。未证明停止的 writer 仍阻止维护。开发期间不修改原故障部署。

## 验证与验收

- 先验证全局 CLI，并在实现前确认当前 Java/Broker 竞争行为；CLI 无法访问内嵌占用 store 时说明 Java/API 替代依据。
- 两个独立 SQL 客户端和两个 Broker 进程可同时持有同一物理目录的普通成员。A 阻塞或 UNKNOWN 时，B 的真实工具调用仍可完成；A 保留原 status/cancel 身份，不能重放。
- A 的释放、取消、mount 归还、关闭和恢复不能清除 B。跨租户 alias、过期 generation、损坏旧 holder、权限撤销和 CSI profile 混淆明确拒绝。
- 维护与获取竞争只有一方先进入；物理操作等待全部成员，包括 RELEASED 但残留 claim 的行。丢失清理和保留清理不能丢弃其他 binding 的 claim。
- 串行撤销继续可用。其他成员释放后，之前发生过重叠的 Session 可通过现有历史实现撤销。当前仍有其他成员占用时返回冲突，无文件效果。独占撤销拒绝晚到获取；不确定结果保留独占。
- 运行针对性 H2 测试、Maven verify、独占 MySQL 8.4 并发/schema 测试，以及使用构建 CLI 的真实进程 Hosted 并发测试。完整 diff 连续两轮自审无问题后，再进行独立审查。

### 验证结果

在主干基线 `461be87304c7b3b5d64b701207c49f236515d5fd` 上完成本地验证，环境为 macOS、JDK 21、Node 22.22.3 和临时 MySQL 8.4.11：

- frozen-lockfile 安装及正常 prepare 完成根目录 build、bundle；typecheck 也已通过。聚焦 H2/schema 145 项全部通过，无跳过。
- 完整模块验证共 5,145 项 unit/H2：5,127 通过、18 跳过，零失败和错误。跳过项有明确的 macOS、SSH interop、Kubernetes、worker bundle、MySQL 锁/一致性读取或互斥 admission profile 条件。同一 `verify` 命令通过两套 Checkstyle 和高置信度 SpotBugs。
- 九个受影响的完整 MySQL 类共 202 项全部通过，无跳过：Managed Agent、creation schema、严格 CSI inventory、恢复、保留清理、保留清理竞争、SSH 存储、CSI checkpoint 和迁移。这是指定测试类的覆盖，没有重跑完整 MySQL 套件。
- 使用同步主干后的 CLI bundle，故障 profile 全部 44 项和独立 Hosted 并发 2 项均通过，零失败、错误和跳过。
- 独立真实进程探针每组使用两个 Broker JVM 和真实 Node worker。A 保持 prepared 或持有注入的 UNKNOWN 记录时，B 可完成工具工作；精确释放保留相邻成员，UNKNOWN 不能重放。B 完成只读 `read_file` 并释放后，A 的真实历史实现完成 no-op 撤销，返回 `conflict:false`、无失败文件，并清除临时独占。
- 现有 MCP Spring 重启/释放 gate 在 MySQL 上通过，保留原 binding 和 Runtime Session 身份，以及重启前保留、重启后保留、最终释放的 `1 → 1 → 0` 成员期望。
- 临时 MySQL 经端口、数据目录和 PID 验证，确认无其他客户端后正常关闭。私有数据已删除，日志保留。独立探针记录的进程及独立 Hosted 记录的 5 个进程 PID 均已退出，独立探针的两个私有 H2 服务均已停止。

进程探针在 macOS 使用合成物理身份和注入的 UNKNOWN 状态，不能证明 Linux/Windows 原生物理验收、真实 SSH worker、整机重启、完整 Hosted/MySQL 矩阵或模型驱动的 WebShell 会话。真实撤销探针使用实际快照完成 no-op，不代表验证了修改后文件的字节恢复。生产部署不在本次验证范围。

## 开放问题

本次范围没有待决问题。跨 Session 文件隔离或更强的修改归因、CSI 并发、公共等待原因展示，以及放宽现有子任务准入限制，均为后续事项，不隐含宣称已完成。
