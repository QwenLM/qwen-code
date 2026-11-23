# Managed 审批停靠：扩大首个增量的覆盖面

[English](2026-11-22-managed-action-parking-coverage.md) | [简体中文](2026-11-22-managed-action-parking-coverage.zh-CN.md)

状态：提案，实现前设计。日期：2026-11-22。本文接续[审批停靠设计](2026-11-21-managed-action-parking.zh-CN.md)（第四阶段，#18115 已合入），对照 `main` 的 `5714ee4c53` 核实。它逐项处理首个增量排除的等待形态，回答其开放问题 4，以及除团队计划审批外的开放问题 3。由 #18149 跟踪，其阶段 0–5 对应 §6 中的切片。下文的代码引用均对应该提交；标为"待验证"的结论来自代码阅读，未经测试证实，必须在对应切片实现前用测试确认。

## 1. 问题与现状

### 1.1 排除项与它们真正的闸门

首个增量只停靠冷恢复今天已接受的等待（父设计 §2）。排除逻辑分布在三处：停靠资格 `actionParkCandidate`（`packages/cli/src/serve/hosted-harness-session.ts:5123` 起）、continuation 生产者 `captureNativeBatch`（`packages/cli/src/serve/hosted-workspace-tool-turn.ts:4498`），以及冷恢复入口（接管臂 `hosted-harness-session.ts:8386`、审批恢复臂 `:8645-8652`、`resumeSavedNativeBatch` `hosted-workspace-tool-turn.ts:4327`）。

| 排除项                                                             | 代码闸门                                                                                                                   | 根因                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯图片 Prompt                                                      | `hostedOriginalPromptText`（`hosted-harness-session.ts:2882`）只拼接投影 user 记录里的文本 part                            | 闸门比实际需要更严：`executeHostedTurn` 对 `hosted-harness` 来源的输入通过 `readHostedInput`（`packages/cli/src/serve/hosted-input.ts:167`）从持久化 `managed-input` 资源读回完整输入（含附件），文本参数只是其他来源的回退 |
| 后台任务 + 审批                                                    | Store 在 seal 时拒绝：`A parked Turn cannot share a wake-pending or background seal.`（`JournalWriterLifecycle.java:422`） | 3b 证书与停靠证书的组合未定义（父设计开放问题 4）                                                                                                                                                                           |
| 子 Session                                                         | 资格中的 `lineage` 项（`:5131`）                                                                                           | 保守排除。子 Turn 本身就是协调器分派的 `ma_turn` 行，停靠 CAS 可直接适用；风险在于依赖它的 relay                                                                                                                            |
| wake 启动的 Turn（monitor、loop、automation、channel、子结果通知） | `isWakeOwnedInput`（`:2101`、`:5147`）                                                                                     | 这类 Turn 由 Harness 的 wake 泵运行，没有协调器持有的 `ma_turn` 行可停靠；冷加载时泵对"已尝试的 wake 输入"走 `settleCrashedWakeTurnAftermath`（`:1828`），按崩溃结算而不是恢复审批                                          |
| Hooks                                                              | 资格 `session.hooks`；生产者 `:4528`；`resumeSavedNativeBatch` `:4327`；接管 `:8386`                                       | continuation 不含 Hook 证据，恢复臂拒绝带 Hooks 的 Session。但 Hook 证据本身已持久化：每次 PreToolUse/PermissionRequest 都写 `hook_execution` 记录，并有按记录重放的读取方（`hosted-workspace-tool-turn.ts:3576-3740`）     |
| MCP                                                                | 资格 `session.mcp`；生产者 `:4528` 及工具白名单；恢复臂 `:8651`                                                            | 恢复时要求工具定义与冷加载后重新发现的声明深度相等；不保留目录时 MCP server 可能宣告不同定义，导致停靠后无法恢复                                                                                                            |
| extension command-step 审批                                        | 资格 `continuation.plan.commandStep !== undefined`（`:5160`）                                                              | 接管恢复臂已支持（`extensionsCommandStepTakeover`，`:8389-8394`，允许带 Hook catalog），资格只是没放开                                                                                                                      |
| `uncaptured` 批次                                                  | 生产者拒绝：Workspace Shell profile 的普通批次、白名单外的工具、Hooks/MCP、超过 64 KiB 的计划、无摘要的调用                | 最常见的来源是 Shell profile 下的 `run_shell_command` 审批：G3 只为原生文件建立了 continuation，派发前的 Shell 需要自己的正面证据（G3 §4.3）                                                                                |
| v1/v2 审批                                                         | 恢复拒绝含 v1/v2 的批次（G3 §4.1）                                                                                         | 只存在于升级前写入的等待，会自然消失                                                                                                                                                                                        |

