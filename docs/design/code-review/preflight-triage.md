# Preflight Triage（评审前预筛）

> 本文档定义 PR review 进入 bundled `/review` 深审**之前**的 tier 路由机制。
> 设计独立，但实现复用 `code-review-design.md` 落地的 workflow wiring（PR ctx 解析、cache、fallback comment）。
> 本文档当前是**草稿（draft）**，未填部分用 `TODO` 标记。

## 与 PR 合规门禁的关系（重要）

本设计专注于 **AI review 内部的 tier 路由**。**合并阻断（merge gating）由独立的 `pr-gate.yml` workflow 负责**，与本文档正交。两者分工：

| 关注点 | 由谁负责 | 是否阻塞合并 | 速度 |
| --- | --- | --- | --- |
| PR title 格式 | `pr-gate.yml` | ✅ required | 秒级 |
| PR body 必填段 (Summary / Validation) | `pr-gate.yml` | ✅ required | 秒级 |
| PR size 上限 | `pr-gate.yml` | ✅ required (XL 拒) | 秒级 |
| Lint / Test / CodeQL | `ci.yml` | ✅ required | 分钟级 |
| **AI 代码 review (本设计)** | `qwen-code-pr-review.yml` | ❌ **informational only** | 5–25 min |

**核心定位**：**AI review 永远不应作为 merge gate**。模型抽风、API 限流、偶发 garbage 输出都不该阻断合并。AI review 提供建议，maintainer 看完后用人工判断决定合不合。

合规门禁的完整 plan 见 [`pr-gate-plan.md`](../pr-gate-plan.md)（不在 `code-review/` 目录下，位于 `docs/design/`）。本文档只覆盖 AI review 自身的 tier 路由设计。

> 实施层面：`qwen-code-pr-review.yml` 中 `Check PR size` step **不再发 "PR too large" 评论阻断合并**（已在本 PR 改完），阻断职责由 `pr-gate.yml` 的 `PR Size` job 承担。size 超限时本 workflow 只**内部跳过 AI review**，不影响合并状态。`pr-gate.yml` 与本设计一起在 codex/preflight-triage 分支落地。

## 问题陈述

实测数据（PR #4320 dispatch 验证）：

| 场景 | 实测耗时 | 旧 workflow 对照 |
| --- | --- | --- |
| 6 行 yaml PR（#4327） | 9–16 min，方差 7+ min | ~45s |
| 407 行 PR（#4110） | **50 min step timeout 失败** | 估计 2–5 min |

结论：bundled `/review` 9-agent 流程对绝大多数 PR 都是 over-engineered，且长尾不可预测。`size-gate: 1500 行可配` 的设计在实测下不可达 —— 真实可工作上限远低于此。

> 必须在进入 deep review **之前**判定"该不该深审、要多深"。

## 设计目标

- **G1 — tier 路由前置**：把 tier 决策作为评审流程的**第一步**，不让 deep review 无差别地跑
- **G2 — 分档耗时上限**：ULTRA_LIGHT ≤ 1 min、LIGHT ≤ 2 min、STANDARD ≤ 6 min、DEEP ≤ 25 min（hard cap，非平均值）
- **G3 — Always-emit 契约（核心）**：**每次 CI run 必须在 PR 上落地一条有用的评论**，无论 deep review 跑多久、是否撞 timeout。当前 workflow 的痛点是：bundled `/review` 跑满 50 min step timeout 后 step failure → 只发一条 `"review did not complete successfully, see logs"` —— 等于花了 50 min token + 1 小时 wall time 换来 0 review 内容。本设计要从机制上根除这个 case。
- **G4 — 可预测性**：相同 PR 重跑应给出相近 tier 与相近耗时；preflight verdict 是显式 `::notice::` 输出，maintainer 能 audit

> G3 是用户体验最大的痛点；G2 / G4 是实现它的必要条件。Tier 分档不是为了"分档"本身，是为了把"可能跑 50 min"压回到"最多 X min 必有结果"的硬合约。

## 设计原则

继承 `code-review-design.md` 的 P1 / P5：

- **P1**：review 工具无状态，状态在外部控制流。preflight 也无状态，输入即所有 context；不修改 bundled skill。
- **P5**：复用现有 design 文档与历史决策，不写新的"团队红线"清单。

本设计新增：

- **P6（成本不对称）**：preflight 必须比 deep review 廉价 **10×+**，否则不值得做。目标 wall time ≤ 90s。
- **P7（保守偏差）**：preflight 可错，但错的方向必须保守 —— 宁可升级（多花时间）也绝不降级（漏 finding）。模糊 case 一律向上升档。

## Tier 模型

按 PR 的实际**影响面（blast radius）**分四档。每档对应**不同的执行路径**，不是"同一流程跑不同参数"。

> **关键设计原则：tier 不由 size 决定**。1000 行的文档 PR 和 5 行改 `auth/oauth.ts` 是两种完全不同的"小改动" / "大改动"。size 只是 preflight LLM 拿来做 blast-radius 判断时的一个**辅助信号**，不是 primary criterion。

### 决策的真正维度（blast radius）

