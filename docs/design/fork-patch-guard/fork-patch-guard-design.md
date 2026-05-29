# Fork Patch Guard：upstream sync 时 fork 定制保护机制

> 解决 fork 仓库在合并上游代码时，冲突解决阶段静默丢失 fork 定制改动的问题。

## 1. 问题背景

### 1.1 当前痛点

本仓库是 QwenLM/qwen-code 的内部 fork，包含大量 DataWorks 定制改动（tips、i18n、双输出模式、CI 配置等）。每次 upstream sync 时需要合并上游几十个 commits，过程中：

- **冲突解决容易丢失 fork 改动**：上游重构了文件结构（如 `startupTips[]` → `tipRegistry` 系统），合并时 fork 的改动被上游新代码覆盖
- **丢失是静默的**：合并后 typecheck/build/tests 全部通过，但功能行为已经变了
- **发现时已经晚了**：通常在用户使用中才发现 "怎么通用 tips 又回来了"

### 1.2 已发生的案例

| Commit      | 描述                                 | 丢失情况                                      |
| ----------- | ------------------------------------ | --------------------------------------------- |
| `b621fe82d` | 只显示 DataWorks tips，移除通用 tips | 上游引入 tipRegistry 系统时通用 tips 全部回来 |

### 1.3 不适用的方案

- **git cherry-pick 检测**：上游重构后 commit 的 diff 完全不同，cherry 无法匹配
- **文件级 diff**：fork 改动分散在几十个文件中，逐文件比对噪音太大
- **手动 checklist**：容易遗漏，依赖人的记忆

## 2. 方案设计

### 2.1 核心思路

维护一份 **fork 补丁清单**，记录每个 fork 定制的 commit 及其关键意图。提供 **验证脚本**，在 upstream sync 后自动检查这些定制是否还在。

验证逻辑基于 **commit diff 内容推导**，不需要手动维护文件路径和断言。

### 2.2 组成部分（已实现）

```
.fork/
  manifest.json             # 补丁定义、包名映射、registry 配置（source of truth）
  patches/
    series                  # 补丁应用顺序
    0001-branding-header.patch
    0002-branding-tips.patch
    ...
  apply.sh                  # 按顺序应用补丁栈
  unapply.sh                # 反转所有补丁
  verify.sh                 # 验证补丁是否在当前代码中存活
  generate-patches.js       # 从 fork diff 生成补丁文件
  generate-patches.sh       # shell 包装
  create-patch.sh           # 创建新补丁
  refresh-patch.sh          # 刷新已有补丁
  rewrite-package-identity.js  # 包名/registry 正向和反向改写
  sync-upstream.sh          # 本地 upstream sync 辅助
  patches.md                # 自动生成的 fork 补丁清单
```

> 注：此设计文档描述的是 v1 原始方案。实际实现参见
> `docs/design/fork-patch-guard/fork-patch-stack-architecture.md`。

### 2.3 补丁清单格式 (`.fork/patches.md`)

```markdown
# Fork Patches

每次在 fork 上做定制改动后，在此记录 commit 信息。
upstream sync 后运行 `bash .fork/verify.sh` 检查这些改动是否还在。

当前第一阶段已经落地 `.fork/patches.md`，内容包括：

- `origin/main` 相对 `upstream/main` 的 first-parent PR/MR 落地提交清单
- patch-bearing commit inventory
- snapshot 使用的 `origin/main`、`upstream/main`、`merge-base`
- 后续 upstream sync 过程中如何新增、保留、退休条目的维护规则

## DataWorks Tips

- commit: b621fe82d
- 描述: 只显示 DataWorks tips，移除通用 startup tips
- 验证策略: added-lines
- 关键意图: tipRegistry.ts 中不应存在通用 startup tips（如 new-user-slash、compress-startup 等）

## DataWorks 输入框 Placeholder

- commit: ca172b61e
- 描述: 输入框使用 DataWorks 定制的 placeholder 文案
- 验证策略: added-lines

## npm 发布策略

- commit: 9550d4755
- 描述: 支持 x.y.z-dataworks.N 版本号作为正式版发布
- 验证策略: added-lines
```

字段说明：

| 字段     | 必填 | 说明                                                     |
| -------- | ---- | -------------------------------------------------------- |
| commit   | 是   | fork 定制的 commit hash                                  |
| 描述     | 是   | 一句话说明这个改动做了什么                               |
| 验证策略 | 否   | `added-lines`（默认）/ `removed-lines` / `both` / `skip` |
| 关键意图 | 否   | 补充说明，帮助人工判断                                   |

