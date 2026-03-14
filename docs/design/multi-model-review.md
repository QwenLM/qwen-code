# Multi-Model Code Review Design

## Background

Qwen Code 当前的 `/review` 功能由单个模型驱动，通过启动 4 个并行子任务（correctness、quality、performance、audit）从不同维度审查代码。虽然多维度审查有效，但所有视角都来自同一个模型，存在以下局限：

- 单一模型的知识盲区会导致某些问题被一致性地忽略
- 不同模型在不同领域有各自的优势（如某些模型更擅长安全审查，某些更擅长性能分析）
- 用户无法利用已配置的多个模型提供商来获得更全面的审查

## Goal

支持用户配置多个模型同时审查同一段代码，汇总各模型的独立审查结果，产出一份综合报告。

## Non-Goals

- 不改变现有单模型 `/review` 的行为（作为默认模式保留）
- 不要求所有模型必须来自不同提供商（同一提供商的不同模型也可以）
- 不涉及 review 结果的持久化存储或历史对比

---

## 1. 用户配置

### 1.1 设计原则：渐进式复杂度

配置设计遵循"用最少的配置获得最大的功能"原则，分四个层级，用户按需递进：

```
Level 0: 零配置        /review --multi → 列出 modelProviders 中可用模型，提示用户配置
Level 1: 选模型        "review": { "models": ["gpt-4o", "deepseek-chat"] }
Level 2: 指定仲裁      "review": { ..., "arbitratorModel": "claude-opus-4-6-20250725" }
Level 3: 内联自定义    "review": { "models": ["gpt-4o", { "id": "my-model", ... }] }
```

### 1.2 配置格式

**核心简化**：`review.models` 和 `review.arbitratorModel` 直接写模型 ID 字符串，自动从 `modelProviders` 解析。不再要求用户写 `{ id, authType }` 对象。

```jsonc
// ~/.qwen/settings.json
{
  // 用户已有的模型配置（已配好的，不需要为 review 新增）
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-4o",
        "baseUrl": "https://api.openai.com/v1",
        "envKey": "OPENAI_API_KEY",
      },
    ],
    "anthropic": [
      {
        "id": "claude-sonnet-4-6-20250514",
        "baseUrl": "https://api.anthropic.com",
        "envKey": "ANTHROPIC_API_KEY",
      },
      {
        "id": "claude-opus-4-6-20250725",
        "baseUrl": "https://api.anthropic.com",
        "envKey": "ANTHROPIC_API_KEY",
      },
    ],
  },

  // 多模型 review：最简配置只需要模型 ID 列表
  "review": {
    "models": ["gpt-4o", "claude-sonnet-4-6-20250514"],
    "arbitratorModel": "claude-opus-4-6-20250725",
  },
}
```

模型 ID 自动从 `modelProviders` 中查找，用户不需要重复写 `authType`、`baseUrl`、`envKey`。

**对比改进前后的用户体验**：

```jsonc
// ❌ 改进前：繁琐，用户需要重复写 authType + 完整对象
"review": {
  "models": [
    { "id": "gpt-4o", "authType": "openai" },
    { "id": "claude-sonnet-4-6-20250514", "authType": "anthropic" }
  ],
  "arbitratorModel": {
    "id": "claude-opus-4-6-20250725",
    "authType": "anthropic"
  }
}

// ✅ 改进后：只写模型名
"review": {
  "models": ["gpt-4o", "claude-sonnet-4-6-20250514"],
  "arbitratorModel": "claude-opus-4-6-20250725"
}
```

**混合模式**：当模型不在 `modelProviders` 中时，支持字符串和对象混写：

```jsonc
"review": {
  "models": [
    "gpt-4o",                                        // 从 modelProviders 解析
    "claude-sonnet-4-6-20250514",                     // 从 modelProviders 解析
    {                                                 // 内联：不在 modelProviders 中的模型
      "id": "deepseek-chat",
      "authType": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "envKey": "DEEPSEEK_API_KEY"
    }
  ]
}
```

### 1.3 模型解析规则

```
review.models 中的每个条目
  │
  ├─ 字符串（如 "gpt-4o"）
  │   └─ 在 modelProviders 所有 authType 中按 id 查找
  │       ├─ 找到 → 使用 modelProviders 中的完整配置
  │       ├─ 找到多个同名 → 报错: "Ambiguous model id 'xxx', found in openai and anthropic. Use object form to specify authType."
  │       └─ 未找到 → 报错: "Model 'gpt-4o' not found in modelProviders. Add it to modelProviders or use object form with full config."
  │
  └─ 对象（如 { id, authType, ... }）
      └─ 直接使用，不查找 modelProviders
```