preflight LLM 看 PR diff，对以下维度打布尔分：

| 维度 | 描述 |
| --- | --- |
| `user_facing` | 改动是否会被终端用户感知（CLI 输出、API 行为、文案）|
| `security_sensitive` | 是否触及 auth / secrets / 权限 / 加密 / 输入校验 |
| `public_api` | 是否改 npm 包导出 / SDK 公开 API / CLI flag 签名 |
| `build_or_release` | 是否改构建 / 发布 / CI / 部署管道 |
| `data_path` | 是否改持久化层 / schema / migration / 数据格式 |

加上影响面**广度**信号（跨多少 module / package、是否触及 hot code path），preflight LLM 综合判 tier。

### Tier 概览表

| Tier | 典型 blast radius 画像 | 是否调 LLM | 是否调 bundled skill | 目标耗时 |
| --- | --- | --- | --- | --- |
| **ULTRA_LIGHT** | 几乎为 0：纯文档 / lockfile / 单测 fixture / formatting-only / 不影响运行时的资源文件 | 否（preflight 本身那次不算）| 否 | ~30s–1 min |
| **LIGHT** | 低且本地：单模块、不导出、无 security/release/API 信号、无跨文件影响 | 1 次单发 | 否 | ~1–2 min |
| **STANDARD** | 中等：跨多文件 / 同 package 内多模块 / 改了内部 API、但不触及上面 5 个 high-risk 维度 | 1 次单发（带结构化清单） | 否（除非 maintainer override） | ~3–6 min |
| **DEEP** | 任一 high-risk 维度 = true OR 大幅跨 package 影响 OR `@qwen /review --deep` | 多次（agent fan-out） | 是 | ~10–25 min |

> Size 在这个表里**不出现**。它只是 preflight LLM 拿到的输入信号之一。判定逻辑完全在 LLM 自身，**不再有 path-glob / keyword 安全网**（早期草稿设计过 `.qwen/review-tier-rules.yml`，后来意识到这与"用内容判 blast radius"的初衷相悖 —— path 也是机械启发式）。LLM 判错由 maintainer 用 `@qwen /review --tier=...` 显式纠正。
>
> 唯一例外：`size > 1500` 仍维持现有 size-gate 拒评（防止 PR 失控太大根本没法 review），但这是**预防滥用**，不是 tier 路由。

> Tier 名称是稳定 contract，对外（CI summary、`@qwen /review --tier=...`）都用这些字符串。

### 执行路径要点

- **ULTRA_LIGHT / LIGHT / STANDARD** 三档全部走单发 qwen 调用（绕开 bundled skill），耗时由 model 的 max_tokens × 生成速率天然封顶
- **只有 DEEP 调 bundled skill**，沿用 Phase 1-3 的 CI-lightweight steering（不动）
- 单发调用的 prompt 复杂度按 tier 递增：LIGHT 简洁 markdown、STANDARD 带 P0–P3 结构化清单 + cross-file 提示
- bundled skill 9-agent 的价值仅在 DEEP 保留 —— 它本来就是为高风险 PR 准备的

## Tier 实现机制

每个 tier 有**明确的执行路径、硬耗时上限、always-emit 兜底**。三档（ULTRA_LIGHT / LIGHT / STANDARD）走单发 qwen 调用、天然 bounded；DEEP 走 bundled skill + 流式累加器实现 always-emit。

### ULTRA_LIGHT

- **执行路径**：workflow shell only，不调任何 LLM
- **输入**：preflight 的 verdict（`tier`、`rationale`、`blast_radius`）
- **动作**：shell 直接 compose 一条评论 markdown，模板示例：
  ```
  ## Qwen Code Review — Skipped

  This PR is **{rationale}**; no deep review needed.

  - blast_radius: docs / lockfile only
  - changed_files: …
  - changed_lines: …

  Reply `@qwen /review --tier=light|standard|deep` to force a review.
  ```
- **耗时硬上限**：60s（preflight 自身 ≤ 30s + shell ≤ 5s + `gh pr comment` ≤ 25s）
- **超时兜底**：若 60s 内未能 comment（极罕见，仅网络问题）→ 走 fallback comment 路径

### LIGHT

- **执行路径**：workflow → 单次 qwen 调用（不走 bundled skill）
- **Prompt 文件**：`.qwen/preflight-light-review-prompt.md`（独立可审阅文件）
- **输入注入**：PR 标题/正文、changed file list、首 500 行 unified diff、`focus_areas`（来自 preflight）
- **要求模型输出**：简洁 markdown review，**最多 3 项 findings**，不要求 P0-P3 结构
- **耗时硬上限**：3 min（`timeout 3m qwen ...`） + 5 min step `timeout-minutes`
- **超时兜底**：3 min timeout 触发 → 升级到 STANDARD 重试 1 次（见 §Failure modes）

### STANDARD

