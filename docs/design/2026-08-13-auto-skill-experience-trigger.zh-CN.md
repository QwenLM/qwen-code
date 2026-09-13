# AutoSkill 经验信号触发：用试错轨迹替代裸工具调用计数

[English](2026-08-13-auto-skill-experience-trigger.md) | [简体中文](2026-08-13-auto-skill-experience-trigger.zh-CN.md)

## 问题

此前，`scheduleSkillReview` 的唯一触发条件是 `toolCallCount >= AUTO_SKILL_THRESHOLD`（20）。
原设计文档（`docs/design/skill-nudge/skill-nudge.md` 原则 4）选择计数是因为它"反映任务
复杂度——高工具密度意味着试错、调整策略等行为更多"。但计数只是试错行为的代理，两个方
向都会误判：

- 一个只读 25 个文件的平庸会话会触发一次评审（8 轮 fork agent 跑完大概率回答
  "Nothing to save."，纯浪费）；
- 一个 5 次调用就完成红→绿调试的会话永远等不到评审。

评审 prompt 自身的入选标准是"trial and error / changing course / user expected a
different outcome"。触发器应当直接检测这些事件的确定性特征，而不是用计数去赌它们的
出现概率。

## 方案

在触发链路中加入一个**确定性经验信号检测器**（无 LLM，随已接收的工具结果线性累计，
成本可忽略），把触发条件改为两条路径：

1. **经验信号快速通道**：检测到任一试错信号，且窗口内工具调用 ≥
   `AUTO_SKILL_EXPERIENCE_FLOOR`（5，保证评审 agent 有足够素材）；
2. **计数兜底通道**（保留原行为用于召回）：工具调用 ≥ `AUTO_SKILL_THRESHOLD`（20），且
   窗口内至少完成一次 `write_file`、`edit`、`notebook_edit`、
   `run_shell_command` 或 `exec`。仅调用读取、列表或搜索工具的会话不再经兜底通道触发。

Code Mode 将内部工具调用封装在外层 `exec` 中，内部调用不会作为独立的 history
functionCall 进入经验窗口。因此在 issue #9062 原定的四种工具之外加入 `exec`，
保留 Code Mode 的计数兜底能力。每次外层 `exec` 计为一次调用，不展开内部工具或解析
脚本；与 shell 一样按工具类别判定，所以仅执行读取的 `exec` 也计为实质性工作。
这是预筛选的明确取舍，最终是否值得保存仍由评审 agent 决定。

### 经验信号

| 信号                 | 定义                                                                | 检测方式                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retryArc`           | 某工具失败后，同一工具出现成功结果——试错且被克服                    | 工具完成时按结构化 `status` / `executionStatus` 分类，并以 `callId` 暂存；在对应 `ToolResult` 或 `Retry` 被接受，或直接通过 `LlmClient.addHistory` 写入 history 后消费。shell 成功还必须携带结构化的数字完成码；错误按执行状态分类 |
| `userSteer`          | 用户在 agent 工作中途插话（steer 消息）——"用户期望不同的方法或结果" | 不由 history 推断；`LlmClient` 在 `SendMessageType.Steer` 完成时，或被接受的 `ToolResult` 提交附带 steer 时置位                                                                                                                    |
| `hasSubstantiveWork` | 窗口内完成过写文件、编辑 notebook、执行 shell 或 exec               | 仅用于兜底通道，排除仅调用读取、列表或搜索工具的会话                                                                                                                                                                               |

> 曾设想过独立的 `testFlip`（测试红转绿）信号，但它为真时 `retryArc` 在同一次扫描中
> 必然为真（转绿的那次成功同时闭合试错弧），对门控决策零增量，故合并进 `retryArc`，
> 不为它单独维护测试命令识别。

前台 shell 结果携带进程退出码。内建 sed 编辑在写入成功或成功 no-op 后返回 0，表示
shell 兼容操作已经完成，不表示启动过进程。转入后台的结果没有完成码，不能闭合重试弧；
promote 被拒绝但前台命令已完成的结果仍携带真实退出码。渲染文本永远不作为完成证据。
错误响应无需退出码，调度器已通过结构化状态标识执行失败。

### 窗口（防重复触发）

`LlmClient` 在工具完成时接收结构化 outcome：`callId`、`status`、
`executionStatus`、`errorType`、`responseParts` 和可选的 `exitCode`。可靠的 success / failure 以 `callId` 暂存；对应
`ToolResult`（含以 `Retry` 重提交的结果）真正被接受进入 history，或由直接 `addHistory` 路径写入后才消费一次；history dedup 路径则在发现同一 `callId` 已配对时立即消费。因此拒绝的提交可以重试，已接受结果的
重复提交自然 no-op。分类状态只存在于客户端 sidecar，不写入模型可见的
`functionResponse.response`。

工具完成时同时更新 `toolCallCount` 与 `hasSubstantiveWork`：从未执行的调用不计数；执行完成
后才取消的调用保持 `status: cancelled`，但 `executionStatus` 保留真实的 `success` 或 `error`，因此仍计数但不贡献 success / failure。`Steer` 到达或被接受的 ToolResult 附带
steer 时置位 `userSteer`。评审被调度或已有同类评审在运行时，累计窗口与计数一起清零；
session reset 还会清除尚未消费的 outcome sidecar。

如果取消发生在 shell 失败结算之后，已提供退出状态且无 `aborted: true` 会保留
`executionStatus: error` 及“工作已完成”的取消文案。这包含 child_process 命令被信号终止时
返回的 `null`；`undefined` 才表示工具没有提供前台结算证据。显式 `aborted: true` 优先，
即使同时携带数字或 null 退出码也仍视为取消；没有完成证据的 error-only 取消结果同样保持取消状态。
后者在执行结果交付调度器时判定；调度器的两个取消边界都保留已经完成的 shell 失败状态。

运行中取消的工具必须返回 `aborted: true`，由调度器标记
`executionStatus: cancelled`，客户端既不计数，也不暂存失败经验。Workflow 的运行前
取消和已注册运行的中途取消遵守相同约定；中途取消以 registry 的 `cancelled` 状态
为准，即使外层 signal 仍有效也必须携带该标志。真正的运行失败不添加此标志，
仍可与后续成功形成 retry arc。

### 门控逻辑（`MemoryManager.scheduleSkillReview`）

```
disabled / skillsModified            → 维持原有跳过
fastPath  = (retryArc || userSteer) && toolCallCount >= 5
backstop  = hasSubstantiveWork && toolCallCount >= AUTO_SKILL_THRESHOLD
!fastPath && !backstop               → skipped
                                      → 'below_threshold'