### 1.2 一条不变量决定了扩展顺序

冻结后的状态对 journal 而言等同于"进程在等待点被 SIGKILL"（父设计 §4.2）。因此**停靠覆盖面永远不能超过冷恢复覆盖面**。每个切片都必须先让冷恢复接受这种等待，再在同一切片放宽停靠资格。这也意味着每个切片顺带修好了同类等待的崩溃恢复：今天一个等审批的 monitor Turn 遇到 Harness 崩溃，会被按崩溃结算，而不是继续等待。

## 2. 目标与范围

目标：

- 把首个增量排除的等待形态逐项变为可停靠，或者明确说明不支持及理由。
- 每个形态复用 G3 审批 continuation 驱动器与父设计的证书、CAS、解除停靠机制，不另起一套停靠/恢复协议。
- 每个切片单独可评审、单独可回退，并且只放宽共享资格函数中属于它的那一项。

非目标：

- 停靠"父 Session 等待子结果"（`agent` 调用中的父 Turn）。这是一种新的等待类型，没有 Action，需要单独设计（见 §9）。
- 停靠期间交还 Turn 的 Runtime 成员资格（父设计开放问题 2）。
- 公开 Workspace Shell profile + MCP 的 Session：第一阶段从不挂起它们（需要 lifecycle authority）。
- 恢复 v1/v2 等待（§4.8）。
- 团队计划审批。父设计开放问题 3 列出了它，但本文没有分析它的恢复路径，因此它保持常驻，需要单独分析。

## 3. 总体方案

1. **P0：先合并资格函数。** 把冷恢复在恢复审批 continuation 之前要求的 Session 形态条件（无 Hooks、无 MCP、有工具 owner）抽成一个函数，供停靠资格和两个冷恢复入口（接管加载与常驻 redrive）共同调用。journal 状态条件，即 continuation 查找和原始 Prompt，本来就是共享的辅助函数。停靠比恢复更严的条件（lineage、wake 所有权、command-step、grant 能力位）保留为停靠专属条件，各自带一个原因；后续每个切片删掉其中一项，或者放宽共享条件。#18115 已把这次合并列为后续项。之后每个切片只改这个函数加上对应的生产者或恢复臂，不再出现两份"看起来等价"的条件。
   - **拒绝原因。** 停靠资格对每个被拒的等待中 Turn 返回带类型的原因，Harness 在 `suspensionStats` 中、与第一阶段其他计数并列统计这些原因，每个等待只计一次，记在最先让它保持常驻的原因下。现在 `actionParkCandidate` 拒绝时只返回 `undefined`，不说明原因。更糟的是，生产者没能捕获 continuation 的等待（Hooks、MCP、Shell profile、不支持的工具、超大计划）根本不会登记，资格判断连看都看不到。因此 P0 让每个持久化等待都登记：continuation 生产者返回拒绝原因而不是 `undefined`，永远不能停靠的等待带着这个原因登记，extension command-step 等待以 `command_step` 登记。这份计数用于 §6 的顺序调整，并回答开放问题 3。
   - **暴露方式。** #18173 把 `suspensionStats`（包括这些计数）放到实例的内部 metrics 接口上。
   - **没有 Workspace。** 没有 Workspace 的 Session 从不停靠，P0 用测试固定了原因。缓存未命中时，除非开启了 verified recovery，决定投递发给这类 Session 的是普通加载，而普通加载会拒绝未结算的 Turn。但 connector 不会给它发送 tool profile，而没有 tool profile 的 Session 不会得到审批策略（`hostedApprovalForTurn`）：它的工具调用从不请求审批，连 memory 写入也不会，提问也不被接受，所以永远不会有 Action 在等待，也就没有可登记停靠的等待。没有 Runtime 的 memory continuation 只出现在 Workspace Session 上，而它们的决定投递发出的是被动加载。如果将来审批扩展到没有 Workspace 的 Session，它的决定投递必须先改发被动加载。
