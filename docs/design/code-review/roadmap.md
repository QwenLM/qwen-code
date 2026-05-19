# Code Review Roadmap

按"先 wiring 后 logic、先 workflow 后 skill、能小则小"的原则分阶段实施。Phase 1-3 当前在同一分支内完成，用于一次性补齐基础 workflow、增量 cache wiring 和设计 anchor；Phase 4 以后继续按独立 PR 推进。

## Phase 1：Bundled action 切换（当前分支）

**范围**：

- 把 PR review workflow 从外部 action 换成 `QwenLM/qwen-code-action@main`（调用 bundled review skill）
- 加 `.qwen/review-rules.md` 项目级规则
- 加 `--output-format json` / `--channel=CI` / size gate / cross-repo gate / fallback comment

**不在此 Phase**：

- Design Gate / Direction Gate（推后到 Phase 4）

**状态**：In review（当前分支）。

## Phase 2：增量评审 wiring（当前分支）

**范围**：

- 在 `qwen-code-pr-review.yml` 触发列表加入 `pull_request_target.synchronize`
- 在 PR context 解析里记录 `baseRefOid`、`headRefOid` 和 **merge base SHA**。merge base 通过 `gh api repos/<owner>/<repo>/compare/<base_sha>...<head_sha>` 的 `merge_base_commit.sha` 获取
- 在 review step 前后加 `actions/cache/restore` + `actions/cache/save`，path 指向主项目目录 `.qwen/review-cache/`
- cache key 用 `qwen-review-<pr#>-<merge_base_sha>-<head_sha>`，`restore-keys` 用 `qwen-review-<pr#>-<merge_base_sha>-` 前缀。**必须用 merge base 而非 baseRefOid**：base 没动但作者 Update branch 时 baseRefOid 不变，restore-keys 仍能 hit 旧 cache，bundled skill 会把 merge 引入的上游 commits 当成 PR 改动评审；merge base 在 Update branch / rebase / retarget 时会前移，正好匹配 cache 应该失效的边界
- 只有 `pull_request_target.synchronize` 在 review 前 restore cache；评论触发和 `workflow_dispatch` 默认强制重跑，避免同 SHA cache 命中后直接 "No new changes" 退出
- **Save cache 必须在 `Post review summary comment` 之后执行**，并依赖 `steps.post-summary.outcome == 'success'`。保存前用 `actions/cache/restore` 的 `lookup-only: true` 检查 exact key，避免 rerun `opened/reopened/ready_for_review` 时重复保存同一个 key。否则 `gh pr comment` 失败时 cache 推进会丢评论但保留"已评"状态，下次 synchronize 把 findings 弄丢
- 加本地 fixture 覆盖 `opened` / `synchronize` / comment / workflow_dispatch / "Update branch" 引起的 merge base 前移 / `gh pr comment` 失败导致 Save 跳过 等场景的 PR context 解析和 cache key 生成（后续 helper 化时补齐）

**不在此 Phase**：

- bundled skill 内部不动（已支持 incremental，无需改）
- 不引入 debounce（push 多了再说）
- 不改 bundled skill；如果未来需要手动增量评审，再单独加显式 `--incremental` / `--force` 语义

**依赖**：Phase 1。

**状态**：In review（当前分支）。

## Phase 3：Code Review 设计文档（当前分支）

**范围**：

- `docs/design/code-review/code-review-design.md`（主设计文档）
- `docs/design/code-review/roadmap.md`（本文件）
- `docs/design/code-review/compare.md`（对比表）

**目的**：

- 沉淀本设计供后续 PR 引用（"per docs/design/code-review/... Phase X，本 PR 实现 Y"）
- 让 maintainer 和外部贡献者理解 review 自动化的整体架构

**不在此 Phase**：

- 不动任何 workflow / skill / 代码

**依赖**：可与 Phase 2 并行，但建议先于 Phase 4-6 合入，作为后续 PR 的 anchor。

**状态**：In review（当前分支）。

## Phase 4：Design Gate preflight（独立 PR，workflow helper）

**范围**：

- 新增 `.github/scripts/design-gate.mjs` helper，输出稳定 JSON contract（`PASS / ADVISORY_ONLY / BLOCK`）。先用 repository-local script 调用已发布 CLI 的 `qwen --prompt` 能力，避免等待 qwen-code npm release；后续 release 后可迁回 `qwen review design-gate`
- 在 review workflow 里新增 Design Gate step，放在调用 bundled `/review` 之前
- 实现 4 组并行子检查（roadmap / architecture / 既有设计 / Claude Code 对标）
- 给 Design Gate 提供 PR shape 摘要（package 边界、import/export 变化、公共 CLI/SDK/API 入口变化），避免它只凭文件路径判断架构合规
- 调整 `.qwen/review-rules.md` 的 `Product Direction` gate 表述，要求 cite anchor
- 增加 Feature PR Readiness gate：feature / user-visible / bugfix / CLI/TUI / workflow / auth/model/sandbox 等高风险变更必须提供可复现 validation evidence
- Design Gate 输出 `PASS / ADVISORY_ONLY / BLOCK`；`BLOCK` 时 workflow 发 process comment 并停止，不调用 bundled `/review`

**不在此 PR**：

- 历史 PR 感知（拆出 Phase 5）
- 轮次抑制（拆出 Phase 6）
- 不把方向性判断作为第 10 个 agent 注入 bundled `/review`
- 不引入 `normal/deep` profile；继续调用现有 bundled `/review`

**依赖**：Phase 3 合入（design 文档作为 anchor 之一）。

**预估改动**：~120-180 行 helper/workflow，~20 行 review-rules.md，若干 fixture。

## Phase 5：历史 PR / Issue 感知（独立 PR，workflow helper）

