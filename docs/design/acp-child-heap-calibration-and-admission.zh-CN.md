# ACP 子进程堆校准与准入设计

[English](acp-child-heap-calibration-and-admission.md) | [简体中文](acp-child-heap-calibration-and-admission.zh-CN.md)

## 1. 状态与决策

本文记录未来为 daemon ACP 子进程应用固定堆上限所需的证据和设计边界，不启用强制模式。`observe` 仍为默认值，`limits.memory.enforced` 仍为 `false`，生产子进程继续使用旧的宿主机派生堆参数。

有效的 Node 24 校准集包含八次运行、184 个真实模型回合和 360 次精确工具调用，覆盖长会话、多 MCP 和四子进程并发负载。在这些受限负载中，544 MiB old-space 上限完成了任务，并至少保留 434.03 MiB 的实测老生代余量。这支持将 544 MiB 保留为限定范围的实现候选值，但不能证明它是通用安全上限，也不能约束进程 RSS、证明最大部署并发、多小时稳定性或可接受的 GC 与延迟阈值。

精简的[机器可读汇总](acp-child-heap-node24-calibration-summary.json)保留环境标识、协议与下载清单哈希、有效运行指标、排除尝试的来源和决策。逐回合及完整原始派生证据继续单独归档，不提交到 `docs/design/`。