fastPath || backstop                 → scheduled
```

`AUTO_SKILL_THRESHOLD` 固定为 20，不接受调用方覆盖。

in-flight 去重检查在门控之后，因此 `already_running` 本身即代表"本应触发"；客户端和
`scheduled` 一样重置该窗口，避免旧信号在当前评审结束后立即重放。

## 集成点

- `packages/core/src/memory/experience-signals.ts`（新增）：结构化 outcome 分类、工作量判定和
  三态累计器，可独立单测。
- `packages/core/src/memory/manager.ts`：`experienceSignals` 为兼容性可选参数；内部调用始终
  传入完整信号，未传时保留原 count-only 行为。新增 `AUTO_SKILL_EXPERIENCE_FLOOR`。
- `packages/core/src/core/client.ts`：维护窗口信号与 `callId` outcome sidecar，在
  `runManagedAutoMemoryBackgroundTasks` 中传给 manager，并在 scheduled / already-running 时
  重置窗口。
- CLI interactive、history-dedup 和 headless 完成路径统一传递结构化 outcome；公共模型协议、
  JSON 输出协议和工具文本预算保持不变。

## 明确不做

- 不引入 LLM 分类器到触发路径（每轮一次的成本不可接受，且触发只是预筛选，语义判断是
  评审 agent 的职责）；
- 不做用户纠正的文本内容分析（多语言正则太脆，Steer 事件已是一等公民）；
- 不新增阈值/floor 配置项（无此需求）；
- 不改变评审 agent 本体、权限围栏与确认流。

## 验证

- `experience-signals.test.ts`（新增）：可靠/neutral outcome、same-tool 顺序、unknown-shell 和
  substantive-work 边界。
- `manager.test.ts`：表驱动覆盖快速通道 floor、计数兜底与纯读拒绝边界；
  `skillReviewNudge.integration.test.ts` 保留快速通道和兜底通道的集成 smoke。
- `client.test.ts` 覆盖 ToolResult 接受/拒绝、Retry 单次消费、Steer 与两种窗口重置；CLI
  测试锁定 structured outcome wiring 和 structured-output sibling 兼容性。
- 回归验收：全部为 `exec`、无 retry arc 或 steer 的窗口，19 次跳过、20 次调度；
  信号必须由真实工具分类函数计算。取消 Workflow 的真实结果经过调度器和客户端后
  不计数、不暂存失败，随后成功不形成 retry arc；真实失败后成功仍形成 retry arc。
  分别撤销 `exec` 集合项和取消标志，必须使对应回归测试失败。
- E2E 测试计划见 `.qwen/e2e-tests/2026-08-13-auto-skill-experience-trigger.md`。
- shell 完成回归：失败已完成后才取消，保留真实 error 执行状态，包括真实非 PTY 进程
  被 SIGTERM 终止、退出码为 null 的场景；协作式中途取消仍为
  cancelled。内建 sed 失败恢复和前台 shell 失败恢复经过调度器、CLI outcome adapter、
  history 接收和真实 review 门控：4 次调用跳过，5 次只调度一次。撤销 shell 或调度器的
  完成码转发，必须使相应回归测试失败。
