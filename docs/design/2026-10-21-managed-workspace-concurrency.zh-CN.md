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

## 文件历史

并发编辑采用 Legacy 的共享文件语义：不同 Session 可能覆盖彼此文件，Shell、Hook、MCP 的效果不是事务。其他 Session 若在写入完成和最终指纹读取之间修改文件，现有指纹检查无法可靠归因。

过去发生过执行重叠不会禁用文件撤销，包括仅有读取的重叠。不存储持久的重叠标志，普通执行获取也不为此创建或更新历史 head。其他成员释放后，该 Session 可以通过现有 runtime/history 实现请求撤销。保留现有逐文件历史检查；本次不增加跨 Session 文件事务或修改归因保证。

撤销前，在物理行锁下确认没有其他成员，将自身成员升级为独占。若仍有其他成员持有占用，则返回现有冲突结果。新的获取会拒绝，直到撤销结果返回。成功完成后降回普通成员；结果不确定则保留独占成员，供原操作恢复。复用现有 Hosted 冲突回执和 pending-undo 处理，不修改历史 wire 格式或 UI API。

## 生命周期与恢复

物理注册、fence、恢复原目录、子 Workspace 维护和存储迁移，除现有 holder、writer 检查外，还要求不存在任何成员。即使 Runtime Session 被本地标记为 RELEASED，残留成员仍算占用。维护先获取则排除后续执行；执行先获取则阻止维护进入物理步骤。

停止已排空 worker 时，只验证该 binding 的执行和 Session 证据。同目录另一个 worker 的正常使用不应阻止停止本 worker。丢失 worker 清理要求原持久化停止证据和操作 claim，然后仅清除该 binding/generation 的成员。停止后的 Session 释放仅清除该 Session。保留清理不能删除仍有成员引用的 binding。

操作员恢复继续绑定精确 Runtime Session 身份。若一个 binding 有多个持有成员，仅凭 binding 准备恢复会明确拒绝，其他成员需先正常结束。已准备操作继续验证其精确成员和 digest。UNKNOWN 的 status、cancel 保留原执行身份，并继续禁止重放。

现有 Runtime placement 恢复屏障保持不变。binding 仍为 READY 时，工具结果 UNKNOWN 不再排除另一个普通 Session。binding 进入 LOST、DRAINING、OPERATOR_RECOVERY，或已完成 attestation 的 RECOVERY_BLOCKED 后，其恢复范围内的新 placement 仍须等待现有物理恢复门槛通过。本次不允许替换 worker 绕过该门槛。

## 各组件改动

| 组件                                  | 改动                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| 共享 schema 与 projection             | 新增 V15，不改已发布迁移；严格 CSI inventory 纳入新字段，要求 CSI 行没有普通成员资格。 |
| Workspace execution store             | 共享获取、精确释放、独占撤销、完整维护占用和限定范围的丢失清理。                       |
| Runtime transport                     | 获取和执行仍验证原成员；当前占用冲突复用现有结果，撤销结果不确定时保留独占。           |
| Storage guard                         | inspect、注册、fence、restore 和捕获注册验证均检查所有成员。                           |
| Binding repository 与 retention guard | CAS 保留成员；精确停止释放、关闭检查和保留引用。                                       |
| 操作员恢复                            | 解析并约束精确持有成员；拒绝有歧义的 binding 准备。                                    |
| Hosted Harness 与 Runtime worker      | 复用执行、状态、取消和历史协议，不新增公共路由或模型选项。                             |

## 发布与边界

全新安装初始化 schema V15，并使用匹配的 Server 和 Broker 构建。普通执行仅以 Runtime Session 成员作为占用依据，不转换或回退到之前的 singleton 表示。CSI 预留和物理维护身份继续承担各自现有职责。

现有 canonical V1–V14 catalog 必须先排空再切换，不支持新旧版本混跑的滚动升级。停止接收新 Turn，使用旧构建完成执行或恢复并释放全部普通 LOCAL/SSH_LOCAL holder。停止旧 Server、Broker、Harness、Runtime worker 和其他存储 writer 后，确认 `ma_storage_owner` 中所有满足 `storage_kind IN ('LOCAL', 'SSH_LOCAL')` 且 `maintenance_id IS NULL` 的行均没有非空 `holder_key`，才可应用 V15 并启动匹配构建。writer 清理尚未确认的 UNKNOWN holder 必须保留在旧部署，直到恢复和释放成功；不能手动清除其占用，也不能将新构建连接到该 catalog。此发布前提不向 V15 或运行时清理加入兼容处理。

