# Code Review 自动化设计

## 问题陈述

仓库当前的 AI PR review 跑在 `.github/workflows/qwen-code-pr-review.yml` 上，调用上游 `QwenLM/qwen-code-action` 触发 bundled review skill（`packages/core/src/skills/bundled/review/SKILL.md`）。bundled skill 本身已经做了 9 个并行 review agent、确定性 lint/typecheck、跨文件影响分析、批量 verification、迭代 reverse audit、模式聚合等工作，单次评审质量已经足够。

但实际运行中暴露了三类持续性问题，单靠 bundled skill 内部优化解决不了：

1. **不收敛**：作者 push 新 commit 时不会自动触发评审；手动评论 `@qwen /review` 触发的每次评审都是全量重评，第一轮已经讨论过的小问题（test coverage、命名风格之类）反复在后续轮次被 raise。bundled skill 设计上有 `.qwen/review-cache/pr-<n>.json` 做增量评审，但 GitHub Actions 每次跑都是全新 runner，cache 在 run 之间丢失，机制实际从未生效。
2. **方向偏差**：`review-rules.md` 当前的 `Product Direction` gate 只是抽象规则（"should fit Qwen Code's CLI/TUI-first developer workflow…"），模型靠常识填空。当 PR 是常见 feature 时常识够用，碰到"OS 抽象塞 CLI"这种 framing 巧妙的方向漂移时，模型常识反而站在作者一边（"先锋实验值得鼓励"），200 轮迭代后体量翻倍但方向走偏，正是这个 failure mode。
3. **历史决策遗忘**：仓库已经有大量"by design 拒过"的 PR（PR #3863 拒 `/model list`、PR #3627 拒 AppleScript launcher、PR #3972 Telegram 集成自然消亡），每次新 PR 都让 reviewer 重新从零讲一遍"为什么不做"。AI review 完全不感知这些历史决策，新作者重复踩坑。

本文档定义 Code Review 自动化系统的整体设计，目标是把这三类问题用"workflow preflight + 文档 anchor + 历史数据 + 按需 deep review"的组合方案解决，不依赖修改 bundled skill 的核心 9-agent 逻辑。

## 现状对比

| 维度                                    | qwen-code 当前                   | claude-code                                  | coderabbit          |
| --------------------------------------- | -------------------------------- | -------------------------------------------- | ------------------- |
| PR 打开时自动评审                       | ✅                               | ✅                                           | ✅                  |
| `@bot /review` 评论触发                 | ✅ (`@qwen /review`)             | ✅ (`@claude`)                               | ✅ (`@coderabbitai`)|
| 作者 push 新 commit 自动评审            | ❌ 未监听 `synchronize`          | ✅                                           | ✅                  |
| 增量评审 (只评新 commit)                | ⚠️ skill 内置但 cache 不持久化   | ✅                                           | ✅                  |
| 跨 run cache 持久化                     | ❌                               | ✅                                           | ✅                  |
| PR 体积 gate (太大拒评)                 | ✅ (1500 行可配)                 | ❌                                           | ⚠️ 不阻断           |
| Cross-repo PR 安全 gate                 | ✅                               | ✅                                           | ✅                  |
| 项目级 review 规则文件                  | ✅ (`.qwen/review-rules.md`)     | `CLAUDE.md` 段落                             | `.coderabbit.yaml`  |
| 评审规则对照具体设计文档                | ❌ 仅规则文字                    | ⚠️ 靠 `CLAUDE.md` 自陈                       | ❌                  |
| 评审规则对照 roadmap                    | ❌                               | ❌                                           | ❌                  |
| 历史 closed-unmerged PR 感知            | ❌                               | ❌                                           | ❌                  |
| 历史 revert/regression 感知             | ❌                               | ❌                                           | ❌                  |
| 评审主体身份                            | `github-actions[bot]`            | `claude[bot]` (GitHub App)                   | `coderabbitai[bot]` |
| 触发权限校验                            | OWNER/MEMBER/COLLABORATOR        | App installation 权限                        | App installation    |
| 9-agent 并行 + 角色分人格               | ✅                               | ❌                                           | ⚠️ 单 agent         |
| Reverse audit (迭代反审)                | ✅ (最多 3 轮)                   | ❌                                           | ❌                  |
| 确定性 lint/typecheck 集成              | ✅ (tsc/eslint/ruff/clippy/...)  | ⚠️ 靠 hooks                                  | ✅                  |
| Low-confidence finding 不进 PR 评论     | ✅                               | ❌                                           | ❌                  |
| 注：bundled skill 内置能力              | ✅ 详见 `packages/core/src/skills/bundled/review/SKILL.md` |                                  |                     |

> 表中 ❌ / ⚠️ 标的全部是本设计要补的能力，✅ 是已经具备、本设计不动的部分。

## 设计原则

**P1. review 工具无状态，状态在外部控制流。**
bundled `/review` skill 跑完一次就退出，不维护跨 run 状态。所有跨 run 状态（cache、历史 PR 索引、轮次计数）由 workflow 层用 `actions/cache` / GitHub API 维护。skill 不变，可独立测试、可被任何 channel 调用。

**P2. 每个判断必须有 anchor 文件可 cite。**
review-rules.md 的 `Product Direction` gate 当前只有规则文字，模型靠常识填空。新设计要求：每条 direction 类的 finding 必须 cite 一个具体来源（`docs/developers/roadmap.md` 第 N 行 / `docs/design/<feature>/` 某文档 / PR #N 的 close 评论 / `docs.claude.com` 某页面）。无 cite 不发评论。

