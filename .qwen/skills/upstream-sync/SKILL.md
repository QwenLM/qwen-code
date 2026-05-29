# Upstream Sync Skill

Synchronize internal fork (alishu/qwen-code) with upstream (QwenLM/qwen-code).

**Triggers**: "upstream sync", "sync upstream", "analyze upstream", "merge upstream", "sync report"

## Architecture

本仓库采用 **patch-stack + guarded merge** 双层保护机制：

- **Patch stack** (`.fork/patches/`): 将长期 fork 定制以有序补丁形式维护，sync 后可验证
- **Guarded merge** (`.aoneci/upstream-sync-merge.yml`): CI 自动 fetch + merge + 验证 + 创建 MR
- **Domain auth helper** (`.aoneci/scripts/upstream-sync-domain-auth.sh`): 统一认证和 MR 发布

关键文件：

| 文件                                           | 用途                              |
| ---------------------------------------------- | --------------------------------- |
| `.fork/manifest.json`                          | 补丁定义、包名映射、registry 配置 |
| `.fork/patches/series`                         | 补丁应用顺序                      |
| `.fork/apply.sh`                               | 应用补丁栈                        |
| `.fork/unapply.sh`                             | 反转补丁栈                        |
| `.fork/verify.sh`                              | 验证补丁是否在当前代码中存活      |
| `.fork/generate-patches.js`                    | 从 fork diff 生成补丁文件         |
| `.fork/rewrite-package-identity.js`            | 包名/registry 改写（正向/反向）   |
| `.fork/sync-upstream.sh`                       | 本地 upstream sync 辅助           |
| `.aoneci/upstream-sync-merge.yml`              | CI 自动同步流水线                 |
| `.aoneci/upstream-sync-analyze.yml`            | CI 每日变更分析 + 钉钉通知        |
| `.aoneci/scripts/upstream-sync-domain-auth.sh` | CI 认证/推送/MR 发布              |
| `.qwen/upstream-sync-rules.yml`                | 冲突解决策略规则                  |
| `scripts/upstream-sync-analyze.sh`             | Git diff 分析辅助                 |
| `scripts/upstream-sync-verify.sh`              | merge 后验证流水线                |
| `scripts/upstream-fork-divergence.sh`          | fork 差异自动分析                 |

## Modes

### Mode 1: Analyze (default, read-only)

When the user says "analyze upstream" or "sync report":

1. Run `git fetch upstream main`
2. Find the merge base: `MERGE_BASE=$(git merge-base HEAD upstream/main)`
3. Count new upstream commits: `git log --oneline $MERGE_BASE..upstream/main --no-merges | wc -l`
4. If zero commits, report "Already up to date" and stop
5. Categorize upstream commits by reading their messages and diff stats:
   - For each commit, classify area (cli/core/channels/docs/tests/build/other) and risk (safe/low/medium/high)
6. Identify files changed on both sides:
   ```bash
   comm -12 <(git diff --name-only $MERGE_BASE HEAD | sort) <(git diff --name-only $MERGE_BASE upstream/main | sort)
   ```
7. Cross-reference with `.fork/manifest.json` patch paths to identify high-risk overlaps
8. Run `bash scripts/upstream-fork-divergence.sh` to get current fork divergence state
9. Generate a structured markdown report with:
   - Summary: N new upstream commits, date range
   - Commits grouped by area and risk
   - Both-changed files count and list
   - High-risk files (upstream changed files that overlap with fork patches)
   - Redundant internal commits (already in upstream)
   - Current divergence categories and convergence status
   - Recommended next action

### Mode 2: Merge

When the user says "merge upstream" or "sync upstream":

1. Read `.qwen/upstream-sync-rules.yml` for conflict resolution rules
2. Create a sync branch with collision-safe checkpoint tag:
   ```bash
   git tag "sync-checkpoint-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short=7 HEAD)" HEAD
   SYNC_BRANCH="sync/upstream-$(date +%Y-%m-%d)"
   git checkout -b $SYNC_BRANCH
   ```
