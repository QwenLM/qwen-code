# Agent 准备任务的 Batch API 工作流

[English](./2026-09-23-agent-prepared-batch-api.md)

状态：与本文同步实现（2026-09-23），构建在 #11874 的底层
`qwen batch submit|status|fetch|cancel` 传输能力之上。本文是工作流层的
设计约定；面向用户的使用说明在 `docs/users/features/batch.md`。

## 1. 问题与目标

#11874 把 DashScope Batch API 以四个传输子命令引入 CLI。直接使用足够强大，
但对目标用户几乎不可用：用户需要自己理解任务、收集每个条目的材料、手工
组装请求 JSONL、提交、等待、解析结果、映射回文件并验证——agent 最擅长的
两步（准备输入、交付输出）恰恰留给了用户。与此同时，实测数据支持的结论
——彼此独立的单轮请求批量展开，才是 Batch 真正更省的形状——也正是 agent
最擅长准备的形状。

目标：用户用自然语言交代批量任务、显式选择异步批处理模式，稍后收到已经
交付好的文件。agent 轻量准备，Batch API 执行主要生成，确定性代码负责提交、
恢复、校验、交付与记账。

两条产品承诺分开兑现：

- **省事**——不接触 JSONL、请求 ID 或任何服务商概念。始终成立。
- **整任务更便宜**——完整任务（轻量实时准备 + Batch 生成 + 交付 + 返工）
  必须比同等质量完成同一工作的实时方案更便宜。这取决于任务形状，绝不做
  笼统承诺：Batch 按实时刊例价 5 折计费，但不享受上下文缓存（#11874 的
  探针实测，见 `docs/users/features/batch.md`）。

## 2. 入口

### `/batch --api <任务>`（交互式）

现有 `/batch` skill 用实时 worker agent 并行处理；本 PR 在同名命令上增加
一个显式的第二模式。`BundledSkillLoader` 在代码层解析 `--api` 标志——模式
选择是标志位，不能靠提示词让模型猜——并把 skill 正文替换为
`packages/core/src/skills/bundled/batch/api-mode.md`。不带该标志时，
`/batch` 行为完全不变。

api-mode 提示词只让模型做语义工作：

1. 诚实判断适用性（材料现已齐全、彼此独立的单轮转换任务）。不适用就解释
   并停止，绝不静默改用实时执行。
2. 轻量准备——glob 找文件、抽样读 2–3 篇、一次性写出共享规则。逐篇深入
   分析谁都不做：完整内容由执行器机械嵌入。
3. 把计划 JSON 写到 `.qwen/batch/plans/<slug>.json`。
4. 在 shell 中执行 `qwen batch run <plan>` 提交，然后原样转述任务 ID、
   估算与收取命令。

### `qwen batch` 工作流子命令（确定性执行器）

| 命令                      | 行为                                                    |
| ------------------------- | ------------------------------------------------------- |
| `run <plan>`              | 校验计划 → 组装 → 估算 → 预算门禁 → 提交 → 入账         |
| `collect <task-id>`       | 对账 → 轮询（可选 `--wait`）→ 下载 → 校验 → 交付 → 报告 |
| `retry <task-id>`         | 仅以新一次尝试重新提交 `failed` 条目                    |
| `list`                    | 列出已记录任务及进度                                    |
| `cancel --task <task-id>` | 取消任务的活动批次（已完成部分仍计费）                  |

`run` 打印任务 ID 后立即退出——等待不消耗 agent 轮次。`collect` 可以任意
重复执行：已落盘的内容全部复用，已交付条目绝不重做，held 条目在用户解决
冲突后重新尝试交付，全程不产生新的付费请求。

## 3. 架构

```text
用户：/batch --api “把 docs/zh 翻译到 docs/en”
        │
        ▼（BundledSkillLoader 在代码层解析 --api）
准备 skill（api-mode.md）——只做语义工作：适用性、抽样、共享规则、计划文件。
实时运行，保留实时侧自身的缓存收益。
        │
        ▼ 计划 JSON（§4 的 schema）
工作流执行器（packages/cli/src/commands/batch-workflow.ts）
  ├─ batch-task.ts   账本：任务/条目/尝试记录，原子写
  ├─ batch-docs.ts   组装请求、校验结果、交付文件
  └─ batch-client.ts 带状态码的 HTTP 原语
        │
        ▼
#11874 的传输层（batch.ts）：端点/鉴权解析、上传、创建、查询、下载、取消
——复用，不重复实现。
```

设计不变量：

- **账本必须能不靠猜测回答“远端可能存在哪些对象”。** 提交意图先于上传
  落账，输入文件 ID 先于创建落账。创建应答丢失记为 `submit-unknown`，
  由 `collect` 用 `input_file_id` 对服务商批次列表对账——绝不盲目重发，
  因为答错的代价是重复计费。
- **custom_id = `<itemId>#<attempt>`**，跨重试也能唯一映射回条目；未知或
  重复的结果行告警后忽略。
- **交付不覆盖。** 目标已存在且内容不同是待报告的冲突；内容完全相同则
  视为已交付——这正是重复收取幂等的来源。写入前重新哈希源文件：提交后
  源发生变化的结果会被挂起。
- **Batch 用量不进交互会话的实时缓存统计。** 工作流运行在独立进程，用量
  只记入任务账本；Batch 的 `cached_tokens: 0` 永远不会稀释交互侧展示的
  实时缓存命中率。
- **没有价格就不做货币估算。** token 估算始终展示（粗略，按字符数/3）。
  只有设置了 `QWEN_BATCH_INPUT_PRICE_PER_1M_USD` 与
  `QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD` 才显示美元估算——内置价格表会
  对着服务商价格页过期。计划可以设 `maxCostUsd`；没有价格时预算无法
  执行，`run` 拒绝提交。