**去重规则**：按模型 `id` 去重。当前会话模型 + `review.models` 列表中如有重复 id，只保留一份。

### 1.4 各层级详解

#### Level 0：零配置（`/review --multi`）

用户已在 `modelProviders` 中配置了多个模型，但尚未配置 `review.models`：

```
> /review --multi

No review models configured. Available models from modelProviders:
  ✓ gpt-4o (openai)
  ✓ claude-sonnet-4-6-20250514 (anthropic)
  ✓ claude-opus-4-6-20250725 (anthropic)
  ✗ deepseek-chat (openai) — DEEPSEEK_API_KEY not set

To enable multi-model review, add to ~/.qwen/settings.json:
  "review": { "models": ["gpt-4o", "claude-sonnet-4-6-20250514"] }

Proceeding with standard single-model review...
```

**不做自动选择**：列出可选模型 + 给出配置示例，让用户主动选择。
自动选择的隐式逻辑（每个 authType 选几个？按什么排序？）对用户不透明，MVP 阶段不做。

#### Level 1：指定审查模型

```jsonc
"review": {
  "models": ["gpt-4o", "claude-sonnet-4-6-20250514", "deepseek-chat"]
}
```

配置后 `/review` 自动使用多模型，无需 `--multi` 标志。

#### Level 2：指定仲裁模型

```jsonc
"review": {
  "models": ["gpt-4o", "deepseek-chat"],
  "arbitratorModel": "claude-opus-4-6-20250725"
}
```

**三种角色完全解耦**：

```
┌─────────────────────────────────────────────────────────────────────┐
│  角色            │  典型选择            │  核心需求                  │
├──────────────────┼─────────────────────┼───────────────────────────┤
│  会话模型         │  Qwen Coder Turbo   │  快速、低延迟、日常编码     │
│  (Session Model) │  GPT-4o-mini        │                           │
├──────────────────┼─────────────────────┼───────────────────────────┤
│  审查模型         │  GPT-4o             │  覆盖面广、各有所长         │
│  (Review Models) │  Claude Sonnet      │  多视角、并行              │
│                  │  DeepSeek V3        │                           │
├──────────────────┼─────────────────────┼───────────────────────────┤
│  仲裁模型         │  Claude Opus        │  强推理、准确裁决          │
│  (Arbitrator)    │  o3                 │  可以慢，但要准            │
└──────────────────┴─────────────────────┴───────────────────────────┘
```

#### Level 3：内联自定义模型

```jsonc
"review": {
  "models": [
    "gpt-4o",
    { "id": "my-internal-model", "authType": "openai", "baseUrl": "https://internal.corp/v1", "envKey": "INTERNAL_API_KEY" }
  ]
}
```

适用于需要接入未在 `modelProviders` 中注册的模型（如内部部署的模型）。

### 1.5 配置 Schema

```typescript
review: {
  type: 'object',
  label: 'Code Review',
  category: 'Tools',
  requiresRestart: false,
  default: {},
  description: 'Multi-model code review configuration.',
  showInDialog: false,
  properties: {
    models: {
      type: 'array',
      label: 'Review Models',
      category: 'Tools',
      requiresRestart: false,
      default: [],
      description: 'Models for multi-model review. Each entry can be a model ID string (resolved from modelProviders) or a full model config object.',
      showInDialog: false,
    },
    arbitratorModel: {
      type: 'string',              // 字符串，不是 object
      label: 'Arbitrator Model',
      category: 'Tools',
      requiresRestart: false,
      default: undefined,
      description: 'Model ID for the arbitrator (resolved from modelProviders). Falls back to current session model if not set.',
      showInDialog: false,
    },
  },
}
```

注意：相比之前的设计，去掉了 `includeCurrentModel`、`maxConcurrency`、`skipArbitration`。这些要么有合理的默认值不需要暴露，要么可以用命令行参数临时覆盖，不值得占配置项。

---

## 2. 用户使用方式

### 2.1 触发方式

扩展现有 `/review`，不引入新命令：

```bash
/review                     # 有 review.models 配置 → 多模型; 否则 → 单模型
/review 123                 # 审查 PR #123（模式同上）
/review src/foo.ts          # 审查单文件（模式同上）
/review --multi             # 强制多模型（无配置则列出可用模型并提示配置）
/review --multi 123         # 多模型审查 PR #123
/review --single            # 临时走单模型（忽略 review.models 配置）
/review --single 123        # 单模型审查 PR #123
```

