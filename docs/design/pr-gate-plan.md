# PR Gate 自动化编排方案

> 目标：为社区 PR 建立分层门禁体系，解耦快速合规检查与深度 AI review，确保每个 check 职责单一、失败信息清晰。
>
> **状态**：本设计已在本 PR（codex/preflight-triage 分支）落地。具体文件：
>
> - `.github/workflows/pr-gate.yml` — 两个独立 job (PR Template / PR Size)。PR Title (Conventional Commits) check 不做 —— 仓库已有本地 commit-msg hook 把住格式。
> - `.github/pull_request_template.md` — 仓库**已有**，结构与本 plan 兼容（`## Linked Issues / Bugs` 包含 `## Linked Issues` 子串），无需重写
> - `.github/workflows/qwen-code-pr-review.yml` — Phase B 已应用：size 超限记录 Large PR warning，但继续运行 AI review
> - Branch Protection / CODEOWNERS — 在 Settings 配，不在代码里，详见下面 §Phase D
>
> 配套的 AI review tier 路由设计见 [`code-review/preflight-triage.md`](./code-review/preflight-triage.md)。两条线本 PR 一起合入，可分开评审。

## 现状问题

| 问题                     | 具体表现                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| check 耦合               | size check 嵌在 `qwen-code-pr-review.yml` 内部，不是独立 status check；LLM 超时会连带 size 判断一起失败 |
| 缺 PR body 校验          | 有 PR template 但没有 CI 强制校验；社区 PR 可以空着 Validation section 直接提交                         |
| 无独立 CODEOWNERS        | 缺少自动 reviewer 分配                                                                                  |
| AI review 与合并阻断混淆 | qwen-code review 是辅助决策，不应作为 merge blocker，但目前没有明确区分                                 |

> **本来还有 "PR title 规范" 这一项**，最终判定**不在 CI 层做**：仓库已通过本地 commit-msg hook 强制 Conventional Commits 格式，CI 重复校验只是冗余。维护者合并时仍可手动校对 PR title（squash-merge 时它会成为 main 上的 commit message）。

## 设计原则

