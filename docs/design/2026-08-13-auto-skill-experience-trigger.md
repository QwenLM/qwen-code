# AutoSkill 经验信号触发：用试错轨迹替代裸工具调用计数

## 问题

`scheduleSkillReview` 的唯一触发条件是 `toolCallCount >= AUTO_SKILL_THRESHOLD`（20）。
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
   窗口内至少完成一次 `write_file`、`edit`、`notebook_edit` 或
   `run_shell_command`。纯读会话不再触发。

### 经验信号

| 信号                 | 定义                                                                | 检测方式                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retryArc`           | 某工具失败后，同一工具出现成功结果——试错且被克服                    | 仅以 `functionResponse.response.error` 存在判定失败（shell 的真实失败由 shell.ts 附 `error` 键，grep 等退出码 1 不算失败；`[Operation Cancelled]`、中断修补、plan-mode 兄弟调用跳过、权限拒绝等从未执行的合成/策略标记不计）；后续同一工具成功即成立 |
| `userSteer`          | 用户在 agent 工作中途插话（steer 消息）——"用户期望不同的方法或结果" | 不由 history 推断；`GeminiClient` 在 `SendMessageType.Steer` 完成时，或被接受的 `ToolResult` 提交附带 steer 时置位                                                                                                                                   |
| `hasSubstantiveWork` | 窗口内完成过写文件、编辑 notebook 或执行 shell                      | 仅用于兜底通道，排除纯读会话                                                                                                                                                                                                                         |

> 曾设想过独立的 `testFlip`（测试红转绿）信号，但它为真时 `retryArc` 在同一次扫描中
> 必然为真（转绿的那次成功同时闭合试错弧），对门控决策零增量，故合并进 `retryArc`，
> 不为它单独维护测试命令识别。

### 窗口（防重复触发）

`GeminiClient` 直接累计自上次评审以来的工具结果状态：`ToolResult`（含以 `Retry` 重提交
被接受的 ToolResult）到达时更新 `retryArc` / `failedToolNames`，工具完成时更新
`hasSubstantiveWork`（从未执行的调用不计数：`executionStatus === 'not_started'` 的策略
拒绝与执行前取消；完成后才被取消的调用仍计数——其副作用已经落盘），`Steer` 到达或被
接受的 ToolResult 附带 steer 时置位 `userSteer`。评审被调度时，累计状态与
`toolCallCount` 一起清零；`already_running` 时保留窗口，等当前评审结束后的下一个门控
重试（失败连续上限 2 次）。被调度的窗口会保留一份快照：若该评审最终以
`skipped`（如内存压力）或 `failed` 收场而从未运行，快照会被重新并入当前窗口，试错证据
不会随清零丢失。累计器不依赖 history 数组下标，因此 history 压缩、摘要和重排
不会丢失尚未消费的信号。

### 门控逻辑（`MemoryManager.scheduleSkillReview`）

```
disabled / skillsModified            → 维持原有跳过
fastPath  = (retryArc || userSteer) && toolCallCount >= 5
backstop  = hasSubstantiveWork && toolCallCount >= threshold(默认 20)
!fastPath && !backstop               → skipped
                                      → 'below_threshold'
fastPath || backstop                 → scheduled
```

in-flight 去重检查在门控之后，因此 `already_running` 本身即代表"本应触发"。客户端保留
该窗口，因为在途评审的历史快照早于这些一次性接受期信号。

## 集成点

- `packages/core/src/memory/experience-signals.ts`（新增）：纯函数检测器与跨片段累计器，可独立
  单测。
- `packages/core/src/core/tool-result-markers.ts`（新增）：取消/策略拒绝标记的共享常量与
  "调用是否真正产出工作"判定（`didToolCallProduceWork`），供 `coreToolScheduler`（生产侧）、
  `experience-signals` 与各完成循环（消费侧）共用，避免措辞改动导致分类静默失配。
- `packages/core/src/memory/manager.ts`：`ScheduleSkillReviewParams.experienceSignals`
  为**必填**（避免"声明了却没人传"的死开关）；新增
  `AUTO_SKILL_EXPERIENCE_FLOOR`。
- `packages/core/src/core/client.ts`：维护窗口内的累计信号，在
  `runManagedAutoMemoryBackgroundTasks` 中传给 manager；触发后重置窗口（评审未运行则重新
  武装），并记录门控决策日志。

## 明确不做

- 不引入 LLM 分类器到触发路径（每轮一次的成本不可接受，且触发只是预筛选，语义判断是
  评审 agent 的职责）；
- 不做用户纠正的文本内容分析（多语言正则太脆，Steer 事件已是一等公民）；
- 不调整阈值/floor 的可配置化（无此需求）；
- 不改变评审 agent 本体、权限围栏与确认流。

## 验证

- `experience-signals.test.ts`（新增）：各信号的正反例、顺序敏感性（先成功后失败不成立）、
  纯读窗口、空 history。
- `manager.test.ts`：表驱动覆盖快速通道 floor、计数兜底与纯读拒绝边界；
  `skillReviewNudge.integration.test.ts` 保留快速通道和兜底通道的集成 smoke。
- 既有 `client.test.ts` 的 autoSkill 用例使用 `objectContaining` 断言参数，新增字段不破坏；
  补充 Steer 计数与窗口重置用例。
- E2E 测试计划见 `.qwen/e2e-tests/2026-08-13-auto-skill-experience-trigger.md`。
