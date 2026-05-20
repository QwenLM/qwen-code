# Code Review Roadmap

按"先 wiring 后 logic、先 workflow 后 skill、能小则小"的原则分阶段实施。**本 PR 只交付 Phase 1-3**；Phase 4 起每个阶段作为独立 PR 推进，设计细节随对应实现 PR 一起提交。

## Phase 1：Bundled action 切换（本 PR）

**范围**：

- 把 PR review workflow 从外部 action 换成 `QwenLM/qwen-code-action`（pin SHA，调用 bundled review skill）
- 加 `.qwen/review-rules.md` 项目级规则
- 加 `--output-format json` / `--channel=CI` / size gate / fallback comment
- `workflow_dispatch` 检出被 dispatch 的 ref（`pull_request_target` 仍锁 base），用于合并前 dry-run

**不在此 Phase**：Design Gate / Direction Gate（Phase 4）；**不设跨仓 fork 拒评 gate**（fork PR 同样评审，安全边界由 `pull_request_target` 的 base 检出策略保证）。

**状态**：本 PR。

## Phase 2：增量评审 wiring（本 PR）

**范围**：

- 触发列表加入 `pull_request_target.synchronize`
- PR context 解析记录 `baseRefOid`、`headRefOid` 和 **merge base SHA**（`gh api .../compare/<base>...<head>` 的 `merge_base_commit.sha`）；merge-base 计算尽力而为、非致命
- review step 前后加 `actions/cache/restore` + `actions/cache/save`，path 指向主项目目录 `.qwen/review-cache/`
- cache key `qwen-review-<pr#>-<merge_base_sha>-<head_sha>`，`restore-keys` 用 `qwen-review-<pr#>-<merge_base_sha>-` 前缀。**必须用 merge base 而非 baseRefOid**（理由见 `code-review-design.md`）
- 只有 `pull_request_target.synchronize` 在 review 前 restore cache；评论触发和 `workflow_dispatch` 默认强制重跑
- **Save cache 必须在 `Post review summary comment` 之后执行**，依赖 `steps.post-summary.outcome == 'success'`，保存前用 `lookup-only: true` 检查 exact key

**不在此 Phase**：bundled skill 内部不动（已支持 incremental）；不引入 debounce；不加 `--incremental` / `--force` 语义。

**依赖**：Phase 1。**状态**：本 PR。

## Phase 3：Code Review 设计文档（本 PR）

**范围**：`code-review-design.md`（Phase 1-3 主设计）、`roadmap.md`（本文件）、`compare.md`（对比表）。

**目的**：沉淀 Phase 1-3 设计；让 maintainer / 贡献者理解 review 自动化的基础架构与后续路线。Phase 4+ 的详细设计不在本 PR 提前沉淀，随对应 PR 提交。

**不在此 Phase**：不动任何 workflow / skill / 代码。

**依赖**：可与 Phase 2 并行。**状态**：本 PR。

---

## 后续阶段（独立 PR，设计随实现提交）

- **Phase 4 — Preflight Triage（tier 路由）**：在 bundled `/review` 之前加 preflight step，按 `{ULTRA_LIGHT, LIGHT, STANDARD, DEEP}` 四档路由；shell 层 hard rule 兜底；新增 `.qwen/review-rules.md` 的 `tier-floor:` token。详细设计见 [`preflight-triage.md`](./preflight-triage.md)。依赖 Phase 1-3 合入。
- **Phase 4.5 — Design Gate（方向 / scope / anchor cite）**：原 Phase 4 的方向类判定部分独立出来，新增 workflow helper 在 preflight 之后跑方向 / scope / 架构 / Claude Code 对标检查，输出 `PASS / ADVISORY_ONLY / BLOCK`；调整 `review-rules.md` 要求 cite anchor；加 Feature PR Readiness gate。依赖 Phase 4 合入。
- **Phase 5 — 历史 PR / Issue 感知**：Design Gate 增加 4 类历史检测（同 issue 解决过 / 已有 PR 实现过 / by-design 拒过 → VIOLATION / 历史"坏"PR 信号），`gh search prs/issues` 实现。依赖 Phase 4.5。
- **Phase 6 — 轮次抑制**：bundled skill 写 finding cache，对第 2 轮起的 `Suggestion` 同 file/line 抑制，`Critical` 永不抑制；加 `--force` 语义。需改上游 skill，依赖 release 节奏。
- **Phase 7 — GitHub App 集成**：org owner 创建 `qwen-code-review` App，workflow 加 `actions/create-github-app-token`（带 `if: vars.APP_ID` 兜底）。技术 ready，行政阻塞，可与 Phase 4-6 并行。

```
Phase 1-3 (本 PR) ── merge
        │
        ├──────────► Phase 7 (App, async)
        ▼
   Phase 4 ──► Phase 4.5 ──► Phase 5 ──► Phase 6
   (Preflight) (Design Gate)
```

Phase 4 是其他后续阶段的前置 wiring：Phase 4.5 在 preflight 之后接 Design Gate；Phase 5 把历史信号注入到 Design Gate；Phase 6 依赖 bundled skill release。

> **本拆分的实测理由**：原 Phase 4 把 tier 路由与方向类判定混在一起。实测发现 bundled `/review` 对 6 行 PR 跑 9-16 min、407 行直接 50 min timeout —— tier 路由的紧迫性远高于方向判定。故拆分先做 tier 路由（Phase 4），方向判定后置（Phase 4.5）。

## 验收标准（Phase 1-3）

- **P1**：workflow 合入 main 后，新 PR 触发 bundled action 评审；`.qwen/review-rules.md` 能被 bundled `/review` 加载并作为 review guidance 生效（dry-run 验证）。
- **P2**：同一 PR 连续 push 两次，第二次从 cache restore，bundled skill 日志显示 "incremental review (last sha: ...)"；同 SHA 下评论 `@qwen /review` 仍强制重跑；`Update branch from base`（merge base 前移）后 cache 不被 prefix-match 命中、走 full review；模拟 `gh pr comment` 失败，下次 synchronize 重跑而非 short-circuit。
- **P3**：合入后任何后续 PR 都能 cite `docs/design/code-review/*`。

Phase 4-7 的验收标准随对应 PR 提交。

## 测试要求（Phase 1-3）

- 必须：`actionlint .github/workflows/qwen-code-pr-review.yml`、`git diff --check`。
- `act + Colima` 可作为 smoke，不作为最终验收。
- 真实集成至少通过 `workflow_dispatch --ref` dry-run；`pull_request_target.synchronize` + cache restore 行为需要 staging / default-branch skeleton 验证。