- **执行路径**：workflow → 单次 qwen 调用（不走 bundled skill）
- **Prompt 文件**：`.qwen/preflight-standard-review-prompt.md`
- **输入注入**：与 LIGHT 同，但 unified diff 截断点 2000 行，附 `.qwen/review-rules.md`、`focus_areas`、`agents_to_run` 列表
- **要求模型输出**：结构化 P0–P3 markdown，含 cross-file 提示（"if XX changed, also check YY"），含 Validation Evidence verdict（沿用 review-rules.md 既有要求）
- **耗时硬上限**：8 min（`timeout 8m qwen ...`） + 10 min step `timeout-minutes`
- **超时兜底**：8 min timeout 触发 → 走流式累加器（同 DEEP），把已生成的部分作为 partial review 发出；不再升级到 DEEP（STANDARD 失败大概率说明 LLM 服务故障）

### DEEP

- **执行路径**：workflow → bundled `/review` skill（沿用 Phase 1-3 既有 step）
- **Prompt 文件**：沿用 workflow 内联的 CI-lightweight steering（不改）
- **输入注入**：`focus_areas` 作为 "additional reviewer focus" 拼到 prompt 末尾
- **耗时硬上限**：25 min（`timeout 25m qwen ...`），step `timeout-minutes: 30`，比当前的 50 min / 60 min **大幅压缩**
- **流式累加器（关键差异）**：现有 stream-json 解析只保留最后一段 assistant text；本设计改为**累加所有 assistant text 段**到 `qwen-review-summary.md`，并在每段写入时落盘
- **超时兜底（always-emit）**：
  - `timeout 25m` 触发时：发送 SIGTERM，宽限 60s 让 qwen flush 最后输出
  - 解析累加器文件：取所有 assistant text segments concat
  - 在头部加 `## ⚠️ Review was time-capped at 25 min — partial output below`
  - 走 `Post review summary comment` 既有路径
  - 只有累加器**真的为空**（极少见，模型还没开始输出就被 kill）才走 fallback comment

### 跨 tier 共享

- 所有 tier 的输出都走同一个 `Post review summary comment` step（既有）—— 不为每个 tier 写一个 comment poster
- 所有 tier 都走同一个 fallback comment 路径，但 fallback 触发概率应该从"经常"降到"几乎从不"（partial output 取代 fallback 成为兜底）
- `gh pr comment` 调用次数：每次 review 恒定 1 次（评论体由前面 step 准备好）

### 耗时硬上限汇总

| Tier | qwen 命令 timeout | step timeout-minutes | 累计 wall time 上限 |
| --- | --- | --- | --- |
| ULTRA_LIGHT | n/a | 1 | ≤ 60s |
| LIGHT | 3m | 5 | ≤ 2 min（典型）/ 5 min（硬上限） |
| STANDARD | 8m | 10 | ≤ 6 min（典型）/ 10 min（硬上限） |
| DEEP | 25m | 30 | ≤ 25 min（含 partial flush） |

**对比当前 workflow（Phase 1-3）**：唯一的 step `Run Qwen Code Review` 配 `timeout 50m` + `timeout-minutes: 60`，且 timeout 时**没有 always-emit 机制**，整个 50 min token 浪费。本设计把"任意 PR 最大 wall time"从 60 min 砍到 30 min，并保证 always-emit。

## 架构

```
GitHub event
     │
     ▼
┌──────────────────┐
│ Resolve PR ctx   │  ← 既有 step
│ Check PR size    │  ← 既有 step (size gate)
└────────┬─────────┘
         ▼
┌──────────────────────────────────┐
│ Preflight triage（NEW）          │
│  • 1 次便宜模型调用，timeout 3m   │
│  • 输入：PR 元信息 + diff 摘要 +  │
│    review-rules.md               │
│  • 输出：JSON {tier, ...}        │
│  • shell 仅做 schema 校验 + 兜底 │
└────────┬─────────────────────────┘
         ▼
   ┌─────┴─────┬───────────┬───────────┐
   │           │           │           │
ULTRA_LIGHT  LIGHT      STANDARD     DEEP
   │           │           │           │
   ▼           ▼           ▼           ▼
shell-only   单发 qwen   单发 qwen   bundled /review
不调 LLM     timeout 3m  timeout 8m  timeout 25m
≤ 60s       ≤ 2m        ≤ 6m         ≤ 25m
                                     + 流式累加器
                                     + 超时 partial flush
                                     ───────────────
                                       always-emit
```

## Preflight 实现

### Inputs

- PR title, body, draft state, author, base branch
- Changed file list + 每文件行数
- `git diff --stat`
- 首 200 行 unified diff（行数限是预算保护）
- `.qwen/review-rules.md` 内容（让模型懂项目规则）
- 触发事件类型（opened / synchronize / `@qwen /review` / dispatch）

### Model

- 默认：`vars.QWEN_PR_PREFLIGHT_MODEL`
- fallback：未设时 → `vars.QWEN_PR_REVIEW_MODEL`（同 deep review）
- timeout：3 min 硬上限（远低于 deep review）

> 推荐 `QWEN_PR_PREFLIGHT_MODEL` 指向便宜快模型（如 qwen-plus / qwen-turbo），而非 qwen-max。

### Output（强 JSON schema）