2. **按切片扩展**（§4），每个切片包含三部分：冷恢复的生产者或恢复臂改动、共享资格函数里的一项放宽、对应的故障与真实进程测试。
3. **契约变化由能力位把关。** 改变 seal 证书形态的切片（S2、S4）由控制面在 writer grant 中多公告一个能力位，Harness 只在看到该位时发送新形态的证书。不新增配置项，能力位随 `qwen.managed-agent.action-parking.enabled` 一起公告。理由：冻结之后 seal 被拒是不可逆的 teardown 失败，虽然有界恢复能收敛，但不应依赖"不支持混跑"来兜底。

## 4. 切片设计

### 4.1 S1：纯图片 Prompt

- **方案。** 放宽停靠资格与两条恢复臂共用的检查 `hostedOriginalPromptText`。user 记录带文字的 Prompt 不变。没有文字时，通过 `readHostedInput` 读回原始输入：带附件的 `hosted-harness` 输入从空文字重新开始，与它的在线 Turn 一致，因为 `executeHostedTurn` 自己会读回附件。其他来源仍要求有文字，因为它们只能依靠文字回退。恢复臂里所有检查 Prompt 文字的地方都用这个函数，包括原来各带一份副本的保存模型请求检查与 memory、skill 结果检查，所以纯图片 Turn 在这些阶段崩溃后也会恢复。
- **已确认。** journal 恢复出的 user 记录带有 inline 图片，所以今天已允许停靠的"文字 + 图片"Prompt 不需要收紧。Harness 测试 "resumes a parked approval with the original image still in its history" 让一个"文字 + 图片"Prompt 停靠、冷加载后 Allow，恢复时交给 model 的历史里仍以 inline 数据保留着原图。该测试替换了 model 函数，因此不会构建请求。发请求时的驱逐不会改变这个结论：每次请求都会在同一轮里，把它从自身历史中驱逐的图片放进内存中的 `InMemoryImagePayloadStore`（`packages/core/src/services/image-payload-references.ts`），再重新附上最近的几张，所以冷加载后 store 为空不会丢图；该模块的 core 测试就是从全新的 store 开始的。因此恢复后的第一次请求对待恢复出的图片，和线上 Turn 在工具调用之后的请求完全一样，本切片的测试检查的是恢复出的历史（§7）。
- **已确认（#18164）。** 运行选项 `prompt: text`（`hosted-harness-session.ts:4486`）的消费方接受空字符串：纯图片 Prompt 的线上 Turn 本来就以空文字运行；恢复时这个选项只用来开启 Turn 的预算，从中解析不出任何指令。S1 的停靠测试和崩溃测试都以空文字恢复。
- **改动面。** 仅 Harness。

### 4.2 S2：后台任务 + 审批

- **方案。** seal 同时携带 3b 的 background hold 与 `parkedTurn`，Store 只在新能力位公告时接受这种组合。父设计 §4.9 第 3 点已定义：后台终态被 Broker 暂存后，走既有的 staged-wake 路径并清除停靠字段。本切片给暂存事务（`JdbcRuntimeStageStore.stageBatch`，现在只设置 wake-pending 与重试字段）补充两步：清除停靠列，并用父设计 §4.6 的 store 方法解除该 Session 的 `hosted_action_parked` 行停靠。这样协调器立即重新分派该 Turn，而不是让被 wake 加载重建出来的常驻 Turn 无人消费事件流，一直等到 `retry_after`。
- **交错顺序。** S2 让暂存事务和停靠 CAS 都先锁 head 行，因此二者串行，只剩三种顺序。(1) 在 seal 之前暂存：seal 走 staged-wake 路径，不记录证书，CAS 找不到证书而失败。(2) 在 seal 与 CAS 之间暂存：暂存清除了停靠列，CAS 同样找不到当前证书而失败；此时暂存的解除停靠还找不到已停靠的行。(3) 在 CAS 之后暂存：暂存清除停靠列并解除该行停靠。在 (1)、(2) 中，协调器把被拒的 CAS 归类为"被唤醒的停靠"，立即重新分派，而不是走 `stream ended before terminal` 的重试。每种顺序都是 S2 的验收用例（§7）。
- **加载路径。** wake 恢复加载带接管标志（已确认）：扫描的 `recoverForWake` 只带被动标志，wake 栅栏的 `activateForWake` 带 drive 标志，两者都由 `QwenHostedHarnessConnectorTest` 固定；Harness 测试表明带其中任一标志的加载都会接管停靠的审批 Turn。因此 `takeoverFlags` 为真，会进入审批恢复臂重建等待者。协调器的驱动加载随后按 #17521 的附着规则与之收敛，并从已消费水位重放。后台通知作为 wake 输入挂起，直到 Turn 结算后才由泵投递。在此期间存在其他待处理输入，所以 Session 不会再次停靠。这是有界的：每个后台终态最多导致一次重载。
- **不变量。** 停靠 CAS 不读 background 字段。background hold 的证明仍由 3b 负责；`parkedTurn` 的证明仍是"唯一的活跃 Turn 处于可停靠等待"。两份证书互不推断。
- **改动面。** Store 的 seal 校验、staged-wake 事务、grant 能力位；Harness 侧放宽资格中"无后台持有"这一项。