**决策逻辑：**

```
/review [args]
  │
  ├─ 有 --single 标志？ → 单模型 review（忽略 review.models，走现有 4-agent 流程）
  │
  ├─ review.models 已配置且 ≥ 2 个可用模型？
  │   └─ 是 → 多模型 review
  │
  ├─ 有 --multi 标志？
  │   └─ 列出 modelProviders 中可用模型，提示配置 review.models
  │
  └─ 都没有 → 单模型 review（现有行为，完全不变）
```

### 2.2 用户旅程

#### 首次使用（未配置 review.models）

```
> /review --multi

  No review models configured. Available models from modelProviders:
    ✓ gpt-4o (openai)
    ✓ claude-sonnet-4-6-20250514 (anthropic)
    ✗ deepseek-chat (openai) — DEEPSEEK_API_KEY not set

  To enable multi-model review, add to ~/.qwen/settings.json:
    "review": { "models": ["gpt-4o", "claude-sonnet-4-6-20250514"] }

  Proceeding with standard single-model review...
  (... 现有单模型 review 输出 ...)
```

#### 已配置后的首次使用

```
> /review 123

  Reviewing PR #123 with 2 models + arbitrator...

  gpt-4o                ✓ done (12.3s)
  claude-sonnet         ✓ done (18.7s)
  claude-opus (judge)   ✓ done (8.2s)

  ── Multi-Model Review: PR #123 ──────────────────────────

  Review models: gpt-4o, claude-sonnet
  Arbitrator: claude-opus
  Files: 15 files, +342/-128 lines

  Critical (1)

  [gpt-4o, claude-sonnet] src/db.ts:42 — SQL injection
    Query string built via concatenation without sanitization.
    Fix: Use parameterized queries.

  Suggestions (2)

  [claude-sonnet] src/utils.ts:15 — Duplicated logic
    Similar pattern exists in src/helpers.ts:30.

  [gpt-4o] src/api.ts:8 — Missing input validation
    User input passed directly to internal API.

  Nice to have (1)

  [gpt-4o] src/config.ts:22 — Unused import

  Verdict: Request Changes
  Both models identified critical SQL injection at src/db.ts:42.
```

#### 日常使用（已配置）

```
> /review 123

  Reviewing PR #123 with 3 models...

  gpt-4o                ✓ done (12.3s)
  claude-sonnet         ✓ done (18.7s)
  deepseek-chat         ✓ done (15.1s)
  claude-opus (judge)   ✓ done (8.2s, 2 disputes resolved)

  ── Multi-Model Review: PR #123 ──────────────────────────
  (... 报告输出 ...)
```

无额外操作，跟单模型 `/review` 一样直接。

#### 错误处理

```
# 部分模型失败 → 继续
  deepseek-chat         ✗ failed (timeout)
  ⚠ 1/3 models failed. Proceeding with 2 results.

# 所有模型失败 → 自动回退
  ✗ All models failed. Falling back to single-model review.

# API key 缺失 → 跳过并提示
  ✗ gpt-4o: OPENAI_API_KEY not set, skipped
  Tip: Set the env var or remove "gpt-4o" from review.models
```

---

## 3. 技术架构

### 3.1 系统架构图

```
┌────────────────────────────────────────────────────────────────┐
│                   /review Skill (SKILL.md)                      │
│                                                                │
│  Step 1: 获取 diff                                             │
│  Step 2: 调用 multi_model_review tool                          │
│  Step 3: 输出最终报告                                           │
└──────────────────────────┬─────────────────────────────────────┘
                           │
              ┌────────────▼────────────────┐
              │   MultiModelReviewTool      │
              │                             │
              │  - 解析 review.models 配置   │
              │  - < 2 个可用模型 → 返回提示  │
              │    (SKILL.md 自然 fallback   │
              │     到现有 4-agent 流程)     │
              │  - ≥ 2 个模型 → 调用 Service  │
              └────────────┬────────────────┘
                           │
              ┌────────────▼────────────────┐
              │  MultiModelReviewService    │
              │                             │
              │  Phase 1: 并行收集           │
              │  - 为每个模型创建            │
              │    ContentGenerator         │
              │  - p-limit 并发调用          │
              │  - 收集各模型自由文本 review  │
              │  - 个别失败容错              │
              └────────────┬────────────────┘
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │  Model A   │ │  Model B   │ │  Model C   │
     │ .generate  │ │ .generate  │ │ .generate  │
     │  Content() │ │  Content() │ │  Content() │
     └────────────┘ └────────────┘ └────────────┘
              │            │                │
              └────────────┼────────────────┘
                           ▼
              ┌────────────────────────────┐
              │  Phase 2: 仲裁 (始终执行)   │
              │                            │
              │  arbitratorModel 配置了?    │
              │  ├─ 是 → 独立仲裁模型       │
              │  └─ 否 → 会话模型仲裁       │
              │                            │
              │  合并去重 + 裁决 + 输出报告  │
              └────────────────────────────┘
```