### 2.4 验证脚本逻辑 (`.fork/verify.sh`)

```
对清单中的每个 commit：
  1. git show <commit> 提取 diff
  2. 根据验证策略检查：
     - added-lines: commit 新增的非空行（+开头），在当前 HEAD 对应文件中应存在
     - removed-lines: commit 删除的非空行（-开头），在当前 HEAD 对应文件中应不存在
     - both: 同时检查以上两项
     - skip: 跳过自动验证（需人工确认）
  3. 报告结果：PASS / WARN（部分行缺失）/ FAIL（大量行缺失）
```

#### 关键设计决策

**为什么用 commit diff 推导而不是手动写断言？**

- 手动写断言维护成本高，容易和代码不同步
- commit diff 是事实来源（source of truth），改动了什么自动可知
- 上游重构文件路径时，脚本能自动检测到文件不存在并报警

**为什么用行级匹配而不是 patch apply？**

- 上游可能重新格式化了代码（缩进、换行）
- 行内容可能微调（变量名、import 路径）
- 行级匹配容忍轻微变化，patch apply 会直接失败

**阈值判定：PASS / WARN / FAIL**

- PASS：>= 80% 的关键行仍存在
- WARN：50%–80% 的关键行存在（可能是重构导致，需人工确认）
- FAIL：< 50% 的关键行存在（大概率被覆盖）

### 2.5 工作流集成

```
开发时：
  1. 在 fork 上做定制改动
  2. 提交后，在 .fork/patches.md 中添加一条记录

upstream sync 时：
  1. git merge upstream/main
  2. 解决冲突
  3. 运行 bash .fork/verify.sh
  4. 检查输出，修复 FAIL/WARN 的条目
  5. 提交 merge commit
```

可以考虑在 merge commit 的 CI 中自动运行验证脚本，作为 pipeline check。

## 3. 验证脚本伪代码

```bash
#!/bin/bash
# .fork/verify.sh — 验证 fork 定制改动是否在当前 HEAD 中存在

PATCHES_FILE=".fork/patches.md"
PASS=0; WARN=0; FAIL=0; SKIP=0

# 解析 patches.md，提取每个 patch 的 commit 和验证策略
parse_patches() {
  # 从 markdown 中提取 ## 标题、commit hash、验证策略
}

for each patch:
  # 1. 获取 commit 的 diff
  diff=$(git show $commit --format= -- )

  # 2. 提取改动的文件和行
  for each file in diff:
    added_lines = lines starting with "+" (non-header)
    removed_lines = lines starting with "-" (non-header)

    # 3. 检查行是否存在于当前文件
    if strategy == "added-lines" or "both":
      for line in added_lines:
        grep -qF "$line" current_file
    if strategy == "removed-lines" or "both":
      for line in removed_lines:
        ! grep -qF "$line" current_file

  # 4. 计算通过率，判定结果
  rate = matched / total
  if rate >= 0.8: PASS
  elif rate >= 0.5: WARN
  else: FAIL

# 5. 输出汇总
echo "Results: $PASS passed, $WARN warnings, $FAIL failed, $SKIP skipped"
```

## 4. 边界情况处理

| 场景                                        | 处理方式                                                  |
| ------------------------------------------- | --------------------------------------------------------- |
| commit 涉及的文件被上游删除                 | 报 WARN，提示文件不存在，需人工确认改动是否迁移到了新文件 |
| commit 涉及的文件被上游重命名               | 同上，文件不存在时触发 WARN                               |
| fork 改动被有意重构（如 API rename）        | 设置验证策略为 `skip`，在关键意图中说明                   |
| 一个 commit 混合了 fork 定制和通用修改      | 建议拆分 commit；或在关键意图中说明只需关注哪些文件       |
| commit 已不在当前分支历史中（被 rebase 掉） | 报 ERROR，提示 commit 不可达                              |

## 5. 后续演进

### 5.1 短期（v1）

- 实现基本的 `patches.md` + `verify.sh`
- 手动运行验证

### 5.2 中期（v2）

- 集成到 CI pipeline，upstream sync 的 MR 自动运行验证
- 验证结果作为 MR comment 输出
- 支持 `--fix` 模式：对 FAIL 的条目，尝试从 commit diff 中提取补丁并 cherry-pick

### 5.3 长期（v3）

- 与 upstream sync 脚本集成，merge 冲突解决时自动提示 "这个文件有 fork patch，注意保留"
- 支持语义级别的验证（不只是行匹配，而是 AST 级别的检查）