### 4.3 S3：子 Session

- **为什么能复用 CAS。** 子 Session 的 Turn 是协调器分派的 `ma_turn` 行，`ChildResultRelay` 读取它时只对终态和几个特定错误码有动作，`RUNNING` 一律视为等待。停靠后的行仍是 `RUNNING`，`hosted_action_parked` 不命中任何分支。子 Session 不启用 live poll（`hostedApprovalForTurn` 在有 `lineage` 时关闭它，`:997`），因此证书不带 `approvalRevision`。
- **前置条件。** [无状态 Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)的冷启动准入一节把 relay 尝试预算缺口列为第一阶段前置条件：session-message 投递、子结果投递与 automation fire 仍会把等待计入尝试预算，冷启动突发时可能把消息结算为 cancelled/unknown。必须先确认这个缺口已关闭；如果缺口仍在，先在本切片内把它关闭。
- **方案。** 资格函数放开 `lineage`，保留其他条件。待处理的 session message 是 wake 所有的输入，有它时不停靠；relay 的重载会把 Session 带回来。
- **收益说明。** 父 Turn 仍处于 `agent` 调用中并常驻，所以本切片只释放子 Session 的常驻进程。要实现整棵树的零常驻，还需要 §2 非目标中的"父等子"停靠。
- **待验证。** 子 Session 单问题批次的挂载交还路径（`questionChild`）在冷恢复后行为正确；`MESSAGE_TURN_WAIT_MS` 在长时间停靠期间不会错误结算。

### 4.4 S4：wake 启动的 Turn

这一切片最大，分两步：先做 monitor、loop、automation 和子结果通知；channel 与 `pr_event` 另有回复计划和渠道结算，放到 S4b。