**P3. critical 必报，非 critical 按轮次抑制。**
bundled skill 已经按 severity 分了 `Critical / Suggestion / Nice to have`，并把 low-confidence 和 `Nice to have` 不发 PR 评论。本设计追加：同一 PR 的第 N+1 轮评审，对 `Suggestion` 类同类型问题（test coverage、命名、注释完整性）按已发过的话题做抑制。

**P4. 方向判断不进入 `/review` deep 流程。**
9 个 agent + reverse audit + verification 是 bundled skill 的 deep review 能力，被多个 channel 复用。方向、scope、历史 by-design 拒绝属于 preflight gate，应在 workflow 层先跑；只有 gate 通过后才调用 bundled `/review` 做实现层 review。

**P5. 当前 PR 仓库改造优先复用现有 design 文档，不写新"团队红线"清单。**
仓库已有 `docs/developers/roadmap.md` / `docs/developers/architecture.md` / `docs/design/*` / 历史 closed-unmerged PR 评论。这些都是真实的"团队方向"记录，比新写一份 `anti-features.md` 更准、更新、更有 cite 价值。

## 触发与权限

### 触发事件

| 事件                                | 行为                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `pull_request_target.opened`        | 自动跑全量评审                                             |
| `pull_request_target.reopened`      | 自动跑全量评审                                             |
| `pull_request_target.ready_for_review` | 自动跑全量评审（draft 转正式）                          |
| `pull_request_target.synchronize`   | **新增**：作者 push 时自动跑**增量评审**（依赖 cache）     |
| `issue_comment` 含 `@qwen /review`  | 评论触发，默认**强制重跑**，不因同 SHA cache 命中短路       |
| `pull_request_review_comment` 含 `@qwen /review` | 评论触发，同上                                |
| `pull_request_review` 含 `@qwen /review`         | 评论触发，同上                                |
| `workflow_dispatch`                 | 手动触发，可选 dry-run / comment 模式 + 自定义 focus 文本，默认强制重跑 |

### 权限校验

所有触发都要求 actor 是 `OWNER / MEMBER / COLLABORATOR`，已在 workflow `if:` 表达式实现。Cross-repository PR（fork）一律不跑评审，跑也跑不出（worktree 拉不到 head sha），只发一条引导评论说明 maintainer 可以手动 copy patch 到本仓库分支后再评。

### 触发频率策略

`synchronize` 不做 debounce：每次 push 都触发，由 cache 保证后续运行只评增量、token 成本可控。如果未来 push 频率过高出现 CI 拥塞，再加 `concurrency` cancel-in-progress（当前已经有）+ debounce 兜底。

Phase 2 先让评论触发和 `workflow_dispatch` 不 restore cache。原因是 maintainer 可能在同一个 commit 上追加新的 review focus；如果 restored cache 里的 `lastCommitSha` 与当前 head 一致，bundled skill 会按 "No new changes since last review" 直接退出，导致手动复核没有真正执行。

Phase 6 引入轮次抑制时，再给 bundled skill 增加显式的 force/run-again 语义（如 `--force`）：workflow 可以 restore finding cache 给手动复核使用，同时通过 `--force` 绕过 no-change short-circuit。这样既能利用历史 findings 抑制噪声，又不会让手动复核被 cache 命中跳过。

## Preflight Gates

依照现有 `.qwen/review-rules.md` 的 gate 分层模型，workflow 在调用 bundled `/review` 之前先跑 preflight。preflight 分为 **blocking** 和 **advisory** 两档。blocking gate 不通过时 review 停止；workflow 只发一条 process comment 解释阻塞原因和下一步，不进入实现细节 review。advisory gate 有 concerns 时记录到后续 `/review` prompt 或 summary 中，但不阻塞。

| Gate                  | 默认  | anchor 来源                                                          |
| --------------------- | ----- | -------------------------------------------------------------------- |
| Scope / PR Purity     | blocking  | 当前 review-rules.md 文字（无 file anchor）                     |
| Product Direction     | blocking  | **新**：`docs/developers/roadmap.md` + `docs/design/*` + 历史 closed-unmerged PR |
| Validation / Dogfooding | advisory；高风险 feature 可 blocking | 当前 review-rules.md 文字 + PR template |
| Functional Review     | gate 通过后运行 | bundled `/review` deep 能力                                  |

Product Direction gate 的具体执行流程见 §Design Gate。

Validation / Dogfooding 的具体执行流程见 §Feature PR Readiness Gate。

## Workflow Review Pipeline

整个 review pipeline 分四个 stage，按成本递增。每个 stage 失败时输出形态不同，故意分层是为了让方向问题在前 30 秒就被决定，不浪费深审成本。

| Stage | 触发动作                                                                            | 成本     | 失败处理                                                                  |
| ----- | ----------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| 0     | GitHub `if:` 表达式（event type / author_association / `@qwen /review` 关键词）      | 0        | 静默不跑（GitHub 内置过滤）                                               |
| 1     | workflow shell step（PR size、fork、env vars、model 配置、PR shape 生成）             | <5s      | post process comment（"PR too large" / fork rejected / model var missing）|
| 2     | Design Gate helper（方向、scope、history、validation）                                | ~30s     | post process comment + cite anchor；BLOCK 时不进 Stage 3                  |
| 3     | bundled `/review` deep review（9-agent + reverse audit + verification）              | 5-30 min | post inline + summary review comments                                     |