1. **快慢分离**：秒级门禁（body）/ 秒级 advisory signal（size）与分钟级检查（lint、test、AI review）拆成不同 workflow
2. **职责单一**：每个 job 产出一个 named status check，Branch Protection 按 name 引用
3. **失败可读**：社区贡献者看到具体哪项不过、怎么修，而不是笼统的 "review failed"
4. **AI review 不阻断**：qwen-code review 作为 informational check，提供建议但不 block merge
5. **渐进式**：先上无成本的 gate check，再逐步收紧
6. **不重复本地已有的 gate**：commit-msg hook 已经把 Conventional Commits 格式管住了 → CI 层不再重复 PR Title 校验

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  Branch Protection / Rulesets (repo Settings)                │
│                                                             │
│  Required status checks (必须全绿才能 Merge):                │
│    • "PR Template"     ← pr-gate.yml                        │
│    • "PR Size"         ← pr-gate.yml (warning-only signal)   │
│    • "Lint"            ← ci.yml                             │
│    • "Test (ubuntu-latest, Node 22.x)" ← ci.yml            │
│    • "CodeQL"          ← ci.yml                             │
│  (PR title 格式 — 不在 CI；本地 commit-msg hook 已强制)      │
│                                                             │
│  Non-required (informational):                               │
│    • "review-pr"       ← qwen-code-pr-review.yml            │
│                                                             │
│  Other rules:                                                │
│    • Required reviews: 1 (via CODEOWNERS)                    │
│    • Dismiss stale reviews on new push: yes                  │
│    • Require conversation resolution: yes                    │
│    • Require linear history: optional (recommend squash)     │
└─────────────────────────────────────────────────────────────┘
```

## 实施计划

### Phase A：新增 `pr-gate.yml`（独立轻量门禁）

新建 `.github/workflows/pr-gate.yml`，包含两个独立 job：

> ~~`Job 1: PR Title Check`~~ — **不做**。Conventional Commits 格式由仓库本地 commit-msg hook 强制，CI 层重复校验只是冗余。squash-merge 时 PR title 会成为 main 上的 commit message，维护者合并时手动确认即可。

#### Job 1: PR Template Validation

````yaml
pr-body:
  name: 'PR Template'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/github-script@v9
      with:
        script: |
          const body = context.payload.pull_request.body || '';
          const errors = [];

          // 必填 section 检查
          const requiredSections = [
            { marker: '## Summary', name: 'Summary' },
            { marker: '## Validation', name: 'Validation' },
            { marker: '## Linked Issues', name: 'Linked Issues' },  // 注意 substring 匹配，仓库现有模板里的 '## Linked Issues / Bugs' 也满足
          ];
          for (const s of requiredSections) {
            if (!body.includes(s.marker)) {
              errors.push(`缺少 "${s.name}" 部分`);
            }
          }

          // Validation section 不能只有模板占位符
          const validationIdx = body.indexOf('## Validation');
          if (validationIdx !== -1) {
            const scopeIdx = body.indexOf('## Scope', validationIdx);
            const validationContent = scopeIdx !== -1
              ? body.slice(validationIdx, scopeIdx)
              : body.slice(validationIdx);
            // 去掉 HTML 注释和空行后，检查是否有实质内容
            const stripped = validationContent
              .replace(/<!--[\s\S]*?-->/g, '')
              .replace(/## Validation/g, '')
              .replace(/- (Commands run|Prompts|Expected|Observed|Quickest|Evidence).*:/g, '')
              .replace(/```[\s\S]*?```/g, '')
              .trim();
            if (stripped.length < 20) {
              errors.push('Validation 部分内容过少，请提供实际的测试证据');
            }
          }

          if (errors.length > 0) {
            core.setFailed(
              `PR 描述不完整:\n${errors.map(e => '• ' + e).join('\n')}\n\n` +
              `请按照 PR 模板填写完整信息。`
            );
          }
````

**参考**：React 的 `shared_check_maintainer.yml` 对 PR metadata 做类似的程序化校验。

#### Job 2: PR Size Check

```yaml
pr-size:
  name: 'PR Size'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/github-script@v9
      with:
        script: |
          const { data: files } = await github.rest.pulls.listFiles({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.issue.number,
            per_page: 100
          });

          // 排除自动生成/lock 文件
          const ignorePatterns = [
            /package-lock\.json$/,
            /pnpm-lock\.yaml$/,
            /\.generated\./,
            /\.snap$/,
            /schemas\/.*\.schema\.json$/,
          ];
          const meaningful = files.filter(f =>
            !ignorePatterns.some(p => p.test(f.filename))
          );
          const totalChanges = meaningful.reduce((s, f) => s + f.changes, 0);
          const totalFiles = meaningful.length;

          // 阈值可通过 repo variable 配置
          const warnThreshold = 800;
          const blockThreshold = 1500;

          // acknowledgement：带 `oversized-ok` label 时，日志标明已确认
          const sizeWaived = (context.payload.pull_request?.labels || [])
            .map(l => l.name).includes('oversized-ok');

          if (totalChanges > blockThreshold && sizeWaived) {
            core.warning(
              `PR 超过 size 阈值且带 oversized-ok label，maintainer 已确认 reviewability 风险。`
            );
          } else if (totalChanges > blockThreshold) {
            core.warning(
              `PR 变更 ${totalChanges} 行 (${totalFiles} 文件)，超过阈值 ${blockThreshold} 行。\n\n` +
              `建议拆分为更小的、可独立 review 的 PR。拆分思路：\n` +
              `• 将重构与功能变更分开\n` +
              `• 将测试与实现分开提交\n` +
              `• 按模块/关注点拆分\n\n` +
              `若 PR 大但确实内聚，maintainer 可打 oversized-ok label 记录显式确认。`
            );
          } else if (totalChanges > warnThreshold) {
            core.warning(
              `PR 变更 ${totalChanges} 行，接近上限 (${blockThreshold})，建议精简。`
            );
          }