```json
{
  "tier": "ULTRA_LIGHT | LIGHT | STANDARD | DEEP",
  "rationale": "<one line, ≤ 200 chars>",
  "blast_radius": {
    "user_facing": true,
    "security_sensitive": false,
    "public_api": false,
    "build_or_release": false,
    "data_path": false
  },
  "focus_areas": [
    "<concrete file:line + concern>, …"
  ],
  "agents_to_run": ["correctness", "security", "code_quality"]
}
```

- shell 层用 `jq` 验证 schema：缺字段 / tier 非法 / blast_radius 不完整 → 视作 preflight 失败，走兜底（见 Failure modes）
- `focus_areas`、`agents_to_run` 仅 STANDARD/DEEP 使用

> tier 决策**完全由 preflight LLM 看 diff 内容判定**，没有 path-glob 或 keyword 启发式安全网。LLM 判错由 maintainer 用 `@qwen /review --tier=deep` 显式纠正。唯一例外：`size > 1500` 由 `pr-gate.yml` 拒评（与 tier 路由正交，详见 [`../pr-gate-plan.md`](../pr-gate-plan.md)）。

## Failure modes

兜底分两层：**preflight 阶段** 和 **review 执行阶段**。后者承担 G3 "always-emit" 的具体实现。

### Preflight 阶段

| 故障 | 兜底动作 | 严重度 |
| --- | --- | --- |
| preflight 模型超时（> 3 min） | tier = DEEP，留 warning（P7 保守） | 兜底 |
| preflight 返回非 JSON | tier = DEEP，留 warning | 兜底 |
| preflight 返回 JSON 但 schema 不完整（缺 tier 等） | tier = DEEP | 兜底 |
| preflight 模型判 DEEP 但 changed_lines > 1500 | size-gate 拒评，不进 preflight 后续 | 既有 |

### Review 执行阶段（G3 always-emit 落地）

| 故障 | 兜底动作 | 落地评论 |
| --- | --- | --- |
| **ULTRA_LIGHT**：shell compose 失败 | 走 fallback comment 路径 | 既有 fallback（"see logs"） |
| **LIGHT**：`timeout 3m` 触发 | 升级到 STANDARD 重试 1 次 | 重试后的 STANDARD 输出 |
| **LIGHT**：模型返回空 / 解析失败 | 升级到 STANDARD 重试 1 次 | 同上 |
| **STANDARD**：`timeout 8m` 触发 | 启动流式累加器（同 DEEP）→ 取已生成内容 → 头部加 `⚠️ time-capped` 警告 → 发出 | **partial review markdown** |
| **STANDARD**：累加器也为空（极罕见，model 还没开始输出） | 走 fallback comment 路径 | 既有 fallback |
| **DEEP**：`timeout 25m` 触发 | 累加器收集所有 assistant text segments → SIGTERM + 60s grace → 头部加 `⚠️ time-capped` 警告 → 发出 | **partial review markdown** |
| **DEEP**：bundled skill 抛错（非 timeout） | 检查累加器：有内容 → partial flush；空 → fallback | partial 或 fallback |

**Always-emit 不变量**：每次 review 执行阶段的退出路径只有两种 —— "正常 review 评论"或"partial review 评论"或"fallback 评论"，前两者覆盖 ≥ 95% 的失败 case，fallback 只在累加器都空时触发。

### 流式累加器实现要点

当前 `Phase 1-3` 的 stream-json 解析器（`packages/core/src/skills/bundled/review/SKILL.md` 之外，在 workflow yaml 里）只保留**最后一段** assistant text。本设计要改：

- 收集**所有** `type === "assistant" || type === "message"` 事件的 text 内容
- 每收到一段就 append 到 `qwen-review-summary.md`（增量落盘，进程被 kill 也不丢）
- 头部插入元信息：`<!-- tier=STANDARD; status=timeout|complete; segments=N -->`
- 解析失败时 `cp $stream qwen-review-summary.md`（既有兜底，保留）

> 这个改动同时让"调试期看进度"（用户之前关心的）与"timeout 时有结果"（本设计目标）都得到满足 —— 之前是覆盖式只为前者牺牲后者，现在是累加式两者兼得。

## Maintainer override

两层 override（path-glob 兜底层已砍掉）：

| 层级 | 表达式 | 效果 |
| --- | --- | --- |
| 触发评论 | `@qwen /review --tier=ultra_light\|light\|standard\|deep` | 跳过 preflight，直接用指定 tier |
| workflow_dispatch input | 新增 `tier_override` (auto / ultra_light / light / standard / deep) | 跳过 preflight |

shell 端最终 tier = override 值（若有）else preflight LLM verdict。

## 校准 loop

每次 run 在 `$GITHUB_STEP_SUMMARY` 打：

```
Preflight verdict: STANDARD (rationale: ...)
Override applied: none
Final tier: STANDARD
Deep review verdict: APPROVE
```

每周/每月维护者人工对照：

- preflight 判 LIGHT 但实际 deep review 找出 P0/P1 的比例（漏档）
- preflight 判 DEEP 但实际仅 P3 finding 的比例（过度保守）
- 调 preflight prompt（calibration 示例、conservative bias 措辞）