workflow 内部步骤顺序固定为：

1. **Stage 0/1**：解析 PR context、权限、size 和 cross-repo gate；生成 PR shape 摘要。
2. **Stage 2**：运行 **Design Gate**。这是独立 workflow step，不调用 bundled `/review`。
3. 如果 Design Gate 输出 `BLOCK`，发 process comment 并停止。
4. 如果输出 `PASS` 或 `ADVISORY_ONLY`，进入 Stage 3 调用 bundled `/review`，把 advisory 摘要附加到 prompt。
5. **Stage 3**：bundled `/review` 负责实现层 review：correctness、security、quality、performance、tests、reverse audit、build/test verification。

## Design Gate

bundled `/review` 当前的 9 个 agent 都是**实现层**评审（correctness / security / quality / perf / test / 三个 audit persona / build-test）。方向判断不作为第 10 个 agent 并行注入，而是 workflow 中的独立 preflight gate。

### 实现形态

Design Gate 作为可本地测试的 CLI helper 实现，优先新增：

```bash
qwen review design-gate <pr_number> <owner>/<repo> \
  --out .qwen/tmp/qwen-review-pr-<pr_number>-design-gate.json
```

workflow 只负责解析 PR、调用 helper、读取 JSON、决定是否继续调用 bundled `/review`。不要把大段 gate 逻辑直接写在 YAML 里。

### 输入

- PR title + body
- 主要 changed file 路径列表（不含 diff 内容，避免被实现细节带偏 framing）
- PR shape 摘要（由确定性 helper 从 changed files 生成）：package 边界、import/export 变化、公共 CLI/SDK/API 入口变化。它不包含完整 diff，但给架构合规检查足够的结构化信号。
- 自动加载 anchor 文档：
  - `docs/developers/roadmap.md`
  - `docs/developers/architecture.md`
  - `docs/design/<相关 feature>/*.md`（按 PR 路径 keyword 自动匹配）
- 历史检测数据（见 §历史 PR/Issue 感知）

### PR Shape 摘要生成

PR shape 摘要由 workflow 的确定性 helper 在调用 Design Gate 之前生成，不依赖 LLM。第一版用 git + 路径前缀 + 轻量 grep 实现，避免引入 AST 解析依赖：

```bash
qwen review pr-shape <pr_number> <owner>/<repo> \
  --out .qwen/tmp/qwen-review-pr-<pr_number>-shape.json
```

helper 内部步骤：

- `git diff --stat <base>...<head>`：每个文件 +/- 行数
- 路径前缀分桶：根据 `packages/<x>/src/<y>/...` 切分，输出 changed packages 列表 + 每个 package 的 file 数 / 行数
- 公共导出 grep：在 changed file 上 `grep -nE '^(export |module\.exports)'`，识别是否引入或修改 public surface
- 配置文件检测：`package.json` / `tsconfig.json` / `.github/workflows/*.yml` / lockfile 改动单独 flag
- API entrypoint 检测：known entrypoint 路径（`packages/cli/src/commands/*` / `packages/sdk-*/src/index.ts` / `action.yml` 等）修改单独 flag

输出形如：

```json
{
  "packages_touched": ["cli", "core"],
  "public_surface_changes": [
    { "file": "packages/cli/src/commands/auth/index.ts", "kind": "new_export", "name": "createAuthSession" }
  ],
  "config_files_changed": ["package.json", ".github/workflows/qwen-code-pr-review.yml"],
  "dependency_changes": ["+@octokit/rest@22.0.0"],
  "diff_stat": { "files": 12, "additions": 387, "deletions": 124 }
}
```

Design Gate 用这个结构化输入做架构合规子检查，不只凭 file path 猜架构边界。后续如果发现轻量 grep 召回不准，可以替换为 typescript / language server 驱动的 AST 分析，contract 不变。

### 输出契约

Design Gate 输出结构化 JSON，workflow 只依赖这个 contract：

```json
{
  "status": "PASS",
  "summary": "Short reviewer-facing summary.",
  "findings": [
    {
      "gate": "product_direction",
      "severity": "blocking",
      "message": "This PR conflicts with a prior maintainer decision.",
      "citations": [
        "https://github.com/QwenLM/qwen-code/pull/3863#issuecomment-...",
        "docs/developers/roadmap.md:3"
      ]
    }
  ]
}
```

`status` 只能是：

- `PASS`：无 blocking / advisory finding。
- `ADVISORY_ONLY`：可继续进入 `/review`，workflow 把摘要附加到 `/review` prompt 和 GitHub Step Summary。
- `BLOCK`：workflow 发 process comment 和 GitHub Step Summary，然后停止，不调用 bundled `/review`。

`severity=blocking` 的 finding 必须至少有一个 citation。无 citation 的方向判断只能降级为 advisory，或不输出。

### 4 组并行检查