```

**参考**：CodelyTV/pr-size-labeler 的思路，但这里用 github-script 做自定义逻辑，不依赖第三方 action。

> **`oversized-ok` acknowledgement**：size 是 reviewability signal，不是 correctness failure。`PR Size` check 可作为 required check 确保这条 signal 一定运行，但 over-threshold 本身只发 warning，不阻断合并。maintainer 可给 PR 打 `oversized-ok` label 来记录"已看到并接受本次 PR 较大"；workflow 监听 `labeled`/`unlabeled` 事件，label 增删才能即时重跑 check。该 label 需在仓库预先创建。
>
> **self-acknowledgement guard**：PR 作者给自己的 PR 打 `oversized-ok` 不是独立 maintainer acknowledgement。判定不能只看 `payload.sender`——它只在 `labeled` 事件当下等于打标签的人；后续 `synchronize` 事件里 `sender` 只是推送者。因此实现通过 issue events timeline（`issues.listEvents`）解析出 `oversized-ok` 最近一次 `labeled` 事件的 `actor`，与 PR 作者比对，并把 self-acknowledgement 作为 warning 明确记录。该查询需要 `issues: read` 权限。

#### 完整 workflow 触发配置

```yaml
name: PR Gate
on:
  pull_request:
    # labeled/unlabeled 是 oversized-ok acknowledgement 即时生效所必需（见上文）；
    # reopened 也要带上。pr-template job 用 job 级 if: 跳过 label 事件，
    # pr-size 只在 oversized-ok label 变动时才因 label 事件重跑。
    types:
      [
        opened,
        edited,
        synchronize,
        ready_for_review,
        reopened,
        labeled,
        unlabeled,
      ]
    branches: [main, 'release/**']

permissions:
  contents: read
  pull-requests: read
# 两个 job 并行执行，互不依赖
```

### Phase B：调整 `qwen-code-pr-review.yml`

1. **移除 size check 的合并阻断语义**：现有 `Check PR size` step 改为输出 warning 到 job summary 和最终 review 评论，不再 `exit 1` 或发评论阻止。
2. **继续运行 AI review**：超大 PR 不再跳过 LLM；review 评论会带 Large PR warning，提醒 maintainer 信号可能不完整。
3. **考虑 review 结果不作为 required check**：Branch Protection 中不勾选此 workflow 的 job name

### Phase C：新增 CODEOWNERS

```
# .github/CODEOWNERS

# 默认 reviewer
*                           @QwenLM/qwen-code-maintainers

# 核心包
packages/core/              @QwenLM/qwen-code-core
packages/cli/               @QwenLM/qwen-code-core

# CI/Workflow
.github/                    @QwenLM/qwen-code-infra

# SDK
packages/sdk-*/             @QwenLM/qwen-code-sdk

# 文档
docs/                       @QwenLM/qwen-code-maintainers
```

配合 Branch Protection 的 "Require review from Code Owners" 生效。

### Phase D：Branch Protection 配置

在 repo Settings → Branches → main 的 protection rule 中：

- [x] Require a pull request before merging
  - [x] Required approving reviews: 1
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require review from Code Owners
- [x] Require status checks to pass before merging
  - Required checks:
    - `PR Template`
    - `PR Size`
    - `Lint`
    - `Test (ubuntu-latest, Node 22.x)`
    - `CodeQL`
- [x] Require conversation resolution before merging
- [ ] Require linear history (optional，看团队偏好)
- [x] Do not allow bypassing the above settings (连 admin 也要走流程)

### Phase E（可选）：增强 — label 自动化 + do-not-merge

```yaml
# 可加入 pr-gate.yml 或独立 workflow
pr-label:
  name: 'Auto Label'
  runs-on: ubuntu-latest
  steps:
    # 按文件路径自动打 label
    - uses: actions/labeler@v5
      with:
        repo-token: ${{ secrets.GITHUB_TOKEN }}

    # do-not-merge label 阻止合并
    - uses: actions/github-script@v9
      with:
        script: |
          const labels = context.payload.pull_request.labels.map(l => l.name);
          if (labels.includes('do-not-merge')) {
            core.setFailed('PR 标记为 do-not-merge，请移除该 label 后再合并。');
          }
