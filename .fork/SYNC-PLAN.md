# Fork Upstream Sync - 设计方案与分支状态

## 概述

本 fork (`gitlab.alibaba-inc.com/alishu/qwen-code`) 的定义：

```
fork/main = upstream/main + .fork/patches/* + package identity rewrite
```

每日 CI 定时任务负责自动同步 upstream 的最新代码，并重新应用所有 patch。

## 同步策略：Patch-Apply 模式

### 核心流程

```
upstream/main (最新)
    │
    ├── git checkout -B sync/upstream-YYYYMMDD upstream/main
    │
    ├── 从 fork/main 取回基础设施文件：.fork/ .aoneci/ .qwen/
    │
    ├── bash .fork/apply.sh  (按 series 顺序 apply 所有 patch)
    │
    ├── node .fork/rewrite-package-identity.js  (改写 package name/registry)
    │
    └── push → 创建 MR 到 main
```

### 为什么不用 Merge 模式

Merge 模式（把 upstream merge 进 fork/main）必然产生冲突，因为 fork/main 中已经 bake 了 patch 的修改。例如 `channel-registry.ts` 里的 import 路径已被改写，merge 时 upstream 版本和 fork 版本总是不同的。

Patch-Apply 模式每次从全新 upstream 基础出发，不存在"两边都改了"的问题。

## 当前分支状态

| 分支                             | 基于                    | 状态                 | 说明                                 |
| -------------------------------- | ----------------------- | -------------------- | ------------------------------------ |
| `origin/main` (fork main)        | —                       | 已合并到 `ab38e03e7` | Fork 主线，含 patch infrastructure   |
| `fix/ci-remove-lfs-prepush-hook` | fork main (`ab38e03e7`) | **活跃，已推送**     | 本次修复分支，2 个新 commit          |
| `codex/fork-sync-guard`          | fork main               | 已推送               | CI sync 的额外防护（代码审查修复等） |
| `origin/sync/upstream-20260529`  | upstream/main           | 失败的 sync 分支     | 旧 merge 模式产生的，可废弃          |
| `resolve/upstream-sync-20260529` | fork main               | 本地临时             | 同上，用于手动解冲突，可删除         |
| `inspect/sync-conflicts`         | upstream/main           | 本地临时             | 调试用，可删除                       |

## fix/ci-remove-lfs-prepush-hook 分支改动

### Commit 1: `b9b6d69ad`

**fix(ci): drop stale .git/hooks/pre-push before upstream sync push**

解决 CI runner 上残留的 git-lfs pre-push hook 导致 push 失败。

### Commit 2: `a8af9472d`

**fix(ci): rewrite upstream sync to patch-apply model and refresh patches**

核心改动：

1. **`.aoneci/upstream-sync-merge.yml`** — 重写 CI 脚本
   - 移除 merge 逻辑（~340 行）
   - 新增 patch-apply 逻辑
   - 修复 `qwen: not found`：`npx --registry` → `npm_config_registry` env + `npm exec`

2. **`.fork/patches/0003-i18n-dataworks.patch`** — 更新 zh.js context anchor
   - Upstream 在 `'Long conversation...'` 和 `// Exit Screen` 间插入了新行

3. **`.fork/patches/0007-feishu-channel.patch`** — 1924 行 → 22 行
   - Upstream PR #4379 已添加 feishu 源码
   - 仅保留 import path 改写（`@qwen-code/channel-feishu` → `@alife/...`）

4. **`.fork/patches/0010-build-single-bundle.patch`** — 移除 feishu build order hunk
   - Upstream 已在 build order 中包含 feishu

5. **`.fork/patches/0011-test-fork-adaptations.patch`** — 移除 252 行
   - Upstream 已做相同的 static import 重构（detect-terminal-theme.test.ts）

6. **`.fork/manifest.json`** — 对应更新 paths 和 metadata

## Patch 清单（10 个）

| #    | 文件                                | 行数 | 说明                                                                                          |
| ---- | ----------------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| 0001 | branding-header.patch               | 263  | DataWorks branding                                                                            |
| 0002 | branding-tips.patch                 | 124  | 启动提示                                                                                      |
| 0003 | i18n-dataworks.patch                | 78   | i18n 占位符                                                                                   |
| 0004 | dsw-oauth-redirect.patch            | 74   | DSW OAuth 代理                                                                                |
| 0005 | osc8-internal.patch                 | 115  | 终端超链接适配                                                                                |
| 0006 | dingtalk-channel-enhancements.patch | 649  | 钉钉 channel 增强                                                                             |
| 0007 | feishu-channel.patch                | 22   | 飞书 import path                                                                              |
| 0009 | claude-websearch-compat.patch       | 155  | WebSearch 兼容                                                                                |
| 0010 | build-single-bundle.patch           | 96   | 单文件打包 + 移除 acp-bridge 显式构建步骤（fork 通过 tsconfig project references 传递性编译） |
| 0011 | test-fork-adaptations.patch         | 91   | 测试适配                                                                                      |

全部 10 个 patch 已验证可在 upstream/main (`c699738f9`) 上 clean apply。

## 后续操作

1. **合并此 MR** — 将 `fix/ci-remove-lfs-prepush-hook` 合入 fork main
2. **等待次日 CI cron** — 验证 sync 流程正常运行（无冲突、无 command not found）
3. **清理废弃分支** — `sync/upstream-20260529`、`resolve/upstream-sync-20260529`、`inspect/sync-conflicts`
4. **`codex/fork-sync-guard`** — 评估是否需要合并其额外防护逻辑

## CI YAML 关键片段

```yaml
# patch-apply 核心逻辑
git checkout -B "$SYNC_BRANCH" upstream/main
git checkout "origin/$TARGET_BRANCH" -- .fork/ .aoneci/ .qwen/ 2>/dev/null || true
bash .fork/apply.sh 2>&1 || APPLY_RC=$?

# 如果 apply 失败，尝试 LLM 修复
npm_config_registry="https://registry.anpm.alibaba-inc.com/" \
  OPENAI_API_KEY="$QWEN_API_KEY" \
  OPENAI_BASE_URL="$QWEN_BASE_URL" \
  npm exec --yes --package=@alife/dataworks-qwen-code@latest -- qwen \
  --auth-type openai \
  --prompt "$LLM_PROMPT" \
  --yolo

# package identity 改写
node .fork/rewrite-package-identity.js
```