| 子检查                  | anchor                                                                                 | 输出形态                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Roadmap 对齐**        | `docs/developers/roadmap.md`                                                           | "本 PR 落在 roadmap 哪一项 / 是否 in-progress / Phase 与 PR scope 是否匹配"   |
| **架构合规**            | `docs/developers/architecture.md` + PR shape 摘要                                      | "是否违反 CLI/Core/Tools 分层 / 是否引入跨层依赖"                              |
| **既有设计 / 重复检测** | `docs/design/*` 文件 + `gh search prs --state merged` 历史 PR + 改动文件交集分析       | "是否已有 design 文档 / 是否已有 PR 实现 / 是改进还是覆盖"                     |
| **Claude Code 对标**    | WebFetch `docs.claude.com/en/docs/claude-code/*`，仅当 PR 是新 feature 时触发          | "Claude Code 有无对应 feature / 形态差异是否在 PR description 解释"            |

每项检查独立输出 `CONSISTENT / ADVISORY / VIOLATION` 三态，**任何一项 VIOLATION 触发 blocking**。Claude Code 对标项**永远是 advisory**（roadmap 的 "Distinctive Features to Discuss" 段承认有差异化的疆域，所以 Claude Code 不能当 ground truth）。

### 产品方向依据优先级

Product Direction 的 blocking 判断按证据强度排序：

1. maintainer 历史明确决策（closed-unmerged PR close comment、wontfix / not planned label）最高。
2. `docs/developers/roadmap.md` 和 `docs/developers/architecture.md` 次之。
3. 既有 `docs/design/<feature>/*.md` 次之。
4. Claude Code 对标只作为 advisory baseline，不作为 blocking ground truth。
5. 模型常识不能单独形成 blocking finding。

### Claude Code 对标的合法性

`docs/developers/roadmap.md` 开头明确写：

> Objective: Catch up with Claude Code's product functionality, continuously refine details, and enhance user experience.

`docs/design/slash-command/compare.md`、`docs/design/tool-use-summary/tool-use-summary-design.md` 等已有 design 文档惯例就含 Claude Code 功能对照。所以"在 review 流程里加 Claude Code 对标"是落实 roadmap 既定目标 + 延续 design 文档的写作约定，不是引入新偏好。

但 roadmap 也明确有 "Distinctive Features to Discuss"（Home Spotlight、Competitive Mode）—— 这反过来说明 Claude Code 是 baseline，不是天花板。差异化要解释，不是禁止。Design Gate 的 prompt 必须明确这点。

### Fail Modes

Design Gate 各子检查可能失败（API 限流、网络超时、anchor 文件缺失、LLM 调用错误）。默认 **fail-open**：单项子检查失败 → 降级为 advisory，记录到 step summary，不阻塞进入 `/review`。例外是关键路径，必须 fail-closed：

| 失败位置                              | 策略         | 行为                                                                       |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `qwen review pr-shape` 整体失败       | fail-closed  | post process comment "无法分析 PR shape，需要 maintainer 手动 review"，停止；不调用 `/review` |
| Roadmap / architecture anchor 文件缺失 | fail-open    | 该子检查跳过，step summary 记 "anchor missing: docs/developers/roadmap.md"  |
| `gh search prs/issues` API 限流       | fail-open    | 历史检测降级为 advisory，cite "history scan unavailable: rate-limited"       |
| Claude Code WebFetch 失败             | fail-open    | 该子检查跳过，cite "Claude Code comparison skipped: <reason>"                |
| Design Gate LLM 调用整体失败          | fail-open    | gate 整体输出 `ADVISORY_ONLY` + summary 标 "design gate degraded"，进入 `/review` |
| helper 输出非法 JSON                  | fail-closed  | post process comment + 整个 workflow 失败，让 maintainer 看 logs             |

`fail-closed` 只用于 helper 完全无法判断的情况（PR shape 没生成 → 后续 4 组检查没 baseline；输出 schema 错 → workflow 没法消费）。其他情况一律 fail-open，避免基础设施问题阻塞合理 PR。Telemetry 应记录每次降级的原因，长期监控基础设施稳定性。

## Feature PR Readiness Gate

Validation / Dogfooding gate 检查 PR body 是否让 reviewer 能快速复现和验证变更。它使用 `.github/pull_request_template.md` 和 `.qwen/review-rules.md` 作为依据。

### 触发范围

以下 PR 类型需要 validation / dogfooding 说明：

- feature PR
- bugfix PR
- CLI / TUI / interactive behavior change
- GitHub Actions / workflow / release flow change
- auth、model selection、sandbox、permission、telemetry 等高风险路径变更
- user-visible behavior change

docs-only、tests-only、纯内部重构默认豁免；如果 PR description 声称改变用户行为，则不豁免。

### 检查内容

Feature PR 应包含：

- exact commands、prompts、inputs 或 reviewer 可复现步骤
- expected result 和 observed result
- quickest reviewer verification path
- 对 user-visible / TUI / workflow 变化，尽量包含 before/after、截图、GIF、视频、日志或 JSON trace
- 未覆盖 / 未验证范围说明

默认策略是：普通 feature 缺少证据时输出 `ADVISORY_ONLY`；高风险 feature 缺少证据时输出 `BLOCK`；如果 `.qwen/review-rules.md` 配置 `validation-gate: blocking`，则按 blocking 执行。

## 反馈循环与 Override

Design Gate 的 BLOCK 不能让 PR 永远卡死。author 和 maintainer 都需要明确的 unblock 通道。

### Author Unblock 流程