## 4. 计划 schema（v1）

```json
{
  "version": 1,
  "name": "translate-docs",
  "kind": "document-transform",
  "completionWindow": "24h",
  "maxCostUsd": 2.0,
  "maxOutputTokens": 4096,
  "expectedOutputTokensPerItem": 1500,
  "enableThinking": false,
  "shared": {
    "system": "可选 system prompt",
    "instructions": "共享规则：术语、风格、输出约定"
  },
  "items": [
    {
      "id": "intro",
      "source": "docs/zh/intro.md",
      "target": "docs/en/intro.md"
    }
  ]
}
```

由 `batch-task.ts` 强制：条目 id 匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`
（要进入服务商 custom_id），id 与 target 均唯一，未知字段直接拒绝
（agent 的笔误必须响亮失败，不能静默改变行为）。仅上面列出的字段可选；
`kind` 是字面量——新种类使用新的 schema 版本。

首个产品约定是**一份源文档 → 一份完整目标文档**。模型只返回内容；其
输出中的路径或命令都是数据，绝不执行。交付校验结构（非空、未截断、
无工具调用、Markdown 围栏配平）——结构合格不等于语义质量合格，后者
仍由用户验收。

## 5. 边界行为

| 边界                       | 行为                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| 任务不适用（需要迭代反馈） | skill 解释并停止；不静默回退到实时                                |
| 源路径逃逸项目根目录       | 组装阶段拒绝，任何内容都不会上传                                  |
| 组装行 > 1 MB              | 拒绝并指引改用 `qwen batch submit`（工作流上限，低于服务商 6 MB） |
| 创建被明确 4xx 拒绝        | 清理孤儿上传，条目记 `failed`，可安全 `retry`                     |
| 创建应答丢失（5xx/断连）   | 记 `submit-unknown`；`collect` 对账；不重发                       |
| 对账找到 0 个或 2+ 个候选  | 报告并停止；服务商列表是事实来源                                  |
| 收取时批次未结束           | 报告状态；`--wait` 以 10s→60s 退避轮询至 `--timeout`              |
| 结果截断/含工具调用/为空   | 条目标 `failed` 并记录原因；失败请求的计费保持可见                |
| 结果 custom_id 未知或重复  | 告警忽略，绝不错配到别的条目                                      |
| 错误文件行                 | 条目标 `failed`，记录服务商错误                                   |
| 条目在所有结果文件中缺失   | 条目标 `failed`（“no result line”）                               |
| 提交后源文件变化           | 交付 `held` 并说明；用户恢复后重新收取                            |
| 目标已存在且内容不同       | 交付 `held`；用户解决后重收，从本地记录交付                       |
| 目标路径经符号链接逃出项目 | 交付 `held`                                                       |
| 对已结束批次 `--task` 取消 | 提示改用 `collect`，而不是假装取消                                |
| 收取后的远端清理           | 输入/输出/错误文件在本地落账后删除；`--keep-remote` 可保留        |

重试语义：仅 `failed` 条目、作为新一次尝试、使用新的 `#<attempt>`
custom_id；存在未对账提交或前一批次仍在运行时拒绝。held 条目永不重试
——它们需要用户决策，不是新请求。

## 6. 成本模型

执行器不做自动路由——用户用 `--api` 显式选择了 Batch——但它不能在钱上
撒谎：

- Batch 定价：成功请求按实时刊例价 5 折，无上下文缓存。是否比实时便宜
  取决于公共前缀占比与输出占比（`docs/users/features/batch.md` 推导了
  盈亏平衡公式）。准备 skill 把合适的任务组织成 Batch 占优的形状
  （条目内容远大于共享指令，或输出较长）。
- 实时准备刻意保持便宜：skill 只抽样，不逐篇深读；完整内容由执行器机械
  嵌入。如果 agent 必须逐条深入分析才能准备，该任务就不在这个工作流的
  甜区，skill 应该明说。
- 返工记账：失败条目可见重试（新尝试、新用量）；held 条目从本地记录免费
  交付；没有任何自动循环重试。
- 估算标注为估算。账单以服务商为准。

## 7. 验证

- 单元测试（`packages/cli/src/commands/batch-task.test.ts`、
  `batch-docs.test.ts`、`batch-workflow.test.ts`）：计划校验、账本原子性
  与 schema 守卫、逃逸路径拒绝组装、结果分类、交付冲突/变更/幂等、基于
  假 `WorkflowApi` 的提交 → 结束 → 收取 → 重试全生命周期、模糊创建对账、
  `--wait` 退避、预算门禁。
- `BundledSkillLoader.test.ts`：`/batch --api` 换入 api-mode.md 并剥离
  标志；普通 `/batch` 保持并行 worker 正文。
- 手工端到端（假 HTTP 服务器、隔离 HOME、真实构建产物 CLI）：
  `run → collect（运行中）→ collect --wait → 文件交付 → 幂等重收 →
list → 失败 → 重试 → held → 解决 → 交付 → cancel`，全部通过；不触碰
  真实 API。
- 既有 `qwen batch submit|status|fetch|cancel` 行为不变（原测试套件
  未修改并通过）。

## 8. 明确的非目标

- 不做实时/Batch 自动路由，不做付费试跑，不做自动修复循环。用户选择
  模式，程序负责诚实。
- 不做多阶段依赖图；一次尝试对应一个批次。
- 不做逐轮 Batch 的 agent loop（#11874 已实测否决）。
- 不做通用结果协议：当前只实现 document-transform 约定。代码补丁交付
  （应用 + 构建 + 测试）是未来的新 kind，需要自己的验收标准，不能现在
  就假设成立。