**范围**：

- Design Gate 增加 4 类历史检测：
  - (a) 同一 issue 曾被解决过
  - (b) 已有 PR 实现过
  - (c) by design 拒过：高置信重复命中 → **VIOLATION**；domain 扩展召回先 advisory，避免把相关但不同的 PR 误拦
  - (d) 历史"坏"PR 信号
- 在 `.github/scripts/history-scan.mjs` / 相关 helper 中实现 `gh search prs/issues` 调用 + 评论 / linked issue 解析
- by-design 拒绝检测使用 `gh search prs "<keywords> is:unmerged" --state closed --repo ...`，不使用不存在的 `--is` flag；helper 传 `--repo` 时不要重复把 `repo:` qualifier 放进 query，避免 `is:unmerged` 召回为空

**不在此 PR**：

- 不引入 embedding 召回（关键词搜索够用，召回精度问题用更窄的 query 缓解）
- (c) by-design 拒绝不加 30 天时间窗，保留长期历史决策记忆；(a)(b)(d) 可先限制最近 180 天 + 最近 200 个结果

**依赖**：Phase 4 合入（Design Gate 作为载体）。

**预估改动**：~80 行 helper/subcommand 逻辑；第一版为 `.github/scripts/history-scan.mjs`，后续可迁移为 `qwen review history-scan` 供 Design Gate 复用。

## Phase 6：轮次抑制（独立 PR，需动上游 skill）

**范围**：

- bundled skill 在 review 完成时，把 confirmed findings 的 `(file, line, severity, hash)` 写入 `.qwen/review-cache/pr-<n>.json`
- 下次评审从 cache 读上次 findings，对**第 2 轮起**的 `Suggestion` 同 file 同 line 自动抑制
- `Critical` 永不抑制
- 增加显式 `--force`（或等价 run-again intent）：手动 `@qwen /review` 可以读取 cache 做 finding 抑制，但不会因为同 SHA + 同 model 直接 "No new changes" 退出

**不在此 PR**：

- 不做语义级去重（用 hash 粗粒度即可）

**依赖**：Phase 2 合入（cache 持久化）。Design Gate findings 可作为 preflight 输出，不要求进入 bundled `/review` cache。

**预估改动**：~50 行 SKILL.md。

## Phase 7：GitHub App 集成（独立 PR，需 org owner 配合）

**范围**：

- QwenLM org owner 创建 `qwen-code-review` App（用 manifest）
- repo 配 `vars.APP_ID` + `secrets.APP_PRIVATE_KEY`
- workflow 加 `actions/create-github-app-token` step，带 `if: ${{ vars.APP_ID }}` 兜底

**不在此 PR**：

- 不动 review 逻辑

**依赖**：org owner 操作。可与 Phase 2-6 并行。技术 ready 但行政阻塞。

**预估改动**：~15 行 workflow YAML + secrets 配置。

## 上线顺序总览

```
Phase 1-3 (current branch)  ─── merge
             │
             ├────────────► Phase 7 (App, async)
             │
             ▼
       Phase 4 (Design Gate preflight)
             │
             ▼
       Phase 5 (历史 PR 感知)
             │
             ▼
       Phase 6 (轮次抑制)
```

Phase 1-3 当前一起合入。Phase 7 可与 Phase 4-6 并行推进；Phase 4/5 必须串行，但不依赖 bundled skill release；Phase 6 需要改 bundled `/review`，依赖 release 节奏。

## 验收标准

每个 Phase 合入前的 acceptance：

- **P1**：现有 review 在 main 上跑成功，新 PR 触发 bundled action 评审，加了 `.qwen/review-rules.md` 后规则能被 bundled `/review` 加载并作为当前 workflow 的 review guidance 生效（用 dry-run 验证）
- **P2**：同一 PR 连续 push 两次，第二次评审从 cache restore，bundled skill 日志显示 "incremental review (last sha: ...)"；同一 SHA 下评论 `@qwen /review focus text` 仍会强制重跑，不出现 "No new changes since last review" 直接退出；点 "Update branch from base"（merge base 前移）后 cache 不被 prefix-match 命中，bundled skill 走 full review；模拟 `gh pr comment` 失败，下次 synchronize 重跑评审而不是 short-circuit（验证 Save 依赖 post-summary 成功）
- **P3**：合入后任何后续 PR 都能 cite `docs/design/code-review/*`
- **P4**：故意造一个"明显偏离 roadmap"的测试 PR，Design Gate 输出 BLOCK 并 cite roadmap 行号；workflow 不调用 bundled `/review`；缺少 validation evidence 的普通 feature 输出 ADVISORY_ONLY，高风险 feature 输出 BLOCK
- **P5**：故意造一个跟 PR #3863 同类的"加 OpenAI-compat provider /model list"测试 PR，(c) 检测命中 #3863 并输出 cite 链接
- **P6**：同一 PR 连跑两轮评审，第二轮某个 Suggestion 类 finding 被自动抑制；同一 SHA 下手动 `@qwen /review` 仍会实际执行并应用抑制规则
- **P7**：评审评论作者从 `github-actions[bot]` 变为 `qwen-code-review[bot]`

## 测试要求

- 每个 workflow/helper PR 必须跑 `actionlint`、`shellcheck`（如有 shell helper）、`git diff --check`。
- helper 逻辑必须有本地 fixtures 覆盖 PR 事件解析、Design Gate 输出、BLOCK/ADVISORY_ONLY 分支。
- `act + Colima` 可作为 smoke，但不作为最终验收。
- 真实集成至少通过 `workflow_dispatch --ref` dry-run；`pull_request_target.synchronize` 和 cache restore 行为需要 staging/default-branch skeleton 验证。