| Author 动作                                  | 触发的 stage                              | 行为                                                              |
| -------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| push 新 commit                               | `pull_request_target.synchronize`         | 全 pipeline 重跑（Stage 0→3），cache 命中走增量                    |
| 编辑 PR description（解释为何这次方案不同） | `pull_request_target.edited`（新增触发）    | 只重跑 Stage 0→2（Design Gate），不调用 `/review`                  |
| 评论 `@qwen /design-gate`（新增 slash 命令） | `issue_comment` / `pull_request_review_comment` | 只重跑 Stage 0→2（Design Gate），不调用 `/review`              |
| 评论 `@qwen /review`                         | `issue_comment` 等                        | 全 pipeline 重跑（Stage 0→3），按 §触发与权限 强制重跑               |

新增 `pull_request_target.edited` 触发 + `@qwen /design-gate` slash 命令的目的：让 author 改完 PR description 解释决策依据后，能不 push commit 就重跑 gate；避免每次 unblock 都触发 deep review 的 5-30 分钟成本。

`edited` 事件的过滤要在 workflow `if:` 加上 `github.event.changes.body != null` 之类条件，避免 PR title / label 等无关编辑也触发 gate 重跑。

### Maintainer Override

Design Gate BLOCK 后，maintainer 可能判定 cite 的历史决策不适用当前 case（情境变化、新约束、误命中）。明确 override 通道：

| 触发                                                       | 权限要求                          | 行为                                                                                  |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| 评论 `@qwen /review --override-design-gate <reason>`       | OWNER 或 MEMBER（不含 COLLABORATOR）| 跳过 Stage 2 直接进 Stage 3；override + reason 写入 step summary 和 PR comment 留 audit trail |

约束：

- COLLABORATOR 无 override 权限，避免外部贡献者绕过方向 gate。
- override 必须带 `<reason>` 文本（≥10 字符），workflow 校验缺失时拒绝执行并提示格式。
- override 单 PR 单 commit 一次有效；新 commit push 后 gate 重新跑，需要重新 override 才能再跳过。这避免 "一次 override 永远绕过" 的滥用。
- override 评论 + 原 BLOCK 的 cite 在 PR summary 里并排展示，方便后续审计。
- override 决策应进 telemetry，长期跟踪误报率和 override 滥用倾向。

### 不引入的逃生通道

- 不支持 `--skip-history-scan` / `--skip-claude-code` 等子检查粒度的 override：粒度太细容易被滥用。
- 不在 author 端引入 override：author 只能改 PR description 解释，不能直接跳过 gate；override 必须由 maintainer 决定。
- 不引入 "BLOCK 后自动 timeout 转 advisory"：方向问题不应靠时间消化，要靠人或证据决定。

## 历史 PR/Issue 感知

Design Gate 在 4 组检查之外，并行跑 4 类历史检测。这是本设计**最高 ROI** 的部分 —— 直接攻击"历史决策遗忘"问题。

### 4 类历史检测

| 类型                          | 检查问题                                                       | 数据源                                                                                    | 命中后输出                                                                                       |
| ----------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **(a) 同一 issue 曾被解决过** | "本 PR 想修的问题，过去 issue 是否已关闭/标 completed？"       | `gh search issues --state closed --repo ...` + linked PR                                  | "Issue #X 已在 PR #Y 修复（{merged_at}），请确认改动是否重复 / 是否是回归" — advisory            |
| **(b) 已有 PR 实现过**        | "本 PR 改的代码区域，历史是否有 PR 合并过类似改动？"           | `gh search prs --state merged --repo ...` + 改动文件重叠分析                              | "PR #Y 已经修改过同一区域（{filename}），本 PR 是延续还是覆盖？" — advisory                      |
| **(c) by design 拒过**        | "类似 PR 是否被 maintainer 主动关闭过？"                       | `gh search prs "<keywords> is:unmerged" --state closed --repo ...` + 读 close 评论 / wontfix 标签 | "PR #Z 因 {close_reason} 被关闭（cite 链接），本 PR description 没解释为何这次方案不同" — **VIOLATION** |
| **(d) 历史"坏"PR 信号**       | "本 PR 改的区域，过去合过的 PR 是否后来出过问题？"             | merged PR → revert PR / 标题含 "regression from #N" / linked issue                       | "PR #W 合并后引发了 issue/revert（{evidence}），本 PR 改动相似，注意 {具体陷阱}" — advisory      |

### 实证：PR #3863 闭环案例

> tanzhenxin 在 #3863 close 评论里写明："Direction: We've decided not to ship `/model list` as a feature. The space of OpenAI-compatible providers is too fragmented…"
>
> 这一类 close 评论是 (c) 类检测的标准输入。如果后续有人提"加另一种 OpenAI-compat 兼容 provider 的 `/model list` 变种"，Design Gate 应能从 `gh search prs "model list is:unmerged" --state closed --repo QwenLM/qwen-code` 命中 #3863，cite 这段 direction 评论，标 VIOLATION，要求作者在 PR description 显式解释为何这次不同。

### 实证：PR #3627 闭环案例

> tanzhenxin 在 #3627 close 评论里写明："Two installation paths are worse than one even when both work… I'd rather not carry it. The more interesting follow-up after #3776 is a proper Qwen Code.app bundle (signed, notarized, ships the runtime, doesn't shell out to Terminal)…"
>
> 后续如果有人再交"另一个 desktop launcher 方案"，Design Gate 应能从 (c) 检测命中 #3627，提示作者参考 #3776 + #3627 close 评论中提到的"signed/notarized 完整 app bundle"方向。

### 检测频率与缓存

