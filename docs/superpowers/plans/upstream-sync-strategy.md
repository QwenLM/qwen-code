# Upstream Sync Strategy for alishu/qwen-code

## Current State Analysis

```
Merge base:      070ec5b43 (2026-03-27)
Internal HEAD:   c7fe3811  (v0.14.0, 108 commits ahead)
Upstream HEAD:   520f1e24  (v0.14.2, 382 commits ahead)

File overlap:
  - 48 files  -> only changed internally (safe)
  - 126 files -> only changed upstream (auto-merge)
  - 332 files -> changed both sides (need review)
```

### Internal Changes Classification

| Category                                            | Commits | Conflict Risk         | Strategy                                                |
| --------------------------------------------------- | ------- | --------------------- | ------------------------------------------------------- |
| DDAR (already upstream: #2854, #2872, #2889)        | ~3      | High (duplicate)      | **Drop** - already merged upstream                      |
| DDAR (not yet upstream: #2864, #2871)               | ~2      | Medium                | **Keep as branches** - will merge upstream via PR       |
| DataWorks branding (logo, header, tips, powered-by) | ~20     | Low-Medium            | **Maintain as patch set**                               |
| Verbose/Compact mode (largely overlaps upstream)    | ~15     | High (divergent impl) | **Favor upstream**, keep only delta                     |
| Version bumps (dataworks suffixes)                  | ~15     | Low                   | **Re-apply after merge**                                |
| Internal-only code (DualOutput, RemoteInput, etc.)  | ~10     | Low                   | **Keep as-is** - isolated files                         |
| Core bug fixes (retry, stream, DashScope)           | ~8      | Medium                | **Check if upstream has equivalent**, drop if redundant |
| Build/CI/config tweaks                              | ~5      | Low                   | **Merge carefully**                                     |

---

## Architecture Overview

### Code Layer Architecture (Target State)

Separate internal code into clear layers so upstream syncs only touch Layer 1, and Layers 2-3 remain untouched:

- **Layer 1** = upstream code, synced regularly. Conflicts resolved by "upstream wins" by default.
- **Layer 2** = branding config, isolated in `packages/cli/src/branding/`. Never touched by upstream.
- **Layer 3** = internal-only features in separate files. No upstream equivalent, no conflict.

---

## Recommended Approach: "AI Triage + Layered Merge"

The core idea is to **minimize the "conflict surface area"** by (a) structurally isolating internal customizations and (b) using an AI skill to automate the triage and merge process.

---

## Phase 1: One-time Cleanup (Reduce Conflict Surface)

### 1.1 Drop Redundant Commits

- `#2854` mid-turn-queue-drain -> already upstream as `b6373ac71`
- `#2872` followup-toolcall-ui-leak -> already upstream as `f208801b0`
- `#2889` dangerous-actions-guidance -> already upstream as `5df8fa0ff`

### 1.2 Isolate DataWorks Branding

Refactor to config-driven approach with feature flags in `settingsSchema.ts`.

### 1.3 Rebase onto Upstream

One-time merge to sync up to upstream v0.14.2.

---

## Phase 2: Sync Automation

### Skill: `upstream-sync`

Two modes:

- **Analyze** (read-only): classify commits, compute conflict scores, generate report
- **Merge** (writes): create branch, merge, LLM-resolve conflicts, run tests, create MR

### Conflict Resolution Rules

See `.qwen/upstream-sync-rules.yml` for the full rule set.

---

## Phase 3: GitLab CI Automated Sync Pipeline

### Branch Strategy

- `staging/upstream-sync`: Long-lived staging branch, CI syncs upstream here daily
- `main`: Stable internal branch, only reviewed MRs merge in
- Daily sync creates `sync/upstream-YYYY-MM-DD` -> MR to `staging/upstream-sync`
- Per upstream release: `staging/upstream-sync` -> `main` batch MR

### CI Pipeline (Aone CI)

Two Aone CI workflows in `.aoneci/workflows/`:

1. **`upstream-sync-analyze.yml`** - 每日分析 upstream 变更 + 钉钉通知
2. **`upstream-sync-merge.yml`** - 合并 upstream + 验证 + 创建 MR

### Required Aone CI Variables

| Variable                                  | Description                               |
| ----------------------------------------- | ----------------------------------------- |
| `CI_AONE_CODE_PRIVATE_TOKEN_{employeeId}` | GitLab private token（推送分支、创建 MR） |
| `CI_QWEN_API_KEY`                         | Qwen API Key（LLM 辅助冲突解决，可选）    |
| `CI_DINGTALK_WEBHOOK_URL`                 | 钉钉机器人 webhook 地址（可选）           |

---

## Stability Guarantees

1. **Pre-Merge Safety Net**: dry-run merge, snapshot tag, conflict score gate
2. **Post-Merge Verification**: build, typecheck, test, lint, smoke test, branding check
3. **Rollback**: auto reset to checkpoint on failure
4. **Incremental Sync**: weekly cadence, max 2-week gap

---

## Feature Flag Architecture

All internal-only features gated behind `features.*` settings (see `settingsSchema.ts`).
Internal repo enables them via `.qwen/settings.json` project-level settings.

---

## Divergence Tracking

Fork 差异通过 CI 任务自动分析（`.aoneci/workflows/upstream-fork-divergence.yml`），
运行 `scripts/upstream-fork-divergence.sh` 生成分类报告，无需手动维护清单文件。

---

## Implementation Files

- `.qwen/skills/upstream-sync/SKILL.md` - Cursor skill definition
- `scripts/upstream-sync-analyze.sh` - Git diff analysis helper
- `scripts/upstream-sync-verify.sh` - Post-merge verification pipeline
- `scripts/upstream-fork-divergence.sh` - Fork 差异自动分析脚本
- `.aoneci/workflows/upstream-fork-divergence.yml` - Fork 差异分析 CI
- `.qwen/upstream-sync-rules.yml` - Conflict resolution rules for LLM
- `.aoneci/workflows/upstream-sync-analyze.yml` - 每日分析 CI
- `.aoneci/workflows/upstream-sync-merge.yml` - 合并验证 CI
- `.qwen/settings.json` - Internal feature flags (project-level)