3. Attempt merge: `git merge upstream/main --no-edit`
4. If conflicts occur:
   - Count conflicted files: `git diff --name-only --diff-filter=U`
   - If count > 20, abort and report (too many conflicts for auto-resolution)
   - For each conflicted file:
     a. Determine which rule applies from upstream-sync-rules.yml
     b. If rule says "keep ours": `git checkout --ours <file> && git add <file>`
     c. If rule says "keep theirs": `git checkout --theirs <file> && git add <file>`
     d. If rule says "ai-resolve": read both versions, apply semantic merge, write result
     e. If rule says "regenerate" (package-lock.json): delete and run `npm install`
5. Run fork patch verification:
   ```bash
   bash .fork/verify.sh
   ```
6. Run build verification:
   ```bash
   npm run build
   npm run typecheck
   npm run test
   ```
7. If verification fails, attempt auto-fix (max 2 rounds):
   - Read error output
   - Identify likely cause (import path changes, type signature changes, etc.)
   - Apply fix and re-run verification
8. If still failing after 2 rounds:
   - Report failure with diagnostics
   - Offer to rollback using the checkpoint tag
9. Commit and push:
   ```bash
   git add -A
   git commit -m "chore: sync upstream $(date +%Y-%m-%d)"
   git push origin $SYNC_BRANCH
   ```
10. Report success with MR creation instructions

### Mode 3: Divergence Check

When the user says "check divergence" or "fork status":

1. Run `bash scripts/upstream-fork-divergence.sh` to generate the full divergence report
2. Summarize key metrics: divergence score, categories, convergence status
3. Highlight any new files that need categorization
4. Suggest convergence actions for "review needed" files

### Mode 4: Patch Management

When the user says "refresh patches", "generate patches", or "verify patches":

1. **Generate/refresh patches**:
   ```bash
   git fetch origin main && git fetch upstream main --tags
   node .fork/generate-patches.js --write
   node .fork/generate-patches.js --check
   ```
2. **Verify patches against current code**:
   ```bash
   bash .fork/verify.sh
   ```
3. **Apply/unapply patch stack** (for testing or upstream sync):
   ```bash
   bash .fork/apply.sh    # apply all patches in series order
   bash .fork/unapply.sh  # reverse all patches
   ```
4. **Rewrite package identity** (after sync):
   ```bash
   node .fork/rewrite-package-identity.js           # apply fork names
   node .fork/rewrite-package-identity.js --reverse  # restore upstream names
   ```

## CI Pipeline State Machine

The `.aoneci/upstream-sync-merge.yml` pipeline uses a state-file pattern:

```
CONFLICT_STATUS_FILE states:
  "skip"         → no upstream changes, pipeline exits early
  "pending"      → merge in progress (initial state after new commits detected)
  "clean"        → merge succeeded without conflicts
  "has_conflicts"→ merge produced conflicts (may be auto-resolved)
```

Pipeline flow:

1. `prepare` → domain-auth helper bootstraps git context
2. `fetch upstream` → get latest upstream/main
3. `check new commits` → if none, set "skip" and exit
4. `create sync branch` → set status to "pending"
5. `merge` → attempt git merge, update status to "clean" or "has_conflicts"
6. `verify` → build + typecheck + patch verification
7. `publish` → domain-auth helper pushes branch and creates/reuses MR

## Important Notes

- NEVER force-push or rewrite history on main or staging branches
- ALWAYS create a checkpoint tag before merging (format: `sync-checkpoint-YYYYMMDD-HHMMSS-<short-sha>`)
- ALWAYS run build+test after merge before reporting success
- ALWAYS run `.fork/verify.sh` after merge to check patch survival
- If in doubt about a conflict resolution, ask the user rather than guessing
- Divergence analysis is fully automated via `scripts/upstream-fork-divergence.sh`
- Domain auth supports both username+token and legacy token fallback
