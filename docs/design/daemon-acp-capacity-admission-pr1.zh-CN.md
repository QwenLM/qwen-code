# Daemon ACP 容量准入 — PR1

[English](daemon-acp-capacity-admission-pr1.md) | [简体中文](daemon-acp-capacity-admission-pr1.zh-CN.md)

## 1. 状态与范围

本设计提案日期为 2026-09-15，核对代码基线 `df864bea6a930d31faf8b35fc5e57bac98a25e20`。随同变更以显式开启模式实现，记录本轮讨论更新：复用现有初始化预算限制 ACP 进程启动，再用后续独立 PR 增加空闲回收和用户主动选择关闭。

PR1 提供显式开启的进程数量限制，以及可操作的容量不足提示。不调整子进程堆参数，不采样实时空闲内存决定准入，不回收空闲 workspace，不主动中断已有工作，也不实现 workspace 选择器。现有回收器继续独立运行。用户要求的简化适用于后续回收机制；PR1 复用已有同步预留流程，不新增锁、队列或分布式准入协议。

建议实现 PR 标题：`feat(serve): add budget-based ACP child admission`。

三个阶段的提案统一由 [#11907](https://github.com/QwenLM/qwen-code/issues/11907) 跟踪。本文细化其中第一阶段，空闲回收和用户主动选择关闭仍由独立后续 PR 推进。

2026-09-15 读取的 [#8182](https://github.com/QwenLM/qwen-code/issues/8182) 仍为 open，剩余范围包括固定堆限额执行及代表性证据；[#11386](https://github.com/QwenLM/qwen-code/issues/11386) 已关闭。PR1 属于相关后续工作，使用 `Related to #8182` 并引用 #11386 作为背景，不使用关闭关键词。仅限制数量不能完成 #8182。

## 2. 当前行为与缺口

| 现有组件                    | 已核实行为                                                                            | PR1 如何使用                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `resolveDaemonMemoryBudget` | 初始化时解析宿主/cgroup 总内存、配置/有效预算、root 预留和子进程池。                  | 原样复用数值及取整规则。                                                   |
| `createChildHeapPolicy`     | `off` 不发布分区；默认 `observe` 计算固定分区并统计假设拒绝。                         | 增加按同一计算上限限制进程数量的模式。                                     |
| `ProcessRegistry`           | 统计已挂接子进程和未完成的启动预留；正在清理的被跟踪对象保留到登记表释放。            | 使用 `committedProcessCount`，不使用已注册 workspace 数或活跃 channel 数。 |
| `createSpawnChannelFactory` | 已在检查策略前预留，当前忽略拒绝结果；同步异常会取消预留。                            | 在原有流程中、`spawn()` 前执行拒绝。                                       |
| `runQwenServe`              | primary、启动时的 secondary 和动态 workspace 工厂共享登记表和策略。                   | 所有工厂使用一个 daemon 全局上限。                                         |
| Session/channel 回收器      | 已关闭符合条件的遗弃会话和空 ACP channel；保持连接的会话不等同于遗弃会话。            | 保留现状；按容量主动回收属于 PR2。                                         |
| REST/ACP/UI 错误            | 容量原因可能被 runtime/standalone 包装吞掉；部分 Web Shell 503 加载失败进入重连重试。 | 保留明确原因，停止容量错误的自动重试。                                     |

一个 ACP 可以保留多个 session。在已有子进程中新开 session 不一定增加进程名额；相反，预热、MCP 操作、channel 替换、恢复和后台工作也可能在不注册新 workspace 时启动子进程。因此准入应放在公共子进程启动边界。

### 2.1 预算计算

之前实测识别为 7265 MiB 的宿主，在默认配置下：

| 数量             | 计算                                         | 结果     |
| ---------------- | -------------------------------------------- | -------- |
| 有效预算         | `floor(7265 * 0.5)`                          | 3632 MiB |
| Root 预留        | `clamp(floor(3632 * 0.1), 256, 1024)`        | 363 MiB  |
| 子进程池         | `3632 - 363`                                 | 3269 MiB |
| 模型名额         | `min(floor(3269 / 512), 25)`                 | 6        |
| 模型单子进程限额 | `min(floor(3269 / 6), legacyChildCeilingMb)` | 544 MiB  |

完整复用现有实现，包括显式 `--memory-budget-mb`、宿主/cgroup 截断、小内存宿主处理及旧限额校验。不要在路由或前端重写公式。如果无法形成满足 512 MiB 模型下限的分区，现有模型返回零名额和 null 限额。

PR1 只把名额数用于实际准入。544 MiB 仍是模型值，真实子进程堆参数继续走 `getAcpMemoryArgs()`。六个名额代表配置的并发上限，不证明任意六个负载能放进内存。初始化的 `availableMemoryMb` 是解析后的宿主/容器总量，不是实时空闲内存。既有堆校准仍服务于后续固定堆变更，但不是这个独立的数量限制模式的前置条件。

## 3. 配置与兼容性

在现有 `--child-heap-mode` 和 `ChildHeapMode` 中增加 `admit`；不新增环境变量、独立预算公式、按 workspace 平分的分母或单独的最大进程数配置。

| 模式                      | 计算/发布分区 | 拒绝超额 ACP 启动 | 应用模型堆限额 |
| ------------------------- | ------------- | ----------------- | -------------- |
| `off`                     | 否            | 否                | 否             |
| `observe`（默认不变）     | 是            | 否                | 否             |
| `admit`（新增、显式开启） | 是            | 是                | 否             |

实现后的使用示例：`qwen serve --child-heap-mode admit`。现有 `--memory-budget-mb` 覆盖项通过原有公式影响名额，也保留其既有 journal 预算效果，并不是专用并发开关。预算和模式在 daemon 生命周期内固定，修改需要重启。PR1 不增加 `enforce`，也不暗示 `admit` 强制执行堆/RSS 预算。

同时更新快速解析、完整 CLI choices/help、编程接口选项、策略类型和 SDK 状态镜像。保留 `off`/`observe` 行为、旧子进程参数、workspace 注册上限及 workspace/全局 session 上限。未显式开启的升级不得引入容量拒绝。

支持托管的 `runQwenServe` 启动链路。对注入 bridge 或未接入准入的直接嵌入工厂，拒绝 `admit`，不能接受一个实际无效的配置。公开的准入工厂必须显式接收共享登记表。缺少托管准入接线的直接 `createServeApp` 调用拒绝 `admit`；托管 server 构建应传递真实的共享登记表/策略引用，不能把仅用于状态的快照回调当作限制已生效的证明。普通直接嵌入、IDE 及独立 `qwen --acp` 行为保持不变。

零名额的 `admit` 配置无法工作。应在启动监听器或预热前校验，以配置错误报告预算/模型失败。`off`、`observe` 保留既有小内存宿主行为。有效配置启动后，在登记表/策略安装前，bootstrap 状态仍明确表示尚未接线。

## 4. 准入与生命周期

复用现有启动事务：

1. 在唯一共享的 `ProcessRegistry` 中预留。
2. 使用包含本次预留的 `committedProcessCount` 调用策略。
3. `admit` 模式下，若该数值大于 `maxConcurrentChildren`，在 `spawn()` 前抛出 `AcpChildCapacityExceededError`，由现有 catch 取消预留。
4. 否则使用原有内存参数启动，并挂接到预留。
5. 保留现有退出、失败、abort 和清理释放行为。

预留前规则是 `committed < limit`，预留后规则是 `committed <= limit`。六名额上限下，已占五个允许再开一个，已占六个则拒绝第七个。保持 reserve/check/spawn 同步，中间不增加 `await`。两个启动同时争抢最后一个名额时不能都通过。

复用已有子进程时不增加 session 级的准入检查，原有 session 上限仍然生效。Primary 预热进程在驻留期间占名额；临时 workspace 控制进程及托管后台启动也占名额。PR1 做准入决策时不检查其他子进程是否忙碌或空闲。

Channel 替换时旧进程持续占名额，直到登记表释放，因此满容量可能拒绝替换。不临时多给一个名额、不关闭其他 workspace，也不循环重试替换。保留发起操作既有的 drain/回滚结果。拒绝 spawn 本身不会创建新子进程，但不能据此声称整个请求此前没有文件系统或生命周期变更。

登记表清理语义保持不变：发出信号或关闭流本身不等于名额释放；被跟踪根进程/已知所有权范围释放，也不证明所有可能的后代都被观测或终止。PR1 不重写后代进程统计。

## 5. 错误与所有权

在既有 bridge 错误入口增加一个共享类型，通过现有 package 入口导出。固定 wire code 为 `acp_child_capacity_exhausted`，REST 为 503，ACP 使用现有错误 envelope 携带等价机器码/状态元数据。拒绝时附带 `maxConcurrentChildren` 和 `committedAcpChildren`；后者不含已拒绝的预留，但包括被跟踪的清理中进程。这只是有界的错误时刻快照，不为稍后的重试保留名额。

普通 REST 拒绝把 code 和计数放进现有 JSON 错误 body。ACP 使用 `RPC.INTERNAL_ERROR`，携带 `data.errorKind: 'acp_child_capacity_exhausted'`、`data.httpStatus: 503` 及同样的计数。现有 SDK 将此 payload 保留在 `DaemonHttpError.body.data`，前端识别器必须同时支持 `body.code` 和 `body.data.errorKind`，不匹配消息文本，也不重写传输归一化。已经开始响应的流沿用现有终止错误格式并保留容量原因，不能在发送 headers 后再修改 HTTP 状态。

此错误不发送 `Retry-After`，也不承诺经过固定时间就恢复。不要全局改变其他 503、鉴权、限流或传输错误的处理。调用方可以在用户主动操作或之后一次独立操作时重试；不增加自动等待队列、立即降级或 daemon 容量重试循环。

| 消费者/操作                                      | 所有权                                    | 要求                                                                                           |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 状态与共享策略                                   | Process-global                            | 所有托管 workspace 工厂报告相同的全局上限/计数。                                               |
| Workspace 注册/持久化历史列表                    | Persisted-workspace scoped                | 不启动 ACP 时不新增容量门槛；注册保持独立。                                                    |
| Primary 预热/legacy-primary 接口                 | Legacy-primary                            | 子进程计数，保留启动诊断及 primary 所有权。                                                    |
| Session 创建、runtime ensure、workspace MCP 控制 | Selected-runtime                          | 返回该 runtime 的容量原因，不回退 primary。                                                    |
| 活跃 prompt/attach、恢复、fork 和故障恢复        | Live-session-owner 或选定的持久化 owner   | 复用活跃子进程不增加计数；实际启动时执行准入，跨 await 保留解析好的 owner。                    |
| Conversations standalone 创建                    | Standalone session 的解析后 runtime/owner | 回滚后保留容量原因，不抹去原有创建结果元数据。                                                 |
| Channel worker 与定时执行                        | 各自选定的 runtime/session owner          | ACP 启动共享准入；外部 worker 本身不算 ACP。使用现有任务报告渠道呈现失败，不增加容量重试循环。 |

保留 `WorkspaceRuntimeInitializationError` 和 `StandaloneSessionSpawnError` 内的原因。在已知包装路径中，完成既有清理/结果处理后识别并保留容量原因。Generation 关闭、removed、untrusted、draining 及执行/回滚不确定等结果保留原有优先级；不能因为容量错误就把不安全的整请求重试标成安全。不递归拆解无关异常，也不把所有包装异常替换为 503。

Runtime 初始化的容量原因应在通用 `runtime_initialization_failed` 及其现有 `Retry-After: 5` 响应前进入专用映射。Standalone 创建保留 `standalone_creation_rolled_back`、session ID 和既有结果字段，仅在确认 `!dispatched` 且持久化 session 不存在后，附加包含容量 code 与计数的有界 `capacity` 对象。相同的 UI helper 也识别该嵌套原因。派发后失败或不存在校验失败继续走既有 unknown-outcome/quarantine 路径，不能因为内部工厂错误是容量不足就绕过这些校验。

仅这一类已确认与容量有关的 standalone 回滚由现有 500 改为 503，并去掉 `Retry-After`；普通回滚响应不变。REST body 和 RPC data 都传递 `capacity`。UI helper 同时识别 `body.capacity.code`、`body.data.capacity.code`，保留外层回滚分类。已有 retryability/结果对于用户主动重试的含义不变；新增容量 UI 分支无论该标志如何都停止自动重试。

验证 REST session 创建/load/fork/恢复、runtime ensure、MCP 准备/变更、Conversations、直接 ACP dispatch、预热及后台入口。只断言 503 不够，还应断言容量 code 或保留的容量原因，以及 owner 对应的结果语义。

## 6. 状态与 Web Shell

保留 `limits.memory.enforced: false`，明确表示没有应用模型子进程堆限额。在 `limits.memory.childHeap` 内增加 `admissionEnforced: boolean`，仅完整接线的托管 `admit` 路径为 true。保留 `mode`、`maxConcurrentChildren`、模型 `perChildCeilingMb` 和 `refusals`。`observe` 的 refusals 仍是假设拒绝，`admit` 则记录真实准入拒绝；零计数不证明内存安全。

增加 `runtime.memory.committedAcpChildren`，直接来自共享登记表。`activeAcpChildren` 及 RSS/上报覆盖语义保持不变：它们统计活跃 channel，不包含未完成预留及 dying channel。无法从登记表报告时使用 null，SDK 对新增字段使用 optional 以兼容旧 daemon。Bootstrap 尚未构造策略，保持 `childHeap` 为 null，不虚构一个活跃数量零值。沿用共享策略的托管 server/status 链路接入 getter。

复用 Web Shell 既有错误/banner 和草稿会话界面。建议中文提示：

> 已达到当前服务的并发容量上限，暂时无法启动此会话。请稍后重试，或取消本次操作。

建议英文提示：

> The service has reached its concurrent process limit and cannot start this session. Try again later or cancel this operation.

使用“容量上限”，不能声称实时内存已经耗尽或所有 workspace 都忙碌。PR1 不选择其他 workspace 关闭。复用现有取消/关闭提示流程：停止本地等待/重连尝试，新会话保留草稿和附件，恢复失败保留选中会话/历史。取消不删除已注册 workspace 或持久化会话。已经失败的请求不是后台排队中的创建。

在 Web Shell 通用 503/session-load 重试路径之前识别机器码。容量拒绝不重复重连、不自动降级为 create，也不自动重放 prompt。用户主动重试只能在原有副作用/结果检查后重复对应操作。Session 创建、恢复、首条消息及命令快捷入口都应展示一致、可理解的原因；诊断可保留技术计数，但原始策略/堆标识不进入用户操作界面。

主连接 Provider 位于 App 语言上下文之外，因此连接错误使用明确可读的英文容量兜底；App 操作错误和 MCP 提示使用当前界面语言。具体复用创建操作的 action notice/ToastHost、加载失败的 connection error 状态，以及 MCP manager 已有的 inline management notice。容量分类应发生在 `actions.ts` 发出通用 notice 并标记 `_alreadyDispatched` 之前，仅修改 App 的 `reportError` 会被抑制。`DaemonSessionProvider` 需要在普通 workspace-load 503 退避之前增加容量分支，不能将其当作 session 不存在。普通首条 prompt 和 inline `!shell` 已延迟清空输入；无 session 的 `/goal set` 当前在异步创建前就接受输入，失败时需要同样延迟接受。保留现有导航语义：切换目标可能 detach 旧面板，取消不承诺事务式恢复之前的 attachment。不要复用 `SessionRecoveryBanner`，它用于已连接会话的 transcript 恢复。

## 7. 实现落点

| 区域       | 预计文件/接入点                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 策略与启动 | `packages/acp-bridge/src/child-heap-policy.ts`、`spawnChannel.ts`、`bridgeErrors.ts` 及公开导出，复用 `process-registry.ts`。                                                                                                                                                           |
| CLI 与接线 | `packages/cli/src/commands/serve.ts`、`serve/fast-path.ts`、`serve/types.ts`、`serve/run-qwen-serve.ts`、`serve/server.ts`、`serve/daemon-status.ts`。                                                                                                                                  |
| 原因传播   | `serve/server/error-response.ts`、`serve/acp-http/dispatch.ts`、`serve/workspace-runtime-coordinator.ts`、`serve/conversations/standalone-session-service.ts` 及既有错误类型。                                                                                                          |
| SDK 与 UI  | `packages/sdk-typescript/src/daemon/types.ts`；Web Shell `daemon/session/httpErrors.ts` 或现有 code helper、`daemon/session/DaemonSessionProvider.tsx`、`daemon/session/actions.ts`、`App.tsx`、MCP 管理提示及现有语言资源。SDK 已保留错误 body，仅在测试证明存在缺口时才修改传输实现。 |
| 文档       | 本双语设计；daemon 配置/运维、REST 集成和 serve 协议文档；同步较早固定堆设计的交付边界。                                                                                                                                                                                                |
| 测试       | 同目录策略/工厂、解析/接线、错误映射、runtime/standalone 和 UI 测试；针对性的托管 daemon E2E。                                                                                                                                                                                          |

不顺手重命名无关模块、不增加新调度抽象，也不修改预算公式。实现时根据核实的调用点确定最终文件范围；公共类型链路已能处理时，不在每个路由重复一份错误映射。

## 8. 验证与验收

1. 预算值保持一致，包括显式覆盖、cgroup/宿主截断、7265 MiB 对应六个名额、25 名额封顶及零名额场景。两个解析器均接受 `admit`，默认和旧模式不变。
2. 上限 N 时，不同工厂合计最多准入 N 个托管 ACP/预留，N+1 返回准确容量原因。失败/取消释放预留，正在清理的被跟踪子进程直到登记表释放前仍占名额。
3. `observe` 与 `admit` 下获准子进程的命令行保持一致，包括继承的 Node 配置。测试不能用模型 544 MiB 替代实际参数，也不声称总堆/RSS 有界。
4. 满容量时注册及复用已有子进程仍能工作，复用仍遵循原有 session 上限。REST、ACP、runtime/MCP、恢复及托管后台路径实际需要新子进程时被拒绝，保留 owner、鉴权和 draining 语义。
5. 包装/结果测试覆盖回滚成功、副作用不确定、generation 变化和预热失败。容量原因不被 `runtime_initialization_failed` 或通用重连错误吞掉，也不覆盖更重要的回滚结果。
6. Web Shell 展示一次容量原因，结束 spinner/重试循环，保留新会话文本/附件或恢复状态。取消不产生删除副作用。释放名额后用户主动重试成功，不重复 prompt 或 worktree。
7. 状态准确区分数量准入与模型堆值，正确处理 bootstrap/直接嵌入/旧服务字段，读取启动准入使用的同一登记表。
8. 实现阶段执行 build、typecheck 和对应 package 的定向测试。E2E 先使用全局 `qwen` 跑基线，再使用打包后的实现，在隔离目录和确定性的本地 provider 上验证。证明名额统计及错误交互不需要再跑模型负载/堆校准。

详细 E2E 计划存放在 `.qwen/e2e-tests/daemon-acp-capacity-admission-pr1.md`。验证结合全局 CLI 基线、package 定向测试及隔离的打包 daemon 进程检查；结果和未验证边界记录在测试计划中。此前的堆校准不能作为本次准入实现的验证依据。

## 9. 交付顺序与限制

PR1 同时交付显式开启的数量限制与错误/取消交互。PR2 在准入失败时尝试回收符合条件的空闲子进程，复用现有关闭保护；初版回收仍采用讨论确定的单次资格检查，不新增锁机制。PR3 在没有可回收空闲对象时，增加用户明确选择关闭哪个 workspace 的操作。后续两个 PR 都不是 PR1 拒绝行为的前置依赖。

初期发布继续默认 `observe`，修改默认值留作后续产品决策。显式开启后，原有模型可能明显降低并发；即便实测空闲内存充足，满名额也可能阻止 restart/MCP 操作。已有子进程仍可向旧堆限额增长。这是可预测的进程数量策略，不是 OOM 保证，也不是完整的固定堆强制执行设计。