本次让 READY binding 上的 UNKNOWN 工具结果不再阻塞无关普通 Session；不修复未知结果、不绕过 placement 恢复、不证明逃逸 writer 已停止、不增加文件事务隔离、不实现 CSI 并发、不改变子任务准入，也不修复独立的 Skill 空展示。未证明停止的 writer 仍阻止维护。开发期间不修改原故障部署。

## 验证与验收

- 先验证全局 CLI，并在实现前确认当前 Java/Broker 竞争行为；CLI 无法访问内嵌占用 store 时说明 Java/API 替代依据。
- 两个独立 SQL 客户端和两个 Broker 进程可同时持有同一物理目录的普通成员。A 阻塞或 UNKNOWN 时，B 的真实工具调用仍可完成；A 保留原 status/cancel 身份，不能重放。
- A 的释放、取消、mount 归还、关闭和恢复不能清除 B。跨租户 alias、过期 generation、权限撤销和 CSI profile 混淆明确拒绝。
- 维护与获取竞争只有一方先进入；物理操作等待全部成员，包括 RELEASED 但残留 claim 的行。丢失清理和保留清理不能丢弃其他 binding 的 claim。
- 串行撤销继续可用。其他成员释放后，之前发生过重叠的 Session 可通过现有历史实现撤销。当前仍有其他成员占用时返回冲突，无文件效果。独占撤销拒绝晚到获取；不确定结果保留独占。
- 运行针对性 H2 测试、Maven verify、独占 MySQL 8.4 并发/schema 测试，以及使用构建 CLI 的真实进程 Hosted 并发测试。完整 diff 连续两轮自审无问题后，再进行独立审查。

### 验证结果

基于 `48e2adc0b5bb3b65c608abf8188702ca938bdfeb` 完成单一占用表示的清理验证，环境为 macOS、JDK 21、Node 22.22.3 和临时 MySQL 8.4.11：

- 94 项聚焦 H2 用例全部通过，无跳过。完整模块验证覆盖 349 个类、5,144 项 unit/H2：5,126 通过、18 跳过，零失败和错误。两套 Checkstyle 和高置信度 SpotBugs 均通过。跳过项需要当前不可用的平台、SSH/Kubernetes/worker fixture、MySQL 锁/一致性读取语义或互斥 admission profile。
- 四个类的八项指定 MySQL 用例全部通过，无跳过：原成员恢复与 operator prepare、LOCAL/SSH_LOCAL 停止成员清理与恢复批次、精确 CSI/成员保留，以及查询规模契约。这是指定方法/类的覆盖，没有重跑完整 MySQL 矩阵。
- 15 项指定重启、丢回复和存储并发故障用例、2 项独立 Hosted 并发用例，以及 10 项指定 Hosted MCP 丢回复/存储故障/Spring 重启用例全部通过，零失败、错误和跳过。MCP 恢复在确认释放前保留原成员，随后清除该成员。
- 五组独立私有探针均正常退出，确认旧普通 singleton 不作为执行占用依据，也不会被转换或清除。实际 Broker JVM 和 Node worker 保持正常共享执行、精确释放与 UNKNOWN 不重放。只读相邻成员释放后，真实历史实现完成 no-op 撤销，返回 `conflict:false` 并清除临时独占。真实 worker 丢失后，通过合成重启证据完成保存成员恢复。
- 独立探针记录的 9 个和独立 Hosted 记录的 5 个 Broker/worker PID，以及记录的 14 个 MCP stdio PID 均已退出。两个独立私有 H2 服务停止。临时 MySQL 经端口、数据目录、UUID 和 PID 验证，确认无其他客户端后正常关闭；数据已删除，日志保留。

整个验证期间，受版本控制的 Java/POM 输入和现有 CLI bundle 保持不变。本次清理没有修改 TypeScript 或共享 API，因此没有重跑或将较早根目录 build/typecheck 计为本次验证。修改过的 Linux 专用扩展/公开关闭用例和可选 cancellation/provider-control/Shell-output/operator 进程模式已编译，但未全部执行。macOS 进程 fixture 使用合成物理身份和注入的 UNKNOWN/重启证据，不能证明 Linux/Windows 原生验收、真实 SSH worker、实际整机重启、硬件 CSI/Kubernetes 验收、生产部署或模型驱动的 WebShell 会话。真实撤销探针是成功 no-op，不代表验证了修改后字节恢复。

## 开放问题

本次范围没有待决问题。跨 Session 文件隔离或更强的修改归因、CSI 并发、公共等待原因展示，以及放宽现有子任务准入限制，均为后续事项，不隐含宣称已完成。