历史检测每次 review 都跑，搜索 query 由 PR title + 主要 file 路径生成。搜索结果不缓存（PR 历史在持续变化），但不同类型使用不同窗口：

- (a)(b)(d) 默认查最近 180 天 + 最近 200 个结果，控制噪声和成本。
- (c) by-design 拒绝不设 30 天窗口；这类决策的价值恰恰在于长期记忆。第一版用 `is:unmerged` + 关键词 + `--limit 200` 做全历史搜索，后续如果噪声过大，再生成一个轻量的 maintainer decision index。

## 增量评审与缓存

### Bundled skill 已有机制

`packages/core/src/skills/bundled/review/SKILL.md` Step 1 已经实现了 incremental review 逻辑：

- worktree 创建后写入 `.qwen/review-cache/pr-<n>.json`，记 `lastCommitSha` 和 `lastModelId`
- 下次跑同一 PR：
  - SHA 相同 + model 相同 + 无 `--comment` flag → "No new changes since last review"，cleanup 退出
  - SHA 相同 + model 不同 → 跑全量评（second opinion）
  - SHA 不同 → 跑 `git diff <lastCommitSha>..HEAD` 增量评审
- cache 缺失或 rebase 把 cached SHA 推没了 → fallback 全量评 + warning

### 缺失的 wiring

`.qwen/review-cache/` 当前**没有跨 GitHub Actions run 持久化**。每次 runner 都是干净的，cache 文件不存在 → 上述机制永远走 fallback 全量评分支。

### Workflow 层增量

在 review 步骤前后加 `actions/cache/restore` 和 `actions/cache/save`。关键点：

- cache key 必须同时包含 PR base SHA 和 head SHA（`gh pr view --json baseRefOid,headRefOid`），不能使用 `github.sha`。在 `pull_request_target` 和 comment 事件里，`github.sha` 不是稳定的 PR head commit。
- 只有 `pull_request_target.synchronize` 在 review 前 restore cache，让 bundled skill 走增量路径。
- `opened` / `reopened` / `ready_for_review` 仍跑全量评审，但成功后 save 当前 head cache，供后续 `synchronize` 使用。
- comment / review comment / `workflow_dispatch` 默认不 restore cache，避免同 SHA 手动复核被 bundled skill 的 no-change short-circuit 跳过。

```yaml
- name: Restore previous review cache
  if: github.event_name == 'pull_request_target' && github.event.action == 'synchronize'
  uses: actions/cache/restore@v4
  with:
    path: .qwen/review-cache
    key: qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.base_sha }}-${{ steps.size.outputs.head_sha }}
    restore-keys: |
      qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.base_sha }}-

- name: Save review cache
  if: github.event_name == 'pull_request_target' && steps.review.outcome == 'success'
  uses: actions/cache/save@v4
  with:
    path: .qwen/review-cache
    key: qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.base_sha }}-${{ steps.size.outputs.head_sha }}
```

base SHA 必须进 cache key 和 restore-keys 前缀。否则 PR 作者点 "Update branch from base" 把上游 main merge 进 PR 分支后（或者 PR 的 base 被 retarget 到另一个分支），head SHA 变了但 restore-keys 仅靠 `qwen-review-<pr#>-` 仍能匹配上一次的 cache，bundled skill 把旧的 `lastCommitSha` 当 incremental 起点 → `git diff <oldHead>..<newHead>` 会包含上游 main 的 commits，而这些 commits 不是 PR 作者写的。把 base SHA 编进 key，base 一变就让 prefix 失效，强制走 full review。

`restore-keys` prefix match（含 base_sha）保证：同一 PR + 同一 base 下，即使精确 head SHA 没命中，也能 restore 最近一次 review 的 cache，让 bundled skill 走增量路径。base 变了就自动 fallback。save 侧如果发现同 key 已存在，应跳过或把 "cache already exists" 当作 benign outcome。

### 路径冲突注意

bundled skill 在 worktree 里跑（`.qwen/tmp/review-pr-<n>/`），cache 文件实际写在**主项目目录** `.qwen/review-cache/pr-<n>.json`（SKILL.md Step 1 明确这点）。`actions/cache` 的 `path` 应该指主项目目录，不是 worktree 内目录。

## 评论与身份

### 当前状态

所有 review 评论作者是 `github-actions[bot]`，跟覆盖率 bot、其他 CI bot 在视觉上无区分。`.github/workflows/qwen-code-pr-review.yml` 用默认 `GITHUB_TOKEN`，没引用 `APP_ID` / `APP_PRIVATE_KEY`。

### GitHub App 集成预案

`QwenLM/qwen-code-action` 仓库 `examples/github-app/custom_app_manifest.yml` 已提供 manifest 模板，dispatch workflow 也有 `actions/create-github-app-token` 的标准接入示范（带 `if: ${{ vars.APP_ID }}` 兜底，secret 没设时回落到 `GITHUB_TOKEN`）。

集成步骤：

1. **创建 App**：QwenLM org owner 在 `https://github.com/organizations/QwenLM/settings/apps/new` 用 manifest 创建（推荐名 `qwen-code-review`）。collaborator 无权限做这步，**需要 org owner 操作**。
2. **配置 secrets**：repo `vars.APP_ID` 和 `secrets.APP_PRIVATE_KEY` 写入。
3. **安装到 repo**：org owner 把 App 安装到 `QwenLM/qwen-code` 仓库。
4. **改 workflow**：在 review job 前加一个 `actions/create-github-app-token` step（带 `if: ${{ vars.APP_ID }}` 条件），把 mint 出的 token 作为后续 `gh api` 调用和 review 步骤的 `GITHUB_TOKEN`。

