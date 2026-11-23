# 行为评测（Behavioral Eval）框架

[English](2026-11-23-behavioral-eval-harness.md) | [简体中文](2026-11-23-behavioral-eval-harness.zh-CN.md)

状态：提案。尚无实现；本文是 buy-in 载体——先固定设计供维护者裁决或裁剪，
代码落地之前任何人都可以改。

## 为什么

仓库现有测试层验证的是系统**能否运作**：单元测试覆盖机制，`integration-tests/`
覆盖端到端流程，`.qwen/e2e-tests/` 计划覆盖发布清单。没有任何东西验证模型
**是否选择**正确动作——系统提示词的改动是否让模型更/更少调用某个工具，新
工具定义是否扰乱引导（steering），通知措辞调整是否改变模型的后续行为。这些
面（系统提示词、工具描述、压缩与记忆通知、子代理委托措辞）频繁变更，而每次
变更都在没有行为反馈回路的情况下落地。

上游渊源让这个缺口非常具体：qwen-code 是 gemini-cli 的 fork，而 gemini-cli
现在带有一套行为评测——根目录 `evals/` 下 38 个 `.eval.ts` 用例、`LLMJudge`
工具（`judgeYesNo` 加自一致性多数投票）、两档策略（`ALWAYS_PASSES` 门禁 CI、
`USUALLY_PASSES` 在 `RUN_EVALS=1` 下夜间运行）、以及成文的晋升流程。fork
继承了引导面，却没有继承这套框架。本提案采纳该框架形态，并适配本仓库的
约定。

仓库近期的多项工作会直接受益：压缩输入的失败摘要（#17314）没有检查摘要
是否真的保留了失败原因；shell 不可信框定（#17325）没有检查模型是否把被
框定的输出当数据；记忆召回（#16517）没有检查召回注入的是正确的记忆而非
噪声。

## 设计

### 目录与入口

根目录 `evals/`，与 gemini-cli 对齐，使 fork 侧的内容同步保持机械可行：

- `evals/test-helper.ts` — 导出 `evalTest(policy, evalCase)`，一个 Vitest
  包装。`policy` 为 `'ALWAYS_PASSES' | 'USUALLY_PASSES'`；`evalCase` 为
  `{ name, prompt, params?, assert(rig, result), log? }`。
- `evals/llm-judge.ts` — `LLMJudge` 包装 core 的
  `BaseLlmClient.generateContent`：`judgeYesNo(question, options)` 返回
  `{ verdict, reasoning, votes }`，`selfConsistencyRuns`（默认 1，多数投票用
  3 或 5）与可配置的评审模型（默认取小杯快速档）。评审以 utility role 加
  专用 `promptId` 运行，系统提示词严格要求裸 `YES`/`NO`。
- `evals/*.eval.ts` — 用例本身，一个行为一个文件。
- `evals/README.md` — 撰写规则（镜像上游：场景真实但小、断言无歧义、
  fail-first、less-is-more）。

### Rig（测试驱动装置）

`evalTest` 驱动打包产物（`npm run build && npm run bundle` → 单文件
bundle），复用 `integration-tests/` 已验证的交互模式（行为可从最终状态观察
时用无头 `-p`；回合中行为用 tmux/交互 harness）。rig 记录工具调用与最终
状态；`assert` 同时拿到两者。不新建会话机制：rig 只组装既有助手。

### 策略与门禁

- `ALWAYS_PASSES`：预期确定稳定的行为。进 PR CI lane，失败阻塞合并。刻意
  保持很小（目标 ≤ 10 条）。
- `USUALLY_PASSES`：有固有方差、属于模型引导面的行为。由 `RUN_EVALS=1`
  门禁、夜间运行。所有新评测从这里开始。
- 晋升：夜间产物记录每个评测的通过率；评测只在持续绿 streak 后（提案：
  连续 14 个夜间运行）才晋升为 `ALWAYS_PASSES`，出现抖动即降回。与上游
  同一流程。

### 成本与密钥

评测调用真实模型。控制手段：

- `USUALLY_PASSES` 只在夜间跑；`ALWAYS_PASSES` 保持小且用短提示。
- 评审用小杯模型，不用工作模型。
- 没有 API key 时评测带原因跳过而非失败——无 key 的本地开发保持绿。CI
  通过 secret 提供 key，是唯一真正执行这些套件的地方。
- 夜间 lane 遵守仓库的 CI 预算门禁。

## 非目标

- 不做通用基准（SWE-bench 类）——行为评测只针对颗粒化的产品行为。
- 本切片不含评测撰写自动化（上游的 "behavioral-evals" agent skill）。
- v1 不做多模型对比矩阵；只有当 runner 顺带提供时才记录分模型结果。
- 不改变现有单元/集成 lane 的语义。

## 实现步骤

1. `evals/test-helper.ts` + rig 组装 + `LLMJudge`，helper 与评审解析
   （mock client）带单元测试。
2. 三条种子评测，全部 `USUALLY_PASSES`，落在最高价值的引导面：压缩上下文
   剩余工具下的工具选择（#17320 族）、shell 输出不可信框定的遵守（#17325
   族）、压缩摘要保留失败原因（#17314 族）。
3. 夜间 workflow 发布每评测通过率；npm 脚本 `test:always_passing_evals` /
   `test:all_evals` 与上游同名。
4. `evals/README.md` 记录撰写规则与晋升流程。
5. 一旦有评测晋升，启用 `ALWAYS_PASSES` 的 CI lane（lane 可从空开始）。

## 风险与缓解

| 风险         | 缓解                                                             |
| ------------ | ---------------------------------------------------------------- |
| API 开销     | 易变档只夜间跑；小杯评审模型；短提示；预算门禁                   |
| 抖动阻塞工作 | 新评测永不门禁 CI（`USUALLY_PASSES`）；晋升需要实测 streak       |
| CI 时间      | `ALWAYS_PASSES` ≤ 10 条快速用例；`USUALLY_PASSES` 永不进 PR lane |
| 密钥管理     | 本地无 key 即跳过；仅 CI 经 secret 执行                          |
| 评审模型误判 | 严格 YES/NO 契约、争议用例自一致性投票、夜间报告人工复核         |

## 验收标准

- `evalTest` + `LLMJudge` 有单元测试；解析与投票用 mock client 验证。
- 无 API key 时评测套件干净跳过，所有既有 lane 保持绿。
- 有 key 时三条种子评测可运行并产出每评测结果。
- 夜间 workflow 发布通过率产物；晋升/降级规则成文且被遵守。
- PR CI lane 只跑已晋升的（`ALWAYS_PASSES`）评测。

## 待定问题

1. 本仓库路由下的小杯评审模型默认值选哪个（上游用 flash 档默认；这里的
   等价物需要拍板）？
2. 夜间单次运行的预算上限（提案：时间盒，预算耗尽时 fail-open 而非报红）。
3. v1 是让 `ALWAYS_PASSES` 从空集开始等首次晋升，还是种一条平凡用例把
   lane 端到端打通？
4. 外部贡献者的 key 供给——仅 CI，还是文档化的本地路径？