> 校准数据存放位置见 §关键决策 D5：dedicated tracking issue 结构化评论。

## Workflow step 草稿（伪 YAML）

四条独立的 tier 路径，共用一套 `Post review summary comment` + fallback。

```yaml
# ─── Stage 0: preflight ──────────────────────────────────────

- name: 'Preflight triage'
  id: 'triage'
  if: |-
    steps.size.outputs.should_review == 'true' &&
    steps.pr.outputs.tier_override == ''
  env:
    PR_NUMBER: '${{ steps.pr.outputs.number }}'
    OPENAI_API_KEY: '${{ secrets.REVIEW_OPENAI_API_KEY }}'
    OPENAI_BASE_URL: '${{ secrets.REVIEW_OPENAI_BASE_URL }}'
    OPENAI_MODEL: '${{ vars.QWEN_PR_PREFLIGHT_MODEL || vars.QWEN_PR_REVIEW_MODEL }}'
  timeout-minutes: 5         # job-level cap
  run: |-
    set -euo pipefail
    # 1. 加载 .qwen/preflight-prompt.md，注入 PR 上下文变量
    # 2. timeout 3m qwen --prompt "<filled prompt>" --output-format json
    # 3. jq 验证 schema: tier ∈ {ULTRA_LIGHT, LIGHT, STANDARD, DEEP}, blast_radius 完整
    # 4. final_tier = tier_override (if set) else preflight tier
    # 5. 任何一步失败 → final_tier = DEEP（P7 保守）
    # 8. 写入 outputs: tier, focus_areas, agents_to_run, rationale
    # 9. ::notice:: 输出 verdict 供校准
    echo "::notice::Preflight tier=$final_tier (model=$model_tier, hard_rule=$hard_rule_tier, floor=$floor_tier)"

# Tier override 短路：maintainer 显式指定 tier
- name: 'Honor tier override'
  id: 'override'
  if: steps.pr.outputs.tier_override != ''
  run: |-
    echo "tier=${{ steps.pr.outputs.tier_override }}" >> "$GITHUB_OUTPUT"
    echo "::notice::Tier override applied: $tier_override"

# 统一变量：tier = triage.outputs.tier OR override.outputs.tier
# 后续 step if 用 effective_tier（job-level env 或 step-level fan-in）

# ─── Stage 1: tier-specific execution ─────────────────────────

- name: 'Compose ULTRA_LIGHT comment'
  id: 'ultra_light'
  if: env.EFFECTIVE_TIER == 'ULTRA_LIGHT'
  run: |-
    set -euo pipefail
    # shell-only: 用 triage.outputs.rationale + blast_radius 拼 markdown
    # 不调 LLM
    cat > qwen-review-summary.md <<EOF
    ## Qwen Code Review — Skipped
    This PR is $RATIONALE; no deep review needed.
    ...
    EOF

- name: 'Run LIGHT review'
  id: 'light'
  if: env.EFFECTIVE_TIER == 'LIGHT'
  env:
    OPENAI_MODEL: '${{ vars.QWEN_PR_REVIEW_MODEL }}'
  timeout-minutes: 5
  run: |-
    set -euo pipefail
    prompt="$(cat .qwen/preflight-light-review-prompt.md)"
    # 注入 PR diff + focus_areas
    if ! timeout 3m qwen --yolo \
         --output-format stream-json --include-partial-messages \
         --prompt "$prompt" 2>&1 | tee qwen-review-stream.jsonl ; then
      echo "::warning::LIGHT review failed; will be re-attempted as STANDARD"
      echo "needs_upgrade=true" >> "$GITHUB_OUTPUT"
      exit 0    # 不让 step 失败，由下一个 step 处理升级
    fi
    # 累加式解析（见 §Failure modes 流式累加器实现要点）
    # 写入 qwen-review-summary.md

- name: 'Run STANDARD review (or LIGHT upgrade)'
  id: 'standard'
  if: |-
    env.EFFECTIVE_TIER == 'STANDARD' ||
    steps.light.outputs.needs_upgrade == 'true'
  env:
    OPENAI_MODEL: '${{ vars.QWEN_PR_REVIEW_MODEL }}'
  timeout-minutes: 10
  run: |-
    set -euo pipefail
    prompt="$(cat .qwen/preflight-standard-review-prompt.md)"
    # 注入 PR diff + focus_areas + agents_to_run + review-rules.md
    out=qwen-review-stream.jsonl
    set +e
    timeout --kill-after=30s 8m qwen --yolo \
      --output-format stream-json --include-partial-messages \
      --prompt "$prompt" 2>&1 | tee "$out"
    status=${PIPESTATUS[0]}
    set -e
    # 累加式解析（即使 timeout，已落盘的 stream 也能解出 partial）
    node scripts/parse-review-stream.js "$out" qwen-review-summary.md
    if [ "$status" -eq 124 ]; then
      # prepend partial-output warning
      printf '## ⚠️ Review was time-capped at 8 min — partial output below\n\n%s' \
        "$(cat qwen-review-summary.md)" > qwen-review-summary.md
      echo "::warning::STANDARD review timed out; posting partial output"
    fi

- name: 'Run DEEP review (bundled skill)'
  id: 'deep'
  if: env.EFFECTIVE_TIER == 'DEEP'
  env:
    OPENAI_MODEL: '${{ vars.QWEN_PR_REVIEW_MODEL }}'
  timeout-minutes: 30      # 较 Phase 1-3 的 60min 大幅压缩
  run: |-
    set -euo pipefail
    # 沿用 Phase 1-3 的 CI-lightweight steering，但加 focus_areas 注入
    # timeout 25m + 30s grace
    set +e
    timeout --kill-after=60s 25m qwen --yolo \
      --output-format stream-json --include-partial-messages \
      --prompt "$prompt" 2>&1 | tee qwen-review-stream.jsonl
    status=${PIPESTATUS[0]}
    set -e
    # 累加式解析（关键变化：不再覆盖式）
    node scripts/parse-review-stream.js qwen-review-stream.jsonl qwen-review-summary.md
    if [ "$status" -eq 124 ]; then
      printf '## ⚠️ Review was time-capped at 25 min — partial output below\n\n%s' \
        "$(cat qwen-review-summary.md)" > qwen-review-summary.md
      echo "::warning::DEEP review timed out; posting partial output"
    fi

# ─── Stage 2: 统一发评论 ──────────────────────────────────────

- name: 'Post review summary comment'
  id: 'post-summary'
  if: |-
    steps.pr.outputs.should_comment == 'true' &&
    hashFiles('qwen-review-summary.md') != ''
  run: |-
    # 沿用 Phase 1-3 的 gh pr comment 路径，body-file = qwen-review-summary.md
    gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \
      --body-file qwen-review-summary.md

- name: 'Post fallback comment'
  if: |-
    failure() &&
    steps.pr.outputs.should_comment == 'true' &&
    hashFiles('qwen-review-summary.md') == ''
  # 仅当累加器都为空才触发，预期 < 5% case
  run: |-
    # 沿用 Phase 1-3 fallback ("see logs")
```