- **Harness 恢复臂。** 泵在处理"已尝试的 wake 输入"时，如果其检查点处于 `await_action`，并且共享资格函数认可 continuation，就走审批 continuation 驱动器恢复这次等待，不再调用 `settleCrashedWakeTurnAftermath`。这一步单独上线就有价值：修好等审批的 wake Turn 的崩溃恢复。已在 #18170 实现。它还修好了测试中发现的一个更严重的故障：收尾从不把检查点从 `await_action` 挪开，所以它排入的后续 continuation Turn 无法启动，泵随之失败。泵把 continuation 当作该 Turn 运行，并和正常运行后一样结算、消费输入。覆盖范围是 monitor、automation、loop 和 child 结果 Turn 的原生审批；期间被取消的来源以已中止的信号恢复。仍会走到收尾的路径（已经因别的原因 blocked 的 Session、恢复不覆盖的形态）由 #18172 单独修复：它让收尾以 cancelled 结束请求，并推进 `await_action` 检查点。
- **证书。** 这类 Turn 没有 `ma_turn` 行，只能由 wake 恢复扫描唤醒，而扫描的 `findPending` 和 `claim` 只选取处于待扫描状态、且 `wake_retry_at` 已到期的 head（`JdbcWakeRecoveryStore.java:91-132`）。因此 wake 所有的停靠沿用 3a 的到期时间标记，而不是给扫描新增分支：seal 记录 `wake.pending`，`dueAt` 设为停靠的唤醒时间，于是既有的扫描及其索引会在停靠到期时选中这个 head。Store 只把 `wake.pending` 理解为"在 `dueAt` 加载这个 head"，这正是停靠需要的；扫描回放 journal 时，同样会把那条已尝试的 wake 输入算作待处理。获取 writer 时会清除证书，但保留 `is_wake_pending`，并把 `wake_retry_at` 限制到兜底节奏（`JournalWriterLifecycle.java:274`），所以清除证书后又崩溃的 writer 会把 head 留给既有扫描。没有这个标记就做不到：停靠 seal 写入的是 `is_wake_pending = FALSE`，获取 writer 后 head 不再处于待扫描状态（已确认，由 `WakeSealStampTest` 固定）。`parkedTurn` 增加 `owner: 'wake'`，记在可空列 `ma_session_head.wake_seal_parked_owner` 中，由同一个 seal UPDATE 写入、获取 writer 时清除；按本模块的规则直接修改 V1 基线，不加迁移。Store 现有的"停靠 Turn 不能与 wake-pending seal 共存"规则，只对这个 owner、且只在新的 grant 能力位下放行这种组合；停靠资格在第一轮和闸门下的复查中都要求这个能力位。
- **唤醒来源。** 决定：`ACTION_RESPONSE` 投递在缓存未命中时会加载 Session（`doResolveAction`），这次加载必须是被动接管加载。对 Workspace Session 确实如此（已确认，见 §4.7）。没有 Workspace 的 Session 从不停靠，因为它没有审批策略（P0），所以决定投递发给它的普通加载永远不会遇到停靠。取消不需要额外步骤（已确认）：公开 API 与 Web Shell 的 Turn 取消都要求存在 `ma_turn` 行，所以 wake Turn 只能经由其来源自己的 Harness 操作（automation 运行的 `cancel_run`、child 运行的停止）或 Session 关闭来取消，而这些操作都会先做一次自己的加载，正是这次加载唤醒了停靠；普通加载会接上这类 Session，由 Harness 测试 "attaches a Session whose wake Turn died in its approval wait through a plain load" 固定。审批模式变更：策略变更是一个只解除 `ma_turn` 行停靠、不加载任何东西的 SQL 事务（`AgentSessionPolicies`），所以它要在同一事务中把 head 的 `wake_retry_at` 置为当前时间，由扫描在下一轮选中这个 head。该事务会先经过忙碌闸门，而闸门的豁免目前要求证书恰好对应一个活跃、一个已停靠的 `ma_turn` 行（`AgentActionParking.certificateMatches`）。wake 所有的证书改用"没有活跃的 `ma_turn` 行"来证明，并保留相同的 seal 修订、审批修订与"没有外来 requested Action"检查，以确保被停靠的等待是该 Session 唯一的活跃工作。到期：由标记的 `dueAt` 处理。
- **与 3a 的关系。** 若同一 Session 还有延迟的未尝试 wake 输入，首个增量仍不停靠，因为"唯一待处理输入"这一条件不变。
- **改动面。** Harness 泵与停靠资格、Store 的 seal 校验、审批模式变更事务及其忙碌闸门证明、grant 能力位。

### 4.5 S5：Hooks

- **已有基础。** `hook_execution` 记录按 `${promptId}:${callId}` 持久化每次 PreToolUse/PermissionRequest 的输入与结果，`orderedHookInput` 能据此重算有效输入，而不重新运行 Hook。被等待的调用在请求人工决定之前，已经跑完了 PreToolUse 和 PermissionRequest。
- **方案。**
  1. 生产者：放开 `(this.hooks || this.mcp)` 中的 Hooks 部分。continuation 为每个调用记录等待前已完成的 Hook 发生 ID 及其结果摘要。
  2. 恢复：`resumeSavedNativeBatch` 接受带 Hooks 的 Session。已完成的发生通过既有的 saved-output 路径读回；有记录但没有结果的发生视为不确定，恢复拒绝（G3 §4.2 第 5 步）。批准之后的 PostToolUse 是新的发生，执行前已证明未开始，正常运行。
  3. 接管：`takeover` 不再一律排除 `session.hooks`，改由共享资格函数判断。存在可恢复的原生 continuation 时，跳过 `answerResumedTurnCalls`：它会把被中断的调用回答为"从未运行"，和 command-step 的 R9-1 一样会永久破坏 continuation。
  4. 资格：被等待调用的 PreToolUse 与 PermissionRequest 都已完成，或者可以证明没有配置；第一阶段的"无进行中的 Hook 操作"条件不变。
  5. 重放：continuation 本来就保存了每个调用经过 Hooks 之后的实际输入（`request.call`）。PreToolUse 与 PermissionRequest 的发生都已完成的恢复调用，跳过 `decideHookInputs`，直接使用这份输入；再判断一次会拿 Hook 修改过的输入去比对原始 Hook 计划，从而抛出 `HostedHookInputConflictError`（`hosted-workspace-tool-turn.ts:4033-4051`）。