### 3.2 模型配置解析

模型解析复用 1.3 节的规则：字符串 → 从 modelProviders 全局查找；对象 → 直接使用。
`arbitratorModel` 同理。

### 3.3 审查模型的输出

各审查模型收到统一的 review prompt（覆盖 correctness、security、quality、performance 四个维度），返回**自由文本** review。

不强制 JSON schema，原因：

- 不是所有模型都良好支持 function calling
- 结构化约束会压制深度推理能力
- 仲裁模型负责整合各模型的自由文本，不需要预先结构化

**审查 prompt 模板**：

```markdown
Review the following code changes. Cover these dimensions:

1. Correctness & Security — bugs, edge cases, vulnerabilities
2. Code Quality — naming, duplication, style consistency
3. Performance — bottlenecks, memory, unnecessary work
4. Anything else that looks off

For each finding, include: file path, line number (if applicable), severity
(Critical / Suggestion / Nice to have), what's wrong, and suggested fix.

End with a verdict: Approve, Request Changes, or Comment.

<diff>
{diff}
</diff>
```

Service 层收集后的内部表示：

```typescript
interface ModelReviewResult {
  modelId: string;
  reviewText: string; // 模型返回的自由文本 review
  error?: string; // 调用失败时的错误信息
}
```

不从自由文本中提取 verdict 或 severity 等结构化字段——这些语义判断全部交给仲裁模型。

### 3.4 结果聚合与仲裁

核心原则：**程序只做收集，LLM 做所有语义工作**。

#### 3.4.1 流程

```
Phase 1: 并行收集 (Service 层)     Phase 2: 仲裁 (始终执行)
         │                                  │
各模型并行调用 → 收集自由文本结果 ────────────▶ 仲裁模型
         │                                  │
    个别失败容错                        合并去重 + 裁决 + 输出报告
    (失败模型跳过)
```

Phase 1 和 Phase 2 之间**没有分支判断**。仲裁模型始终运行，原因：

- 即使所有模型"一致"，多份自由文本仍需合并去重为一份报告
- 从自由文本中程序化提取 verdict/severity 不可靠，不值得为此增加分支复杂度
- 无争议时仲裁模型工作量很小（仅合并），开销可忽略

#### 3.4.2 Phase 1: 并行收集（Service 层）

Service 层只做两件事：**并行调用** + **收集原始文本**。

```typescript
interface CollectedReview {
  /** 各模型的原始自由文本结果（失败的模型不包含在内） */
  modelResults: ModelReviewResult[];

  /** 完整 diff（传递给仲裁模型） */
  diff: string;
}
```

不做 verdict 提取、不做 finding 对齐、不做分歧检测。这些全部是语义工作，交给 Phase 2。

#### 3.4.3 Phase 2: 仲裁（仲裁模型）

仲裁模型的职责：**合并去重 + 验证 + 裁决 + 输出最终报告**。

**仲裁模型选择**：

```
review.arbitratorModel 配置了？
  │
  ├─ 是 → 独立仲裁: 创建独立 ContentGenerator, 通过 generateContent() 调用
  │       输入: 各模型原始 review 文本 + 完整 diff
  │
  └─ 否 → 会话模型仲裁 (默认): Tool 将各模型 review 文本作为结果返回给主会话
          主模型在会话上下文中完成仲裁（有完整项目上下文 + tool 访问）
```

| 维度          | 独立仲裁 (`arbitratorModel`)   | 会话模型仲裁 (默认)            |
| ------------- | ------------------------------ | ------------------------------ |
| 项目上下文    | 无（只看各模型 review + diff） | 有（完整会话历史 + tool 访问） |
| 推荐场景      | 会话模型是快速模型             | 会话模型推理能力足够           |
| 额外 API 开销 | 一次调用                       | 无                             |

**仲裁 Prompt**：