> 完整 YAML 在实现阶段补；本草稿列骨架与依赖关系。`scripts/parse-review-stream.js` 是新工具（累加式解析），需要新增。

## 分阶段实施

| Phase | 范围 | 必须性 |
| --- | --- | --- |
| **A** | preflight wiring + 4-tier 路由 + JSON schema 验证 + 保守 failure mode | **必须**（本 PR MVP） |
| **B** | maintainer override（`--tier=` slash flag、`tier_override` dispatch input） | 可并入或独立 |
| **C** | 校准 loop（::notice:: 输出 + 数据沉淀） | 独立 follow-up |

## 不做的事（避免范围漂移）

- **不修改** bundled `/review` skill 内部（P1）
- **不引入**历史 PR 感知（属于 `roadmap.md` 后续阶段）
- **不做** GitHub App 切换（属于 `roadmap.md` 后续阶段）
- **不做**方向 / scope / anchor cite 类判定（属于原 Phase 4 Design Gate，与本设计正交）
- **不引入新工具调用**到 preflight 模型（preflight 只读不写，不调 gh / git）

## 关键决策

> 本节是设计阶段已敲定的实现选项。可在实现期 push back，但需要充分理由。

### D1 — Preflight 模型 SKU 不在 design doc 里硬编码

`vars.QWEN_PR_PREFLIGHT_MODEL` 由仓库维护者按现有 endpoint 配置；fallback 到 `vars.QWEN_PR_REVIEW_MODEL`。

- 维护者**应该**指向便宜快模型（约束：200 行 PR 的 preflight 响应 ≤ 60s）；具体 SKU 不在 doc 沉淀 —— SKU 名字 6 个月内就会变，写进设计文档迟早过时
- 若未设此 var，fallback 到 deep review 模型 —— 行为正确但成本翻倍，会在 workflow 启动 step 打 `::warning::` 提示维护者配置

### D2 — Preflight prompt 放独立文件

新建 `.qwen/preflight-prompt.md`，workflow 用 `$(cat ...)` 注入。

- **理由**：preflight prompt 预计 50–200 行（包含 JSON schema 描述、tier 决策规则、blast_radius 维度定义）；内联进 workflow yaml 会让 yaml 难读
- **理由**：与 `.qwen/review-rules.md` 的约定一致 —— 项目级 review 行为配置都在 `.qwen/` 下
- **理由**：maintainer 调 prompt 不需要改 workflow yaml，PR review 关注点更聚焦

### D3 — LIGHT / STANDARD 各有独立的 review prompt 文件

新建 `.qwen/preflight-light-review-prompt.md` 与 `.qwen/preflight-standard-review-prompt.md`。

- **不复用** `review-rules.md` 的 functional review 段 —— 那是**评审标准**，不是**输出模板**。LIGHT/STANDARD prompt 需要同时含：评审标准 + 输出格式 + focus_areas 注入约定
- LIGHT prompt：要求最多 3 项 findings、简洁 markdown、不强制 P0–P3 结构
- STANDARD prompt：要求 P0–P3 结构、Validation Evidence verdict（沿用 review-rules.md 既有约定）、cross-file 提示

