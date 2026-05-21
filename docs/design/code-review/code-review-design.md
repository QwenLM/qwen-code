# Code Review 自动化设计（Phase 1-3）

> 本文档只覆盖本 PR 实际交付的 **Phase 1-3**（bundled action 切换、增量评审 cache wiring、本设计文档）。
> Design Gate / 历史 PR 感知 / Feature Readiness / Override / 轮次抑制 / GitHub App 等属于 Phase 4-7，
> 设计与实现随对应 PR 一起提交，后续阶段的路线在本 PR 描述中说明。

## 问题陈述

仓库当前的 AI PR review 跑在 `.github/workflows/qwen-code-pr-review.yml` 上，调用上游 `QwenLM/qwen-code-action` 触发 bundled review skill（`packages/core/src/skills/bundled/review/SKILL.md`）。bundled skill 本身已经做了 9 个并行 review agent、确定性 lint/typecheck、跨文件影响分析、批量 verification、迭代 reverse audit、模式聚合等工作，单次评审质量已经足够。

实际运行暴露三类持续问题，单靠 bundled skill 内部优化解决不了：

1. **不收敛**：作者 push 新 commit 不会自动触发评审；手动 `@qwen /review` 每次都是全量重评，第一轮讨论过的小问题反复在后续轮次被 raise。bundled skill 有 `.qwen/review-cache/pr-<n>.json` 做增量评审，但 GitHub Actions 每次都是全新 runner，cache 在 run 之间丢失，机制从未生效。
2. **方向偏差**：`review-rules.md` 的 `Product Direction` gate 只是抽象规则，模型靠常识填空，碰到 framing 巧妙的方向漂移会站在作者一边。
3. **历史决策遗忘**：仓库已有大量"by design 拒过"的 PR，AI review 不感知这些历史决策，新作者重复踩坑。

**本 PR（Phase 1-3）只解决问题 1 的基础设施部分**：把 review workflow 切到 bundled action、补齐跨 run 增量 cache wiring、并把整体设计沉淀成文档供后续阶段引用。问题 2、3 由 Phase 4（Design Gate）、Phase 5（历史感知）解决，不在本 PR 范围。

## 现状对比（仅 Phase 1-3 关心的维度）

| 维度                         | 改造前                         | 本 PR 后                   |
| ---------------------------- | ------------------------------ | -------------------------- |
| PR 打开 / reopened 自动评审  | ✅                             | ✅                         |
| `@qwen /review` 评论触发     | ✅                             | ✅                         |
| 作者 push 新 commit 自动评审 | ❌ 未监听 `synchronize`        | ✅ 新增 synchronize 触发   |
| 增量评审（只评新 commit）    | ⚠️ skill 内置但 cache 不持久   | ✅ 跨 run cache 持久化     |
| PR 体积 gate                 | ⚠️                             | ✅ 1500 行可配             |
| 项目级 review 规则文件       | ❌                             | ✅ `.qwen/review-rules.md` |
| 9-agent 深审 / reverse audit | ✅（bundled skill 内置，不动） | ✅                         |

> bundled skill 的 9-agent / 确定性 lint / reverse audit 等能力本设计不改动，详见 `packages/core/src/skills/bundled/review/SKILL.md`。

## 设计原则

**P1. review 工具无状态，状态在外部控制流。**
bundled `/review` skill 跑完一次就退出，不维护跨 run 状态。所有跨 run 状态（cache 等）由 workflow 层用 `actions/cache` / GitHub API 维护。skill 不变，可独立测试、可被任何 channel 调用。**这是 Phase 1-3 的核心原则。**

**P5. 优先复用现有 design 文档，不写新"团队红线"清单。**
仓库已有 `docs/developers/roadmap.md` / `docs/developers/architecture.md` / `docs/design/*` / 历史 closed-unmerged PR 评论。这些是真实的"团队方向"记录，比新写 `anti-features.md` 更准、更有 cite 价值。Phase 4+ 的 anchor 全部复用它们。

> P2（每条判断必须 cite anchor）、P3（按轮次抑制非 critical）、P4（方向判断不进 `/review` deep 流程）属于 Phase 4-6，本 PR 不实现，详见 roadmap。

## 定位：advisory，不是 merge gate

本 workflow 输出的 AI review 是 **informational only**。它**不应**被加入 Branch Protection 的 required status checks，原因：

- LLM 抽风（超时 / 限流 / 偶发 garbage 输出）不应阻断合并
- 模型判断结果对 maintainer 是建议，最终决策仍在人
- 实测数据（详见 [`preflight-triage.md`](./preflight-triage.md) §问题陈述）显示 AI review 长尾耗时不可预测，把它当门禁会让 PR 流卡顿

**合并门禁**由独立的 `pr-gate.yml` workflow 负责（title 格式 / body 必填段 / size 上限），设计见 [`../pr-gate-plan.md`](../pr-gate-plan.md)。两条线正交，可并行推进。

## 触发与权限

### 触发事件