- **待验证。** 冷加载恢复停靠 Turn 时不重新触发 SessionStart 或 UserPromptSubmit（G3 要求"不重新应用启动 Hook"）。
- **改动面。** 仅 Harness，但触及 G3 生产者与恢复臂，需要 G3 的 A3/A6 故障门禁覆盖 Hooks 变体。

### 4.6 S6：MCP

- **依赖。** 第二阶段的 `qwen.managed-agent.runtime-broker.mcp-parking.enabled`。只有连接与目录在挂起期间被保留、新 writer 按持久化 owner 身份重新获取时，冷加载看到的 MCP 工具定义才能保证与 continuation 中保存的定义深度相等。不满足时不停靠：停靠后才发现恢复失败，比保持常驻更糟。
- **方案。** 生产者把 MCP 工具纳入白名单；continuation 记录 MCP 配置的持久化修订与目录 pin。资格要求 MCP 停靠已启用、当前 grant 能续接同一 owner，并且批次中排在前面的 MCP 调用都已提交结果。如果仍有进行中的调用，第一阶段的"Runtime 工作未结算"条件已会拒绝。被等待的 MCP 调用尚未派发，批准后恰好派发一次。
- **continuation 与目录。** continuation 解析器的工具白名单（`hosted-approval-continuation.ts:55-63`），以及写死 `mcp: false` 的恢复请求（`hosted-workspace-tool-turn.ts:4433-4448`），都要支持 MCP 调用及其 MCP 请求身份。`ParkedMcpReclamationJob` 必须跳过 Session 持有审批停靠证书的 owner：`JdbcParkedMcpOwners.sealedFor` 目前只检查 `state = 'SEALED'`，因此 S6 要新增停靠证书谓词和回收测试，保证 continuation 固定的目录仍是 Session 会续接的那个；owner 一旦被回收，每次 pin 检查都会变成拒绝。
- **不变量。** MCP 调用没有原生文件那样的 prepare/receipt 协议，所以绝不重放已派发的调用；任何调用的派发状态不确定时都拒绝。
- **改动面。** Harness 生产者与恢复臂、Broker MCP owner 续接，以及 `JdbcParkedMcpOwners.sealedFor` / `ParkedMcpReclamationJob`；新增测试证明持有审批停靠证书的 owner 不会被回收。

### 4.7 S7：extension command-step 审批

- **方案。** command-step 等待登记一个真正能冻结的 freeze。停靠资格按接管恢复臂对 command-step 计划要求的 Session 形态条件接受 `plan.commandStep`：extension 已启用，且 Session 有工具 owner。这些条件做成一个共享函数，由两边共同调用，与原生审批那个函数并列。Hooks 的放宽只限 command-step 计划，与 `extensionsCommandStepTakeover` 一致，不依赖 S5。MCP Session 上的 command step 在 S6 之前保持常驻，尽管恢复会接受它。停靠资格不需要配置修订号条件，见下文。
- **已确认。** 对 Workspace Session，决定投递时的加载带有接管标志，并会接管停靠的 Turn。connector 测试 `resolvesActionsThroughAuthorizedColdAndCachedWorkspaceAttachments` 断言决定投递发出的冷加载带被动恢复标志；Harness 测试 "resumes a parked approval through the passive load decision delivery sends" 表明只带这个标志的加载会经接管恢复臂恢复停靠的审批。
- **已确认。** 对停靠中的 command step 做裸加载，返回 409 `turn_unsettled`，journal 里什么都不写，R9-1 守卫成立。Turn 未结算期间 extension 配置无法修改：所有会修改 extension 配置的路由在 Turn 活跃时都会拒绝，而停靠的 Session 只能通过接管加载回来，接管会让 Turn 重新活跃。因此 `resumeSavedNativeBatch`（`hosted-workspace-tool-turn.ts:4328`）拒绝的修订不匹配在停靠期间不会出现；即使出现，它也会表现为可重试的 503，而不是带类型的拒绝。#18166 中的 Harness 测试 "parks a command-step approval that a bare load leaves unanswered and the decision-delivery load resumes" 固定了这两点。
- **改动面。** 仅 Harness。