### D4 — 不引入 path-glob hard rule 文件（取消）

早期草稿提议新建 `.qwen/review-tier-rules.yml` 做 path → min_tier 升档兜底。**最终决定不做**。

- **理由**：path 也是机械启发式 —— 跟"size 决定 tier"是同一类毛病；blast radius 应该从 diff 内容判断，path 只是个弱信号
- **理由**：path 列表会随项目演进腐败，维护成本随时间增长
- **理由**：preflight LLM 看到 diff 内容比看到 path 更准，重复防御不增加准确率
- **理由**：LLM 判错由 maintainer 用 `@qwen /review --tier=deep` 显式纠正即可，成本可控
- 后果：少 1 个文件、少 1 个 yq 依赖、shell 简化

### D5 — 校准数据沉淀位置：tracking issue 结构化评论

每次 run 在 `$GITHUB_STEP_SUMMARY` 打 verdict（既有）；**另**在一个 dedicated issue（建议标题 `tracking: Qwen PR review calibration data`，labeled `qwen-review-calibration`）以结构化评论形式追加一行：

```
| run_id | pr | preflight_tier | override | final_tier | review_verdict | wall_time_s | model |
```

- **理由**：CI artifacts 跨 90 天就过期，metrics file commit 到 repo 会污染 history
- **理由**：tracking issue 的评论自带时间戳 + 永久存储，maintainer 用 `gh issue view <n> --comments` 直接看
- **理由**：可以用 `jq` 切片做月度统计
- 实现：workflow 末尾加一个 step，`gh issue comment <calibration_issue_id> --body "..."`，issue ID 来自 `vars.QWEN_REVIEW_CALIBRATION_ISSUE`，未设则跳过本步骤
- 数据**敏感性**：只记 metadata（tier、PR 号、耗时），不记 PR 内容，公开仓库无隐私风险

### D6 — Preflight 用双层 timeout（command + step）

- **command-level**：`timeout 3m qwen ...` —— 保证 qwen 进程 3 min 后被 kill
- **step-level**：`timeout-minutes: 5` —— 保证整个 step（含 shell 处理）5 min 后被 kill
- **理由**：单靠 `timeout 3m`，若 qwen 之后的 jq / shell 处理卡住（极少见但可能 —— 比如解析超大 JSON），step 会无限挂；双层叠加最稳
- **理由**：5 - 3 = 2 min 余量给 schema 验证、`gh` 调用等
- 同样模式应用到 LIGHT (`timeout 3m` cmd + `timeout-minutes: 5` step)、STANDARD (`timeout 8m` cmd + `timeout-minutes: 10` step)、DEEP (`timeout 25m` cmd + `timeout-minutes: 30` step)

## 需要新增的仓库内文件清单

| 文件 | 用途 | 来源决策 |
| --- | --- | --- |
| `.qwen/preflight-prompt.md` | preflight 模型的提示词 | D2 |
| `.qwen/preflight-light-review-prompt.md` | LIGHT tier 的单发 review prompt | D3 |
| `.qwen/preflight-standard-review-prompt.md` | STANDARD tier 的单发 review prompt | D3 |
| `scripts/parse-review-stream.js` | 累加式 stream-json 解析器（替换 workflow inline node 脚本） | §Failure modes 流式累加器 |
| (修改) `.github/workflows/qwen-code-pr-review.yml` | 加 preflight + 4 tier 执行 + 累加式解析 | §Workflow step 草稿 |
| (修改) `.gitignore` | 已对 `.qwen/*` 例外 `review-rules.md`、`commands/`、`skills/`、`agents/`；需追加例外上述 3 个新文件 | 配套 |

## 需要新增的仓库 vars / secrets

| Name | Kind | 必填 | 默认/兜底 | 用途 |
| --- | --- | --- | --- | --- |
| `QWEN_PR_PREFLIGHT_MODEL` | vars | 否 | fallback `QWEN_PR_REVIEW_MODEL` | preflight 用模型 |
| `QWEN_REVIEW_CALIBRATION_ISSUE` | vars | 否 | 不设则跳过校准记录 | 校准数据存放 issue ID |
| 现有的 `REVIEW_OPENAI_API_KEY` / `REVIEW_OPENAI_BASE_URL` / `QWEN_PR_REVIEW_MODEL` | secrets / vars | 是 | 沿用 Phase 1-3 | 不变 |

## 验收标准（Phase A MVP）

- **AC1**：docs-only PR（如 #4327 同类 6 行 yaml）→ 路由到 ULTRA_LIGHT，wall time < 2 min
- **AC2**：mid-size feature PR（200–500 行单模块）→ 路由到 STANDARD，wall time < 12 min
- **AC3**：含 `**/auth/**` 改动的小 PR → preflight LLM 应该自行判 DEEP（要在 calibration 示例里强化此类 case）；若漏档，maintainer 可用 `@qwen /review --tier=deep` 补救
- **AC4**：preflight 故意返回 garbage（mock 测试）→ 兜底走 DEEP，留 warning，不导致 job fail
- **AC5**：existing fallback comment 路径在 STANDARD/DEEP 失败时仍能发出