| 事件                                                                                       | 行为                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `pull_request_target.opened / reopened / ready_for_review`                                 | 自动跑全量评审                                                     |
| `pull_request_target.synchronize`                                                          | **新增**：作者 push 时自动跑**增量评审**（依赖 cache）             |
| `issue_comment` / `pull_request_review_comment` / `pull_request_review` 含 `@qwen /review` | 评论触发，默认**强制重跑**，不因同 SHA cache 命中短路              |
| `workflow_dispatch`                                                                        | 手动触发，可选 dry-run / comment 模式 + 自定义 focus，默认强制重跑 |

### 权限与 fork 处理

- 所有触发都要求 actor 是 `OWNER / MEMBER / COLLABORATOR`，在 workflow `if:` 表达式实现。**这是当前阶段有意保留的安全闸**：本 workflow 在 `pull_request_target` 下带 secrets 运行且深审耗时长，开放触发等于 denial-of-wallet / 滥用面。外部贡献者的 PR 当前仍可评审 —— 由 maintainer 在 PR 下评论 `@qwen /review`。面向社区 PR 的更宽自动触发（配合按作者限流）推后到后续 Phase，本 PR 暂不放开。
- **不设跨仓 (fork) 拒评 gate**：fork PR 同样进入评审流程。安全边界由 `pull_request_target` 的检出策略保证 —— 自动触发时 workflow 检出可信的 base（`main`）代码、不检出 PR head；只有 maintainer 手动 `workflow_dispatch` 才检出被 dispatch 的 ref。
- fork PR 的 merge-base 可能无法由 compare 端点解析；该计算是**尽力而为、非致命**：解析失败只是这一轮无法增量、退回全量评审，不阻塞、不报错。

### 触发频率策略

`synchronize` 不做 debounce：每次 push 都触发，由 cache 保证后续运行只评增量、token 成本可控。push 过频出现 CI 拥塞时，靠已有的 `concurrency` cancel-in-progress 兜底。

评论触发和 `workflow_dispatch` **默认不 restore cache**：maintainer 可能在同一 commit 上追加新的 review focus，若 restored cache 的 `lastCommitSha` 与当前 head 一致，bundled skill 会按 "No new changes since last review" 直接退出，导致手动复核没真正执行。

## Workflow Review Pipeline（Phase 1-3 形态）

| Stage | 触发动作                                                                | 成本                                                             | 失败处理                                              |
| ----- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | GitHub `if:`（event type / author_association / `@qwen /review`）       | 0                                                                | 静默不跑                                              |
| 1     | workflow shell step（env / model 配置校验、PR size gate、PR 元数据）    | <5s                                                              | post process comment（"PR too large" / 配置缺失）     |
| 2     | bundled `/review` deep review（9-agent + reverse audit + verification） | 增量 ~5-15 min；全量可达 ~45-60 min（job `timeout-minutes: 60`） | post inline + summary review comment；失败发 fallback |

> Phase 4 会在 Stage 1 与 Stage 2 之间插入一个独立的 Design Gate step；本 PR 不含该 step，Stage 1 通过即直接进 bundled `/review`。

## 增量评审与缓存（Phase 2 核心）

### Bundled skill 已有机制

`packages/core/src/skills/bundled/review/SKILL.md` Step 1 已实现 incremental review：

- worktree 创建后写 `.qwen/review-cache/pr-<n>.json`，记 `lastCommitSha`、`lastModelId`
- 再跑同一 PR：SHA 相同 + model 相同 + 无 `--comment` → "No new changes"，退出；SHA 不同 → 跑 `git diff <lastCommitSha>..HEAD` 增量评审；cache 缺失或 rebase 把 cached SHA 推没 → fallback 全量评 + warning

### 缺失的 wiring（本 PR 补齐）

`.qwen/review-cache/` 当前**没有跨 GitHub Actions run 持久化**，每次 runner 都是干净的，机制永远走 fallback 全量评分支。本 PR 在 review 步骤前后加 `actions/cache/restore` / `actions/cache/save`：

- cache key 必须同时含 PR **merge base** 和 head SHA，不能用 `github.sha`，也不要用 baseRefOid。merge base 通过 `gh api repos/<owner>/<repo>/compare/<base>...<head>` 的 `merge_base_commit.sha` 获取。
- merge-base 计算**尽力而为**：fork SHA 解析失败不 `exit 1`，退回全量评审 + warning。
- 只有 `pull_request_target.synchronize` 在 review 前 restore cache 走增量；`opened/reopened/ready_for_review` 跑全量但成功后 save；comment / `workflow_dispatch` 默认不 restore。
- save 必须在 PR review summary comment **发出之后**才执行，保存前用 `actions/cache/restore` 的 `lookup-only: true` 检查 exact key 是否已存在。