### 临时替代

短期内拿不到 org owner 操作的话，可以在 yiliang114 个人账号下建一个 App（命名如 `yiliang-qwen-review`）做 staging 测试 workflow 改造可行性。但官方上线必须走 org App。

## 数据来源 / 配置位置

| 资产                                | 位置                                                          | 用途                                           |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Review workflow 定义                | `.github/workflows/qwen-code-pr-review.yml`                   | 触发条件、PR 解析、gate、调用 action          |
| 项目级 review 规则                  | `.qwen/review-rules.md`                                       | gate 默认值、reviewer 行为约束                |
| Bundled review skill                | `packages/core/src/skills/bundled/review/SKILL.md`            | 9 agent + reverse audit + 增量评审            |
| Skill 辅助命令                      | `packages/cli/src/commands/review/*`                          | fetch-pr / pr-context / load-rules / 等       |
| 架构 anchor                         | `docs/developers/architecture.md`                             | Design Gate 架构合规子检查                    |
| Roadmap anchor                      | `docs/developers/roadmap.md`                                  | Design Gate roadmap 对齐子检查                |
| 既有 feature design anchor          | `docs/design/<feature>/*.md`                                  | Design Gate 重复检测                          |
| 历史 closed-unmerged PR             | `gh search prs "<keywords> is:unmerged" --state closed --repo ...` | (c) by design 拒过检测                        |
| 历史 merged PR + revert 关系        | `gh search prs --state merged` + revert 标题 grep             | (d) 历史"坏"PR 信号                           |
| Cross-run cache                     | `actions/cache` key=`qwen-review-<pr#>-<baseRefOid>-<headRefOid>` | 增量评审持久化                                |
| App credentials                     | `vars.APP_ID` + `secrets.APP_PRIVATE_KEY`                     | 评审主体身份                                  |
| Model 配置                          | `vars.QWEN_PR_REVIEW_MODEL`                                   | 选择评审用模型                                |
| 模型 endpoint / key                 | `secrets.REVIEW_OPENAI_BASE_URL` + `secrets.REVIEW_OPENAI_API_KEY` | 走百炼或其他兼容 endpoint                |

## Bundled Skill 更新要点

本设计不要求 Phase 2 修改 bundled skill。Phase 4/5 应优先新增 workflow preflight helper，而不是修改 bundled `/review` 的 9-agent 核心。Phase 6 如果要在 `/review` 内做 finding 抑制，再修改 `packages/core/src/skills/bundled/review/SKILL.md`。

### Review profile 范围

当前阶段不引入正式 `normal/deep` profile。workflow 在 gate 通过后继续调用现有 bundled `/review`。`normal/deep` profile 作为后续优化单独设计：

- `normal`：自动触发默认的低成本实现层 review。
- `deep`：maintainer 手动触发或高风险 PR 自动升级，运行完整多 agent / reverse audit。

本设计只把方向、scope、history、validation 前置为 preflight，不改变 bundled `/review` 的 review 深度。

### 1. Review intent 参数

当前 skill 只解析 `--comment`。需要新增一个不发 PR review 的强制执行语义，例如 `--force`：

- `--comment`：保持现有行为，允许发 Create Review API 评论 / approve。
- `--force`：即使 `lastCommitSha` 与当前 head 相同也继续执行 review，用于 maintainer 手动复核和 workflow_dispatch。
- `--incremental`（可选）：只在手动触发时显式要求使用 cache 增量范围；不要让 cache 命中隐式改变评论触发语义。

同 SHA + 同 model 的 short-circuit 应改成：

- 无 `--comment`、无 `--force`、无 `--incremental` → 可以 "No new changes" 退出。
- 有 `--force` → 全量复核，但可读取 findings cache 做轮次抑制。
- 有 `--comment` → 维持现有"运行 review 以发评论"行为。

### 2. Design / History 输入（workflow preflight）

Design Gate 不应该只靠完整 diff 或文件路径猜方向。workflow 应在调用 `/review` 前准备两个轻量输入：

- PR shape 摘要：changed paths、package 边界、import/export 变化、公共 CLI/SDK/API 入口变化。
- history scan 摘要：`gh search prs/issues` 结果、maintainer close 评论、linked issue / revert 证据。

这两个输入都应当作为 DATA 传给 Design Gate。方向类 finding 必须 cite roadmap、architecture、design 文档或历史 PR 评论；没有 anchor 的方向判断只能降级为 advisory 或不发。Design Gate 通过后，workflow 可以把 advisory 摘要附加到 `/review` prompt，但不要把 blocking direction 判断留给 `/review` 内部完成。

### 3. Cache schema 扩展

当前 cache 只保存 `lastCommitSha`、`lastModelId`、`findingsCount`、`verdict`。Phase 6 需要扩展为可抑制 finding 的 schema：

```json
{
  "lastCommitSha": "<sha>",
  "lastModelId": "<model>",
  "lastReviewDate": "<ISO timestamp>",
  "verdict": "<verdict>",
  "findings": [
    {
      "file": "packages/example/src/file.ts",
      "line": 42,
      "severity": "Suggestion",
      "source": "[review]",
      "hash": "<normalized issue + suggested fix hash>",
      "firstSeenSha": "<sha>",
      "lastSeenSha": "<sha>"
    }
  ]
}
```