```markdown
You are the senior code reviewer. Multiple models independently reviewed the same
code changes. Your job is to produce the final unified review report.

Tasks:

1. **Merge & deduplicate**: Identify findings that refer to the same issue
   (even if described differently or pointing to nearby lines). Consolidate them,
   noting which models identified each issue.
2. **Resolve severity conflicts**: When models disagree on severity for the same
   issue, evaluate the actual code and choose the appropriate level.
   Default to the HIGHER severity when uncertain.
3. **Validate isolated findings**: For findings raised by only one model,
   verify against the code. Keep valid ones, dismiss false positives with reasoning.
4. **Final verdict**: Approve / Request Changes / Comment, with reasoning.

Output format:

- Group findings by severity (Critical → Suggestion → Nice to have)
- For each finding: [model names] file:line — title, description, suggested fix
- End with verdict and one-sentence reasoning

Each model's full review is provided below, followed by the diff.
Do NOT discard findings just because only one model raised them.
```

---

## 4. 与现有系统的对接

| 组件                                 | 复用方式                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| `ContentGenerator` 工厂              | `createContentGenerator()` 为每个 review model 创建独立实例 |
| `ContentGenerator.generateContent()` | 审查模型和独立仲裁模型均使用自由文本调用                    |
| `ModelConfig` 类型                   | 复用 `models/types.ts` 中的类型定义                         |
| `p-limit` 并发控制                   | 复用 insight 的并发模式                                     |
| 容错模式                             | 复用 insight 的个别模型失败不影响整体的模式                 |
| settings.json                        | 复用现有的设置加载和 merge 机制                             |
| SKILL.md                             | 扩展现有 review skill，调用 MultiModelReviewTool            |

---

## 5. 实现计划

### Phase 1: 核心流程（MVP）

1. **Settings Schema**: 在 `settingsSchema.ts` 中添加 `review.models` 和 `review.arbitratorModel`
2. **Config 层**: 添加 `getReviewModels()` / `getArbitratorModel()` 方法，含模型 ID 解析逻辑
3. **Service 层**: 实现 `MultiModelReviewService`
   - 为各模型创建临时 ContentGenerator
   - 并行 `generateContent()` 调用 + 收集自由文本
   - 仲裁模型调用（独立仲裁 or 返回给会话模型）
4. **Tool 层**: 实现 `MultiModelReviewTool`（含 < 2 模型时的提示返回）
5. **Skill 层**: 扩展 `/review` SKILL.md

### Phase 2: 体验优化

6. 进度展示（各模型审查进度实时更新）
7. `--single` 标志支持（临时走单模型）
8. Level 0 零配置引导（`--multi` 时列出可用模型并提示配置）

### Phase 3: 高级功能

9. 各模型可配置不同的审查 prompt（如某模型专注安全）
10. Review 结果缓存（避免相同 diff 重复审查）
11. 零配置自动模型选择（从 modelProviders 智能选取）

---

## 6. 涉及的文件变更

| 文件                                                         | 变更类型 | 说明                            |
| ------------------------------------------------------------ | -------- | ------------------------------- |
| `packages/cli/src/config/settingsSchema.ts`                  | 修改     | 添加 `review` settings schema   |
| `packages/core/src/config/config.ts`                         | 修改     | 添加 `getReviewModels()` 等方法 |
| `packages/core/src/services/multiModelReviewService.ts`      | **新建** | 多模型 review 核心逻辑          |
| `packages/core/src/tools/multiModelReview.ts`                | **新建** | MultiModelReviewTool            |
| `packages/core/src/tools/tool-names.ts`                      | 修改     | 注册新 tool name                |
| `packages/core/src/tools/tool-registry.ts`                   | 修改     | 注册 MultiModelReviewTool       |
| `packages/core/src/skills/bundled/review/SKILL.md`           | 修改     | 添加多模型分支逻辑              |
| `packages/core/src/services/multiModelReviewService.test.ts` | **新建** | 单元测试                        |

---

## 7. Open Questions

1. **大 diff 的处理**: 当 diff 超过某些模型的上下文窗口时如何处理？
   - **建议**: 后续迭代中检测上下文窗口并跳过不足的模型（含告警），进一步支持按文件分片。
   - **当前状态**: MVP 未实现上下文窗口检测，超长 diff 会由模型 API 自行报错，被 collectReviews 归入失败模型并展示给用户。

2. **独立仲裁模型的上下文**: 独立仲裁模型通过 API 调用，没有 tool 访问能力，无法主动读取代码文件。
   - **建议**: 仲裁 prompt 中包含完整 diff（审查模型也看的是同一份 diff），这足以让仲裁模型验证 findings。不需要额外提取文件上下文。