### 4.8 S8：`uncaptured` 批次

- **派发前的 Shell（S8a）。** 这是价值最高的一项：Shell profile 下的审批大多是 `run_shell_command`。G3 要求派发前的 Shell 建立自己的正面 continuation 与所有权证据。本切片需要先确认 Shell 执行是否和原生文件一样有 `dispatch = false` 的 prepare 和按精确 key 重放的语义（待验证）。如果有，continuation 就按原生文件的做法记录 `runtimeCallId`、prepare key 与参数摘要；如果没有，需要先在 Broker 侧补齐，本切片的工作量会明显变大。无论哪种情况，这都是对 G3 契约的扩展，实现前要单独写一份 G3 扩展设计；本文只列出这个切片。已派发的 Shell 继续拒绝。
- **超过 64 KiB 的计划。** 暂不支持。P0 的拒绝计数会显示它的出现率；只有出现率可观时，才考虑把计划改存为非 inline 资源。
- **仍然排除。** `todo` 批次、没有 Runtime 的批次、不支持的工具和未计算摘要的调用都保持拒绝；S8 只覆盖派发前的 Shell 和超大计划。
- **v1/v2。** 不支持。它们只存在于升级前写入的等待，G3 已明确遗留重建需要单独验证，收益随时间归零。

## 5. 决策与理由

1. **先冷恢复、后停靠，同一切片交付。** 停靠是"可控的崩溃"，任何形态的可停靠性都不能领先于它的崩溃恢复能力。
2. **先做 P0 合并资格函数。** 后续每个切片都要放宽资格；如果两份条件并存，每放宽一项都会制造一次停靠与恢复口径不一致的机会。
3. **wake 所有的停靠由扫描唤醒，不新建 `ma_turn` 行。** 为 wake Turn 补建分派行会改变它们的所有权模型，影响 relay 与泵的全部不变量。复用 wake 恢复扫描只需要一列加一个查询条件。
4. **MCP 停靠绑定 MCP parking。** 不保留目录的 MCP 停靠无法证明恢复时定义不变。
5. **子 Session 切片不顺带做"父等子"。** 后者是另一种等待（没有 Action、没有审批 continuation），混在一起会扩大 G3 必须证明的范围。

## 6. 推荐顺序与测量

| 顺序 | #18149 阶段 | 切片                             | 改动面                       | 依赖                     |
| ---- | ----------- | -------------------------------- | ---------------------------- | ------------------------ |
| 0    | 0           | P0 共享资格函数 + 拒绝原因       | Harness                      | —                        |
| 1    | 1           | S1 纯图片 Prompt                 | Harness                      | P0                       |
| 2    | 1           | S7 command-step                  | Harness                      | P0                       |
| 3    | 2           | S2 后台 + 审批                   | Harness + Store              | P0、3b                   |
| 4    | 2           | S4 wake Turn（S4b channel 在后） | Harness + Store              | P0                       |
| 5    | 3           | S3 子 Session                    | Harness                      | P0、relay 预算缺口已关闭 |
| 6    | 4           | S5 Hooks                         | Harness（G3）                | P0                       |
| 7    | 4           | S6 MCP                           | Harness（G3）+ Broker 对齐   | P0、第二阶段 MCP parking |
| 8    | 5           | S8a 派发前的 Shell               | Harness（G3）+ 可能的 Broker | 单独的 G3 扩展设计       |

排序依据是代码级估算：先做改动小、只涉及 Harness 的切片，再做需要 G3 新证据的切片。这些估算未经实测。开始 S3 及之后的切片之前，用 P0 的拒绝计数，结合父设计 §7 的测量，查看各类等待在真实负载中的占比，按占比调整顺序；例如 Shell profile 的部署若占多数，S8a 应提前。

## 7. 验证计划

每个切片都继承父设计 §11 的全部用例，并增加：