抑制规则第一版保持保守：只抑制第 2 轮起同 file + line + hash 的 `Suggestion`；`Critical` 永不抑制；low-confidence / `Nice to have` 仍不发 PR 评论。

## Testing Strategy

GitHub Actions 的权限、cache、`pull_request_target` 默认分支语义无法被本地完整模拟。测试分四层：

1. **本地静态检查（必须）**
   - `actionlint .github/workflows/qwen-code-pr-review.yml`
   - `shellcheck .qwen/scripts/pr-review/*.sh`（如果 helper 使用 shell）
   - `git diff --check`
2. **本地 helper fixtures（必须）**
   - 为 `opened`、`synchronize`、`issue_comment`、`workflow_dispatch`、fork PR 准备 `GITHUB_EVENT_PATH` fixtures。
   - 直接运行 `qwen review design-gate` / helper 脚本，验证 PR number、head SHA、gate status、process comment body 和 exit behavior。
3. **本地 container smoke（可选）**
   - 使用 `act + Colima` 验证 YAML glue、环境变量、路径和 shell 步骤。
   - 不把 `act` 结果视为 `pull_request_target`、Actions cache、token 权限的最终验收。
4. **真实 GitHub staging（必须）**
   - workflow 文件已在 default branch 存在时，用 `gh workflow run ... --ref <branch>` 跑 dry-run。
   - 新增 `pull_request_target.synchronize` / cache 行为必须在 staging repo 或 default-branch skeleton 上验证，确认第二次 push 能 restore cache 并进入 incremental review。

## 风险与开放问题

### R1. Design Gate 的 framing 错误风险

gate 先要识别"本 PR 在加什么概念能力"，再去对照 anchor。第一步是认知任务，模型可能把"OS 抽象塞 CLI"误 frame 成"加了个 isolation feature"。

**缓解**：prompt 要求 Design Gate 输出第一句必须是 "This PR introduces the capability of <one-sentence summary>"，把识别和对照拆成两步。后续可以加一个独立的 "framing-validation" sub-agent 复核。

### R2. 历史检测的搜索精度

`gh search prs "<keyword>"` 召回率和精度都不稳定。漏召回会让 (c) VIOLATION 没拦住；过召回会让作者收到一堆无关历史 PR 提示，noise。

**缓解**：(a)(b)(d) 先限定最近 180 天 + 最近 200 个结果，keyword 必须从 PR title 和主要 file 路径联合提取；(c) by-design 拒绝不加短时间窗，只用 `is:unmerged` + 更窄关键词控制噪声。后续可以用 embedding 召回或 maintainer decision index 替代关键词搜索，但实现复杂度高，先不做。

### R3. Claude Code 对标的 advisory 边界

WebFetch `docs.claude.com` 可能因为速率限制或内容变动失败。失败时不能把 advisory 升级成 VIOLATION，要明确"对标信息暂不可用"。

**缓解**：Claude Code 对标整段 wrap 在 try-catch 里，失败 → 输出 "Claude Code comparison skipped: <reason>"，review 继续。

### R4. 增量 cache 在 rebase / force-push 下的 fallback

bundled skill 已经写了 "cached SHA 找不到就 fallback 全量"，但 `actions/cache` 的 `restore-keys` prefix match 可能 restore 一个对当前 head 已无意义的 cache。

**缓解**：cache key 使用 PR head SHA，且只在 `synchronize` restore。bundled skill Step 1 已经做了 SHA validity 检查（`git diff <lastCommitSha>..HEAD` 失败时 fallback），workflow 层不需额外处理。

### R5. App 注册阻塞期间的过渡方案

如果 org owner 一直拿不到时间注册 App，本设计 §Comments & Identity 描述的"yiliang 个人账号 staging App"是技术上可行的过渡，但发评论的 bot 名字会带个人色彩，对外部贡献者不友好。

**缓解**：在 App 注册前，workflow 不强制依赖 App token；继续用 `github-actions[bot]` 也能跑全部本设计描述的能力。App 是身份升级，不是功能阻塞。

### R6. 轮次抑制策略的精度

P3 提到"第 N+1 轮对 Suggestion 类同类型抑制"。但"同类型"如何机器判断？

**缓解**：第一版用粗粒度规则：对**整个 PR 同一文件同一行号**的 Suggestion 类 finding，第 2 轮起不再 raise。后续用 finding hash 做更精确的去重。实现时还要新增 `--force` 或等价 run-again 语义，让手动复核可以读取 cache 但不会因同 SHA 直接退出。

### R7. Bundled skill 与本仓库的版本耦合

bundled skill 在 `packages/core/src/skills/bundled/review/SKILL.md`，但 PR review workflow 用的是 npm 安装的 qwen-code（`qwen-code-action` 内部 `npm install qwen-code@latest`），跟仓库 source 不是同一份。改 bundled skill 必须等下一个版本 release 才生效。

**缓解**：Design Gate 和历史检测优先作为 workflow helper 实现，不依赖 bundled skill release。只有 `/review` 内部 finding 抑制、`--force` 等行为需要改 bundled skill，merge 后等下一次 minor release 才能上线。

## Follow-up & 实施路线

详见 `docs/design/code-review/roadmap.md`。