## Open questions / 风险

- **R1**：preflight 模型本身的可靠性 —— 便宜模型可能 JSON 结构不稳。需要在实现期 sample 试若干 PR 观察输出质量；不稳就回退到 deep review 模型 SKU。
- **R2**：preflight 漏档 —— 模型可能把高风险 PR 误判为 LIGHT。**缓解**：calibration 示例里强化 high-blast-radius case；校准 loop 数据驱动 prompt 迭代；maintainer 可用 `@qwen /review --tier=deep` 显式补救。
- **R3**：tier 升档的"棘轮效应" —— 用户感知 preflight 永远只升档不降档，长期可能不再信任。**缓解**：校准 loop 数据驱动 ablation，定期 review 是否过度保守。

## Rollback / Emergency Disable

合入后如果 preflight 在生产中出问题（模型频繁判错 / API 限流 / SKU 失效 / cost 暴涨），maintainer 有三级降级路径，按"代价由小到大"排：

### L1 — 跳过 preflight，全部走 deep review（最快、单点操作）

适用：preflight 模型本身坏了（譬如 endpoint down、JSON 结构突然不稳），但 deep review 模型 SKU 还能用。

操作：repo Settings → Secrets and variables → Actions → Variables，把 `QWEN_PR_PREFLIGHT_MODEL` **设为空字符串**（不是 "auto"，是空）。

效果：`Preflight triage` step 仍会跑，但因为没有 `vars.QWEN_PR_PREFLIGHT_MODEL`，fallback 到 `vars.QWEN_PR_REVIEW_MODEL`（deep review 模型），等价于"用 deep model 跑 preflight"。Workflow step 会打 `::warning::` 提示这个 fallback。

代价：preflight 阶段成本翻倍（用贵模型代替便宜模型），但行为正确。**对 PR 流影响为零**。

### L2 — 跳过 preflight 决策本身，全部强制 DEEP（中等代价）

适用：preflight 输出格式系统性偏差（譬如所有 PR 都被判 LIGHT，明显漏档），且 L1 没用（preflight 模型本身不是问题，是 prompt / 决策逻辑出问题）。

操作（任选其一）：
- **临时**：在 `.github/workflows/qwen-code-pr-review.yml` 里，把 `Compute effective tier` step 加一行 `tier="DEEP"` 强制写死
- **手动**：每个 PR 由 maintainer 评论 `@qwen /review --tier=deep` 覆盖（对外部贡献者 PR 体验差）
- **dispatch**：用 `workflow_dispatch` + `tier_override=deep` 触发（仅 maintainer，不影响自动 PR）

代价：所有 PR 都走 bundled `/review` 9-agent 深审，回到 Phase 1-3 的耗时模式（6 行 PR 也跑 16 min；407 行 PR 撞 timeout）。**这是退到改造前的状态**，可工作但慢。

### L3 — 彻底关掉 AI review（最重的杀招）

适用：deep review 模型也挂了 / token 配额耗尽 / 临时止血。

操作：repo Settings → Actions → 把 `qwen-code-pr-review.yml` 这个 workflow **disable**。GitHub UI 上每个 workflow 有 `...` 菜单可以单独 disable，不需要改代码。

效果：`qwen-code-pr-review.yml` 不再运行，PR 上 **不再有任何 AI review 评论**。**`pr-gate.yml` 不受影响**，依然把 PR Template + PR Size 合规门禁挡住——即合规层完全不降级。

代价：失去 AI advisory review；reviewer 全靠人工。但**合并门禁仍然有效**。

### 不变量

无论降到哪一级：
- `pr-gate.yml` 的 PR Template + PR Size 门禁**始终生效**，PR 合规性不降级
- `ci.yml` 的 lint / test / build / CodeQL **始终生效**
- 合并 gate 完整性不依赖 AI review 任何一档

### 选择决策树

```
preflight LLM 失败？
  └─ 是 → 是不是只是 preflight 模型坏？
            ├─ 是 → L1 (清空 PREFLIGHT_MODEL var)
            └─ 否 → 是不是 prompt / 决策逻辑系统性出错？
                      ├─ 是 → L2 (临时强制 tier=DEEP)
                      └─ 否 (deep review 也挂) → L3 (disable workflow)
```

### 监控信号 → 降级触发条件

- preflight step 连续 N=5 次 exit 非 0 → 触发 L1
- maintainer 在 calibration 数据上看到 > 30% 的 PR 被 preflight 错判 → 评估 L2
- API quota / cost dashboard 报警 → L3 直到调查清楚

> 这套降级路径**不依赖任何即将到来的设计**（calibration、改 prompt、改 workflow）。所有 L1/L2/L3 都是**已实施代码的运行时配置**，maintainer 在 GitHub UI 操作即可，无需提 PR。

---

> 草稿状态：本文档由今天的实测数据 + 讨论沉淀。下一步是把 §"待定决策" 敲定，然后进入 Phase A 实现。