```

## 开源项目参考

| 项目                         | 做法                                                                                 | 启发点                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Next.js** (vercel/next.js) | 快速 gate（auto-label、title）和慢速 CI（build matrix）分离；PR stats 只作为 comment | 快慢分离的典范                                                    |
| **Nx** (nrwl/nx)             | `pr-title-validation.yml` + `do-not-merge.yml` 独立 workflow                         | 每个关注点一个 workflow 文件                                      |
| **Kubernetes**               | Prow bot 管理 `/command`，所有 check 完全解耦；merge queue 保证 main 永绿            | 自研 bot + 解耦 check 的极致形态（你们的 qwen-code 可以走这条路） |
| **Rust** (rust-lang/rust)    | bors merge queue + 独立 per-check reporting                                          | merge queue 对大仓库很有价值                                      |
| **Danger JS** 模式           | 在 `dangerfile.ts` 里用代码写所有 PR 规则                                            | 如果规则复杂度上升，可以考虑迁移到 Danger                         |

## 与现有 qwen-code review 的关系

```
                    ┌──────────────┐
                    │  PR 提交      │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌────────────┐ ┌──────────┐ ┌──────────────────┐
     │ pr-gate.yml│ │  ci.yml  │ │ qwen-code-pr-    │
     │ (秒级)     │ │ (分钟级)  │ │ review.yml       │
     │            │ │          │ │ (5-30 分钟)       │
     │ • Body     │ │ • Lint   │ │                  │
     │ • Size warn│ │ • Test   │ │ • AI deep review │
     │            │ │ • CodeQL │ │ • qwen-code 产品 │
     └─────┬──────┘ └────┬─────┘ └───────┬──────────┘
           │              │               │
           ▼              ▼               ▼
     ┌──────────┐  ┌──────────┐    ┌──────────────┐
     │ REQUIRED │  │ REQUIRED │    │ INFORMATIONAL│
     │ (block)  │  │ (block)  │    │ (不阻断合并)  │
     └──────────┘  └──────────┘    └──────────────┘
```

## 实施优先级

| 优先级 | 内容                                          | 预估工作量 | 依赖               |
| ------ | --------------------------------------------- | ---------- | ------------------ |
| P0     | 新建 `pr-gate.yml` (body + size warning)      | 1-2h       | 无                 |
| P0     | Branch Protection 配置                        | 10min      | pr-gate.yml 合入后 |
| P1     | 调整 `qwen-code-pr-review.yml` 移除 size 阻断 | 30min      | pr-gate.yml 合入后 |
| P1     | 新建 CODEOWNERS                               | 30min      | 确认团队分组       |
| P2     | Auto-label + do-not-merge                     | 1h         | 无                 |
| P2     | `.github/labeler.yml` 路径 → label 映射       | 30min      | 无                 |

## 注意事项

1. **`pull_request` vs `pull_request_target`**：pr-gate.yml 用 `pull_request` 即可（只读操作，不需要 secrets）；qwen-code-pr-review.yml 保持 `pull_request_target`（需要 secrets 调 LLM）
2. **Fork PR**：`pull_request` 触发对 fork PR 天然支持，status check 正常报告；不存在权限问题
3. **`edited` 触发**：pr-gate.yml 必须监听 `edited` 事件，否则用户修改 PR body 后 check 不会重新运行
4. **阈值可配置化**：后续若需要，可把 size/body 阈值移到 repository variables；当前实现先使用代码内常量，避免在首版 gate 中引入额外配置依赖
5. **渐进上线**：建议先以 non-required 跑一周，观察误报率，再设为 required
