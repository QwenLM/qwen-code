# Code Review 自动化方案对比

跟同类 AI PR review 工具的能力对比，仅看本设计要关心的维度（触发、状态、文档锚定、身份）。

## 工具范围

| 工具                 | 形态                                     | 触发关键词                  | 评审主体              |
| -------------------- | ---------------------------------------- | --------------------------- | --------------------- |
| qwen-code 当前       | GitHub Action + 内置 review skill        | `@qwen /review`             | `github-actions[bot]` |
| qwen-code 本设计目标 | GitHub Action + preflight gates + bundled review + App | `@qwen /review`             | `qwen-code-review[bot]` (待 App 注册) |
| Claude Code GitHub   | GitHub App + claude-code-action          | `@claude`                   | `claude[bot]`         |
| GitHub Copilot Code Review | GitHub 内置                        | 自动 + `@copilot` (PR 内)   | `Copilot`             |
| CodeRabbit           | GitHub App + 自家后端                    | `@coderabbitai` + 评论命令  | `coderabbitai[bot]`   |
| Cursor BugBot        | GitHub App                                | 自动 + `@cursor` (PR 内)    | `cursor[bot]`         |
| Greptile             | GitHub App + 自家后端                    | `@greptileai`               | `greptileai[bot]`     |

## 维度对比

### 触发与执行

| 维度                              | qwen-code 当前 | qwen-code 目标 | Claude Code | Copilot Review | CodeRabbit  |
| --------------------------------- | -------------- | -------------- | ----------- | -------------- | ----------- |
| PR opened 自动                    | ✅             | ✅             | ✅          | ✅             | ✅          |
| push 后自动                       | ❌             | ✅             | ✅          | ✅             | ✅          |
| `@mention /review` 触发           | ✅             | ✅             | ✅          | ✅             | ✅          |
| `workflow_dispatch` 手动          | ✅             | ✅             | ✅          | ❌             | ❌          |
| 跨 repo PR (fork) 评审            | ❌（明确拒）   | ❌             | ⚠️ 仅评论   | ✅             | ✅          |
| dry-run 模式                      | ✅             | ✅             | ❌          | ❌             | ❌          |
| 大 PR 体积 gate                   | ✅ 1500 行     | ✅             | ❌          | ❌             | ⚠️ 不阻断   |
| 并发 cancel-in-progress           | ✅             | ✅             | ✅          | ✅             | ✅          |

### 状态与增量

| 维度                              | qwen-code 当前 | qwen-code 目标 | Claude Code | Copilot Review | CodeRabbit  |
| --------------------------------- | -------------- | -------------- | ----------- | -------------- | ----------- |
| 增量评审 (只评新 commit)          | ⚠️ skill 支持但 cache 不持久化 | ✅      | ✅          | ✅             | ✅          |
| 跨 run cache 持久化               | ❌             | ✅             | 内部托管    | 内部托管        | 内部托管    |
| 历史评审 finding 去重             | ❌             | ✅ (Phase 6)   | ✅          | ✅             | ✅          |
| 历史评论 reply chain 解析         | ✅             | ✅             | ✅          | ⚠️             | ✅          |
| "Already discussed" 抑制          | ✅             | ✅             | ✅          | ❌             | ✅          |
| 轮次感知的非 critical 抑制        | ❌             | ✅ (Phase 6)   | ❌          | ❌             | ⚠️ 部分     |

### 评审深度