- **口径一致。** 对同一 journal 状态，停靠资格与冷恢复臂给出相同回答。覆盖本切片放开的形态，以及仍被排除的相邻形态。
- **崩溃等价。** 先对本切片的形态做"等待中 SIGKILL → 另一代 Harness 接管 → 决定"，确认冷恢复正确，再做"停靠 → 冷加载 → 决定"。两者的 journal 结果应一致。
- **P0**：没有 Workspace 的 Session 不会打开任何 Action，连 memory 写入也不会，所以永远不会登记可停靠的等待。
- **S1**：纯图片 Prompt 停靠、冷加载后 Allow，以及它的 Harness 在等待中死掉、由新的 Harness 接管后 Allow，两种情况下工具都只执行一次，恢复后的第一次模型调用都从空文字开始，历史里带着原图。
- **S2**：停靠期间后台终态到达，解除停靠、Turn 恢复，通知在 Turn 结算后投递；工具与通知各恰好一次。覆盖在 seal 之前、在 seal 与 CAS 之间、在 CAS 之后暂存这三种顺序。
- **S3**：child Session 的停靠时长超过 relay 的消息 Turn 等待时间，父 Session 仍能收敛；单问题的 child 批次在冷恢复后交还挂载（`questionChild`）。
- **S4**：由 monitor 通知、loop 触发、automation 运行和 child 结果启动的 Turn，各自停靠后分别走决定、模式变更、到期，以及来源支持时的取消，不经协调器都能完成；清除证书后又崩溃的 writer 会把 head 留给扫描；泵不再按崩溃结算 `await_action` 的 wake 输入。
- **S5**：已完成的 PreToolUse/PermissionRequest 在恢复后不重新运行（用发生计数断言）；只有记录、没有结果的发生导致拒绝；SessionStart/UserPromptSubmit 不重新触发；另有单独用例覆盖 PreToolUse 的 `updatedInput`、PermissionRequest 的 `decision.updatedInput`，以及 Hooks 在第一个审批之前已为兄弟调用运行过的批次。
- **S6**：在 MCP parking 开启和关闭两种配置下，开启时可停靠，关闭时不停靠；恢复后工具定义相等，已派发的 MCP 调用不重放；持有审批停靠证书的 owner 经过回收作业的空闲窗口扫描后仍保留原目录。
- **真实进程与 MySQL 8.4**：每个切片至少一个"停靠 → 换代 Harness → 决定"用例进入必跑 CI 层级；H2 结果不能替代。

## 8. 验收标准

- 每个切片上线后，不符合该切片条件的等待行为完全不变，既有测试结果不变。
- 新放开的形态在一个空闲周期后干净停靠；在决定、取消、模式变更（如适用）、到期四种情况下，各自通过一次冷恢复完成原 Turn，Action、Prompt、批次身份不变，Allow 恰好执行一次，Deny 零次。
- 同一形态在等待中崩溃时，也通过冷恢复继续，而不是被结算为失败。
- §7 列出的真实进程、MySQL 与故障用例在 CI 中通过，父设计 §7 的测量完成后才在部署中打开 `action-parking.enabled`。

## 9. 开放问题

这些问题都不阻塞开发。问题 1–3 都先按下面的默认做法实现，测量后再回头调整，之后的调整都不需要改协议或数据库结构。问题 4 不在本设计范围内。

1. **停靠中的 wake 启动 Turn，改审批模式的延迟（S4）。** 这条路径把 `wake_retry_at` 置为当前时间之后，延迟上限是 wake 恢复扫描的间隔（默认 2s）；取消会自带一次加载。
   - 默认：只靠扫描。普通的停靠 Turn 本来就靠分派扫描（1s）重新分派，父设计也把"提交后立即触发一次加载"当作降低延迟的优化，而不是正确性要求（父设计 §4.6）。
   - 如果测得的延迟不可接受：在提交后直接触发一次加载，只是多一次调用。
2. **组合停靠的最短停靠时长（S2）。** 后台终态频繁的 Session 可能因为反复停靠、重载而得不偿失。
   - 默认：不设。这只关系到调优，不关系到正确性，而且功能默认关闭。
   - 如果测量显示反复停靠、重载：在 Harness 资格判断里加一个常量。证书和控制面都不受影响。
3. **超过 64 KiB 的计划和派发前的 Shell 在真实负载中的占比。** 只影响 S8 值不值得做、什么时候做；P0 到 S6 不受影响。在 `suspensionStats` 暴露给运维之后，由 P0 的拒绝计数回答（见 P0）。
4. **"父 Session 等待子结果"的停靠**（§2 的非目标）。没有 Action，需要独立的等待证明与唤醒来源（子 Turn 终态）。它是子 Session 树实现零常驻的必要条件，需要单独提案。