```yaml
- name: Restore previous review cache
  if: github.event_name == 'pull_request_target' && github.event.action == 'synchronize'
  uses: actions/cache/restore@v4
  with:
    path: .qwen/review-cache
    key: qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.merge_base_sha }}-${{ steps.size.outputs.head_sha }}
    restore-keys: |
      qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.merge_base_sha }}-

# ... Run Qwen Code Review → Post review summary comment ...

- name: Check review cache key
  id: cache-lookup
  if: steps.post-summary.outcome == 'success'
  uses: actions/cache/restore@v4
  with: { path: .qwen/review-cache, key: qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.merge_base_sha }}-${{ steps.size.outputs.head_sha }}, lookup-only: true }

- name: Save review cache
  if: |
    github.event_name == 'pull_request_target' &&
    steps.review.outcome == 'success' &&
    steps.post-summary.outcome == 'success' &&
    steps.cache-lookup.outputs.cache-hit != 'true'
  uses: actions/cache/save@v4
  with: { path: .qwen/review-cache, key: qwen-review-${{ steps.pr.outputs.number }}-${{ steps.size.outputs.merge_base_sha }}-${{ steps.size.outputs.head_sha }} }
```

**为什么用 merge base 而非 baseRefOid**：merge base 是 PR 历史从 base 分叉的点，在 `Update branch from base` / `rebase` 到更新 base / PR retarget 时会前移 —— 这些恰是 cache 必须失效、必须走 full review 的边界。baseRefOid（base 当前 HEAD）做不到：base 没动但作者 Update branch 时 baseRefOid 不变，restore-keys 仍能 hit 旧 cache，bundled skill 用旧 `lastCommitSha` diff 新 head 会把 merge 引入的上游 commits 一起评。

**为什么 Save 必须在 publication 之后**：bundled `/review` step 成功只代表模型出了 summary，不代表 `gh pr comment` 真发出去了（可能 rate-limit / 网络 / PR 关闭失败）。若 Save 在发评论之前，cache 推进 → 下次 synchronize → bundled skill 看到 `lastCommitSha == HEAD` 就 "No new changes" 退出，那轮 findings 永远到不了 PR。Save 必须依赖 `post-summary.outcome == 'success'`。

### 路径冲突注意

bundled skill 在 worktree（`.qwen/tmp/review-pr-<n>/`）里跑，cache 文件实际写在**主项目目录** `.qwen/review-cache/pr-<n>.json`。`actions/cache` 的 `path` 指主项目目录，不是 worktree 内目录。

## 评审身份

所有 review 评论作者目前是 `github-actions[bot]`。独立 `qwen-code-review[bot]` 身份需要 org owner 注册 GitHub App，属 Phase 7，本 PR 不动；继续用默认 `GITHUB_TOKEN` 即可跑通本 PR 描述的全部能力。

## 配置位置

| 资产                 | 位置                                                                | 用途                                |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Review workflow      | `.github/workflows/qwen-code-pr-review.yml`                         | 触发、PR 解析、size gate、调 action |
| 项目级 review 规则   | `.qwen/review-rules.md`                                             | reviewer 行为约束                   |
| Bundled review skill | `packages/core/src/skills/bundled/review/SKILL.md`                  | 9-agent + 增量评审                  |
| Cross-run cache      | `actions/cache` key=`qwen-review-<pr#>-<merge_base_sha>-<head_sha>` | 增量评审持久化                      |
| Model 配置           | `vars.QWEN_PR_REVIEW_MODEL`                                         | 评审用模型                          |
| 模型 endpoint / key  | `secrets.REVIEW_OPENAI_BASE_URL` + `secrets.REVIEW_OPENAI_API_KEY`  | 兼容 endpoint                       |

## Testing Strategy

GitHub Actions 的权限、cache、`pull_request_target` 默认分支语义无法被本地完整模拟。Phase 1-3 测试分层：

1. **本地静态检查（必须）**：`actionlint .github/workflows/qwen-code-pr-review.yml`、`git diff --check`。
2. **本地 container smoke（可选）**：`act + Colima` 验证 YAML glue / 环境变量 / shell 步骤；不作为 `pull_request_target` / cache / token 权限的最终验收。
3. **真实 GitHub staging（必须）**：workflow 在 default branch 存在后，用 `gh workflow run ... --ref <branch>` 跑 dry-run；`synchronize` + cache 行为必须在 staging 或 default-branch skeleton 上验证 —— 第二次 push 能 restore cache 并进入 incremental review。

## 风险与开放问题（Phase 1-3 相关）

### R1. 增量 cache 在 rebase / force-push 下的 fallback

`actions/cache` 的 `restore-keys` prefix match 可能 restore 一个对当前 head 已无意义的 cache。

**缓解**：cache key 含 merge base + head SHA 且只在 `synchronize` restore；bundled skill Step 1 已做 SHA validity 检查（`git diff <lastCommitSha>..HEAD` 失败 → fallback 全量），workflow 层不需额外处理。

### R2. Bundled skill 与本仓库的版本耦合

PR review workflow 用的是 `qwen-code-action` 内部 `npm install qwen-code@latest`，跟仓库 source 不是同一份；改 bundled skill 必须等下一个 release 才生效。

**缓解**：Phase 1-3 不修改 bundled skill；只做 workflow 层 wiring。Phase 4/5 的逻辑也优先作为 workflow helper 实现，不依赖 bundled skill release。

## Follow-up & 实施路线

后续 Phase 4-7（Design Gate / 历史感知 / 轮次抑制 / GitHub App）每个 Phase 作为独立 PR 推进，范围、依赖、验收标准与设计细节随对应实现 PR 一起提交，不在本 PR 提前沉淀。