| 维度                              | qwen-code 当前 | qwen-code 目标 | Claude Code | Copilot Review | CodeRabbit  |
| --------------------------------- | -------------- | -------------- | ----------- | -------------- | ----------- |
| 多 agent 并行评审                 | ✅ 9 agent     | ✅             | ⚠️ 单 agent | ❌             | ⚠️ 2-3      |
| 多人格 audit (attacker / oncall / 维护者) | ✅      | ✅             | ❌          | ❌             | ❌          |
| 确定性 lint/typecheck 集成        | ✅             | ✅             | ⚠️ 靠 hooks | ✅             | ✅          |
| 跨文件影响分析                    | ✅             | ✅             | ⚠️          | ⚠️             | ✅          |
| 迭代 reverse audit                | ✅ 最多 3 轮   | ✅             | ❌          | ❌             | ❌          |
| 批量 verification 防止假阳性      | ✅             | ✅             | ❌          | ❌             | ⚠️          |
| Low-confidence finding 不进 PR 评论 | ✅           | ✅             | ❌          | ❌             | ⚠️          |
| Build + test 自动跑               | ✅             | ✅             | ❌ (CI 跑)  | ❌             | ❌          |

### 文档锚定与方向控制（本设计独有能力）

| 维度                              | qwen-code 当前 | qwen-code 目标 | Claude Code | Copilot Review | CodeRabbit  |
| --------------------------------- | -------------- | -------------- | ----------- | -------------- | ----------- |
| 项目级 review 规则文件            | ✅ `.qwen/review-rules.md` | ✅ | `CLAUDE.md` 段落 | 仓库设置        | `.coderabbit.yaml` |
| 评审前置 gate 对照具体设计文档    | ❌             | ✅ (Phase 4)   | ❌          | ❌             | ❌          |
| 评审前置 gate 对照 roadmap        | ❌             | ✅ (Phase 4)   | ❌          | ❌             | ❌          |
| 评审前置 gate 对照架构文档        | ❌             | ✅ (Phase 4)   | ❌          | ❌             | ❌          |
| 评审规则对标其他工具 (Claude Code) | ❌            | ✅ (Phase 4)   | n/a         | ❌             | ❌          |
| Feature PR readiness / dogfooding gate | ⚠️ 仅规则文字 | ✅ (Phase 4) | ❌          | ❌             | ⚠️ 部分     |
| 历史 closed-unmerged PR 感知      | ❌             | ✅ (Phase 5)   | ❌          | ❌             | ❌          |
| "by design 拒过"检测              | ❌             | ✅ (Phase 5)   | ❌          | ❌             | ❌          |
| 历史 revert / regression 感知     | ❌             | ✅ (Phase 5)   | ❌          | ❌             | ❌          |

> 文档锚定与方向控制是本设计相对其他工具的**核心差异化能力**。其他工具靠模型常识 + 用户配置文件，本设计靠仓库已有的 design 文档 + 历史 PR 数据，每条 finding 必须 cite anchor。

### 身份与权限

| 维度                              | qwen-code 当前 | qwen-code 目标 | Claude Code | Copilot Review | CodeRabbit  |
| --------------------------------- | -------------- | -------------- | ----------- | -------------- | ----------- |
| 评审主体身份独立 (`<name>[bot]`)  | ❌ `github-actions[bot]` | ✅ `qwen-code-review[bot]` (待) | ✅ | ✅ | ✅ |
| `@` 评论框补全                    | ❌             | ✅ (待 App 装) | ✅          | ✅             | ✅          |
| 触发权限校验                      | ✅ author_association | ✅ App installation | ✅ App | ✅ 内置 | ✅ App |
| 公开 App 可安装                   | ❌             | 待 org owner   | ✅          | ✅             | ✅          |
| OSS 仓库可独立 install            | ❌             | ✅ (后)        | ✅          | ✅             | ✅          |

## 总结

本设计在**评审深度**维度已经比所有同类工具更深（9 agent + reverse audit + 跨文件 + 多人格），但在**触发自动化**和**身份**两块落后于行业基线，这是 Phase 2 / Phase 7 要补齐的。

真正独有的差异化在**preflight 文档锚定与方向控制**：现有 design 文档 + 历史 PR 数据作为 anchor，每条 direction 类 finding 强制 cite，并在进入实现层 `/review` 前完成判断。这一块直接对应"`Catch up with Claude Code` + 在 preflight 层校验对齐情况"的 roadmap 目标。