前置容量阶段均已交付：[#11911](https://github.com/QwenLM/qwen-code/pull/11911) 通过显式开启的 `admit` 模式实现仅按数量准入，[#11940](https://github.com/QwenLM/qwen-code/pull/11940) 在容量满时回收符合条件的空闲 ACP，[#12008](https://github.com/QwenLM/qwen-code/pull/12008) 允许用户查看并停止 workspace runtime。这些阶段都没有应用固定子进程堆上限，剩余工作由 [#8182](https://github.com/QwenLM/qwen-code/issues/8182) 跟踪。

## 2. 证据

### 2.1 为什么需要重新测量

较早的[注册与恢复报告](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5621875474)、[真实模型并发阶梯](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628271115)、[较重的读取与搜索负载](https://github.com/QwenLM/qwen-code/issues/11386#issuecomment-5628813819)和[受限宿主探针](https://github.com/QwenLM/qwen-code/issues/8182#issuecomment-5622379643)确认了注册成本、实测 RSS 和子进程参数。归档采集器没有记录子进程老生代峰值、major GC 后 live-set、major GC 次数或覆盖率，因此不能通过 RSS 推导安全的 V8 old-space 上限。

新实验在同一源码构建、Linux 宿主、provider、fixture 和隔离 Node 24 运行时上，对比当前基线与实验性 544 MiB 参数。实验验证了实际子进程参数、精确工具正文送达、每个代次的新鲜堆覆盖、major GC 观测、OOM 计数和清理结果，没有修改生产模式或默认值。

### 2.2 当前分区模型

`resolveDaemonMemoryBudget` 与 `createChildHeapPolicy` 在 daemon 启动时解析一次不可变分区。使用当前默认值时：

| 可用内存，MiB | 有效预算 | Root 保留 | 子进程池 | 子进程名额 | 每个子进程上限，MiB |
| ------------- | -------- | --------- | -------- | ---------- | ------------------- |
| 2048          | 1024     | 256       | 768      | 1          | 768                 |
| 4096          | 2048     | 256       | 1792     | 3          | 597                 |
| 6144          | 3072     | 307       | 2765     | 5          | 553                 |
| 7265          | 3632     | 363       | 3269     | 6          | 544                 |
| 8192          | 4096     | 409       | 3687     | 7          | 526                 |
| 32768         | 16384    | 1024      | 15360    | 25         | 614                 |

`MIN_CHILD_HEAP_MB = 512` 是策略下限，不是实测需求。模型可以返回零名额和空上限；强制路径不能下发 `--max-old-space-size=0`。

这台 4 核宿主有 7,265 MiB 物理内存，对应的模型分区是六个名额，每个 544 MiB。更早的高并发成功运行测量的是未强制该分区时的负载 RSS，因此不会改变这套算术。

### 2.3 有效的 Node 24 结果

有效证据使用 Node 24.21.0，对比 3,632 MiB 的旧基线和 544 MiB 候选值。由于失败尝试被保留，而修正后的实验使用新批次标识，因此结果明确归属于四个协议。

| 负载   | 有效配对数 | 每轮回合数 | 每轮子进程数 | 候选组老生代峰值，MiB | 候选组最小实测余量，MiB |
| ------ | ---------- | ---------- | ------------ | --------------------- | ----------------------- |
| MCP    | 1          | 8          | 1            | 106.20                | 437.80                  |
| 长会话 | 2          | 36         | 1            | 109.97                | 434.03                  |
| 并发   | 1          | 12         | 4            | 93.71                 | 450.29                  |

八次有效运行均完成计划回合和工具调用，没有模型 API 错误或重试，观测到新增 major GC，并通过清理检查。长会话运行在 36 个回合内保持同一会话和子进程代次，交付 72 个不同页面，最终上下文用量为 300,217 至 311,090 token。并发配对在四个 ACP 子进程上执行三波任务；其请求 schema 采集显示每个对照臂有 36 个 provider 请求，24 个带工具的请求均暴露 `read_file`，没有暴露 `tool_search`，也没有解析失败。

这些指标是观测高水位。live-set 是 major GC 后采样得到的上界。进程树 RSS 包含 daemon 和已观测后代，不是唯一物理内存。精确正文送达和用量计数不能证明语义理解，也不能证明全部历史上下文仍然驻留。

### 2.4 被排除的尝试与剩余缺口

三个失败的 Node 24 尝试继续排除：

- 一次长会话在第 13 回合没有返回必需工具调用；响应没有归档，因此原因未知。
- 一次 baseline 长会话在第 22 回合收到模型服务内部错误；随后使用相同采集器和负载，在新批次标识下完整重试一次。
- 一次四子进程候选运行调用了两次未注册的 `tool_search`。后续并发协议采集 provider 工具 schema，并重新执行完整配对，但不会反向将该失败尝试视为有效。

证据仍未覆盖在同一个 Node 24 子进程内保留多个会话、更广泛的真实负载、显著更大的上下文、多小时稳定性、其他宿主分区或发布阈值，因此不能声明可以作为生产默认值。保留当前限定范围结论不要求把每一份历史原始派生记录都提交到仓库。

## 3. 当前实现边界

| 组件                                                      | 当前行为及影响                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/daemon-memory-budget.ts`         | 解析宿主机或 cgroup 分母、root 保留和子进程池。                                              |
| `packages/acp-bridge/src/child-heap-policy.ts`            | 计算固定模型上限和名额数。`off` 关闭建模，`observe` 报告假设拒绝，`admit` 只强制子进程数量。 |
| `packages/acp-bridge/src/spawnChannel.ts`                 | 先预留再判断，并可请求空闲回收，但新子进程仍使用旧堆参数。                                   |
| `packages/acp-bridge/src/process-registry.ts`             | 对预留和已附加子进程计数，直到被跟踪进程清理证明名额可以释放。                               |
| `packages/cli/src/serve/idle-acp-reclamation.ts`          | 仅回收符合条件的空闲 runtime，排除活跃或存在依赖工作的 runtime。                             |
| `packages/cli/src/serve/routes/workspace-runtime-stop.ts` | 允许用户查看并明确停止所选 runtime；清理未完成时继续展示并计数。                             |
| `packages/cli/src/serve/run-qwen-serve.ts`                | 让 daemon runtime 工厂共享同一个进程注册表、策略和空闲回收器。                               |
| `packages/cli/src/serve/daemon-status.ts`                 | 发布子进程 RSS、堆峰值和覆盖信息，同时报告 `limits.memory.enforced: false`。                 |

多个会话可以共享一个 ACP 子进程。注册数量、会话数量、活跃 prompt 数和 channel 存活状态都不能代替真实进程预留。因此 workspace 注册继续与子进程容量解耦，正在终止的子进程在满足现有注册表释放条件之前继续占用名额。

## 4. 强制模式提案

### 4.1 模式与受支持接线

剩余发布决策确定后，在现有 `--child-heap-mode` 选项及 SDK 类型中增加 `enforce`。保持 `off`、`observe` 和 `admit` 行为不变。在构造子进程工厂之前解析一次模式与预算；修改后需要重启 daemon。本提案不增加环境变量，也不增加 workspace 注册上限。

第一版强制路径必须使用内建 daemon 启动路径、一个共享进程注册表和一个共享堆策略。对不受支持的注入 bridge 或 factory，在开始监听前直接拒绝。预热前拒绝零名额或空上限配置。Standalone ACP、IDE 和直接嵌入调用者保持现有行为，除非另行接线并记录为受支持路径。

### 4.2 预留、启动与释放

复用 `ProcessRegistry.reserve()` 与 `committedProcessCount`。先预留，将新预留计入容量判断；拒绝时在 `spawn()` 前取消预留。策略判断或 spawn 失败时，现有错误路径也必须释放预留。

获准的子进程只下发一个明确的 `--max-old-space-size=<ceiling>`，同时保留 `--expose-gc`。在强制路径中归一化继承的固定 old-space 参数，并拒绝 `--max-old-space-size-percentage`，因为百分比参数优先级更高。保留其他无关 Node 参数。

附加成功后由进程注册表负责释放。发送信号或关闭 ACP 流不能证明清理完成。替换期间旧、新子进程都需要占用名额，直到旧子进程真正释放。第一版不增加预算外替换名额，也不增加等待队列。

强制保证仅限：

```text
已提交子进程数量 × 固定 old-space 上限 <= 子进程池
```

它不约束 ACP RSS、年轻代、外部缓冲、MCP 服务、终端或 daemon 进程树总内存。

## 5. 失败与状态契约

复用 `acp_child_capacity_exhausted`。REST 返回 503；ACP 使用既有错误信封并携带等价的机器可读元数据。不自动重试，也不回退到 primary workspace。

通过既有包装层保留容量原因，包括 `StandaloneSessionSpawnError` 和 `WorkspaceRuntimeInitializationError`，同时保留各操作的回滚和持久化结果。工厂拒绝可能发生在 worktree、branch 或 session 状态已经变化之后，因此调用方不能假设整个请求没有副作用。

只有完整接线的内建强制路径才能将 `limits.memory.enforced` 设为 true。观察模式拒绝仍是假设判断；强制模式拒绝表示没有启动新子进程。现有空闲回收和用户主动停止 runtime 的行为保持不变。

## 6. 验证与交付

实现 PR 必须覆盖两个 parser 和所有受支持的子进程工厂、最后一个名额的竞争、取消、同步与异步启动失败、终止重叠、清理失败、关闭、零容量、多会话共享、满容量时注册、继承堆参数，以及 REST、ACP、standalone 和 runtime coordinator 的错误原因保留。

执行聚焦包测试、build、typecheck、bundle 和真实 daemon E2E，确认实际子进程参数和状态输出。生产发布还需要明确的 GC 与延迟阈值、分阶段开启和回滚标准。

本文档 PR 不修改运行时行为。其验收条件是中英文设计与精简汇总在测量范围、指标、排除项、决策和剩余缺口上保持一致。

## 7. 待决事项

- 明确可接受的 GC 与延迟回退，以及分阶段发布和回滚标准。
- 决定第一版受支持强制范围是否只覆盖已测的 4 核、7,265 MiB 分区和 Node 24 负载。
- 在强制模式成为默认值前，验证每个子进程保留多个会话、更广泛的真实负载、显著更大的上下文、多小时稳定性和其他宿主分区。
- 确定在文件系统或持久化副作用发生后，容量拒绝对应的具体路由结果。

不能从较早的注册或 RSS 容量实验推导这些决策，也不能用假定的 16 子进程上限替换模型分区。
