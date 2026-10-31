# /autofix-pr：合并边界，以及受阻一轮的自我报告

[English](2026-10-31-autofix-pr-merge-boundary-and-blocked-report.md) | [简体中文](2026-10-31-autofix-pr-merge-boundary-and-blocked-report.zh-CN.md)

状态：已实现（2026-10-31）

## 问题陈述

GitHub 于 2026-10-28 上线 **Agent Merge**：PR 合并框里的 `Watch and fix` 按钮，按启用者勾选的阻塞项（失败的 Actions workflow、合并冲突）监视 PR，并在云端修复。把它与 `/autofix-pr` 对照后，发现两个几乎零成本就能补上的缺口：

1. **什么都没推送的一轮，在 PR 上完全静默。** 这一轮做不到的事只进入状态文件的 `needsHuman`、`/autofix-pr status` 和会话里的一行报告——而 skill 要求：只要没推送、也没有回答 review 或 issue 评论，就省略总结。盯着 PR 的 reviewer 分不清"监视还在跑"和"监视已经放弃"。Agent Merge 在开工时发一条 timeline 事件，并在合并框里保留一个面板，所以它的状态始终在看 PR 的地方可见。
2. **职责边界只写给 agent 看。** "从不合并、从不 approve" 只写在修复 brief 的 `## Never` 里，用户根本读不到。skill 开头、启动确认、用户指南都没有说这个监视**不**做什么，也没说它与 auto-merge 的关系。Agent Merge 的文档用一句话讲清了两点：它把 PR 修到可合，它不开启 auto-merge，也不替代人工评审和仓库的合并要求。

## 现状

对照 `origin/main` 的 `46d825d115` 核实（2026-10-31）：

- `packages/cli/src/commands/autofix-pr/reply.ts`：不回答任何评论的总结，此前只在 `state.summarizedSha !== head` 时才发。也就是说，辅助命令本来就允许"无推送的总结"——每个 head 一条——但只要上一轮已在这个 head 发过总结（推送之后，或回答评论之后），之后所有受阻的一轮都会被压掉。
- 同一文件按 `(head, text)` 去重记录 `needsHuman`，所以重跑同一份计划不会新增条目。
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` 的 Round 第 7 步："Omit it (`null`) when nothing was pushed and no review or issue comment was answered."
- `status.ts` 会列出 `needsHuman`；PR 侧此前没有任何关于它的报告。

## 目标

- 留下需要人处理事项的一轮，即使什么都没推送，也要在 PR 上说出来——包括在上一轮已经总结过的 head 上。
- 同样的受阻事项绝不发第二次；`--no-reply` 的监视仍然什么都不发。
- skill、启动确认和用户指南都写明边界：修到可合，从不 approve / 改变评审状态 / 合并 / 关闭 / 开启 auto-merge——并说明它与仓库的 auto-merge 可以组合。

## 范围边界（非目标）

Agent Merge 的其余能力本次刻意不做：

- 不做按阻塞项授权（`allowed_actions: fix_ci | resolve_merge_conflicts`）。作用域选项必须同时落到监视选项、`schedule`、闸门探针和一轮的 snapshot，否则闸门仍会为监视无权修复的阻塞项唤醒回合。
- 不做声明式环境准备（Agent Merge 的 `.github/workflows/copilot-setup-steps.yml`）。autofix 的 worktree 仍然不装依赖；那是 `prepare` 的另一项改动。
- 不做"对我创建的 PR 默认启用"，也不做 settings 里的默认监视选项。
- 不改 stacked PR 与 fork 的 eligibility。
- 不新增任何 GitHub 写入面：不发我们自己的 timeline 事件，不做可编辑的状态评论，不开关 auto-merge。所有写入仍走既有助手，`reply` 仍然只创建评论。

## 改动

### 1. `reply.ts`——受阻的一轮也该有一条总结

先算出计划里该 head 尚未记录的 `needsHuman` 行（`freshNeedsHuman`），既用于记录事项，也用于决定总结：

```ts
const summaryDue =
  summary !== null &&
  (freshNeedsHuman.length > 0 ||
    ((summary.handled ?? []).length > 0
      ? summaryHandled.length > 0 || pushUnsummarized
      : state.summarizedSha !== head));
```

不新增状态字段、不改 schema：本来就让 `needsHuman` 在重跑时不增长的那套去重，正好让总结不重复。

### 2. `SKILL.md`——边界与总结规则

- 开头一段：监视把 PR 修到可合并并保持在那里；它从不 approve、改变评审状态、合并或关闭 PR，也不开启 auto-merge；它可以与仓库的 auto-merge 组合。
- 启动确认（Start 第 5 步）多一条同样内容的 bullet，让用户是在职责上限被说明白的前提下同意启动。
- Round 第 7 步的 `summary`：什么都没推送时，只要 `needsHuman` 非空就照发一条——尝试了什么、被什么卡住、需要人决定什么。只有在"没推送、没回答 review 或 issue 评论、且 `needsHuman` 为空"时才为 `null`。去重被明确写成助手的行为，而不是这一轮要自己把握的事。
- `needsHuman` 那条 bullet 说明总结会把这些事项报告到 PR 上。

### 3. 文档

- `docs/users/features/autofix-pr.md`：开头与启动确认段落写明边界；"What a check does" 第 5 步写明受阻一轮的总结。
- `docs/design/2026-10-21-autofix-pr-command.md` 及其中文版：一条非目标、一条确认 bullet、`reply` 的去重规则（第 6.5 节）、一轮对需要人工事项的回答（第 7 节），以及 Replies 的一条 bullet（第 9 节）。

### 4. 测试

- `reply.test.ts`：受阻的一轮在已总结过的 head 上照发；同一份计划不再发；没有新事项的总结仍被跳过；同一 head 上新增事项再发一条；`--no-post` 只记录不发出。第一条断言做过变异验证（关掉新条件后该测试在 `summarySkipped` 上失败）。
- `SKILL.test.ts`：为边界段落、确认 bullet 和总结规则的三句话加 pin。

## 设计决策与理由

- **以"新增的 `needsHuman` 行"为条件，而不是新增状态字段。** `blockedSummarySha` 会重复 `(head, text)` 去重已经知道的信息，还要配套状态校验与迁移。从助手本来就记录的数据推导条件，把改动收敛成一个表达式，并让"重跑同一份计划必然静默"成为结构性事实。
- **该条件对 `summaryDue` 的两个分支都生效。** 既回答评论、又留下人工事项的一轮同样是受阻的；它的总结不该取决于它点名的评论是否已被上一次运行回答过。
- **用一条评论，而不是可编辑的状态面板。** Agent Merge 在合并框里保留面板、每次开工发一条 timeline 事件。要复刻就得引入助手目前没有的 GitHub 写入（编辑评论，或自定义 timeline 事件），还要一套防止它越积越多的标记协议。受阻总结用现有写入面就覆盖了真正要紧的情形——监视变得无声无息。
- **边界要在用户读得到的地方说三次。** brief 的 `## Never` 约束修复 agent；开头段落约束会话；启动确认才是用户真正同意的东西。只写在其中一处，另外两处的读者就只能猜。
- **不写 auto-merge。** 只说明如何组合，绝不去开启：一个会打开 auto-merge 的监视，等于合并没人 approve 的代码，与本次要写明的边界正好相反。

## 约束与风险

- 每个尚无总结的 head 最多额外一条评论；在已总结过的 head 上，每轮新增受阻事项再各一条。新增受阻事项必须有新事件（新的失败 attempt、新的可信评论），而闸门只报告一次、随后由 `handledChecks` / `handledCommentIds` 压掉，所以安静的 PR 不花任何成本，卡住的 PR 也不会围绕同一件事刷屏。
- `--no-reply`（`reply --no-post`）记录同样的状态、什么都不发，行为不变。
- "新增"以 `needsHuman` 列表是否还留着为准：它只保留该监视最新的 20 项（`MAX_NEEDS_HUMAN`）。因此，一份超过 20 行受阻事项的计划，或被后来事项挤出列表的某一项，可能被再报告一次。代价是多一条评论，绝不会成循环：只有闸门报告了新事件，一轮才会运行。
- 闸门探针、游标、推送预算和信任规则都不动。

## 验证

- `cd packages/core && npx vitest run src/skills/bundled/autofix-pr/SKILL.test.ts`——11 通过（此前 9）。
- `cd packages/cli && npx vitest run src/commands/autofix-pr`——16 个文件、482 通过；其中 `reply.test.ts` 32 通过（此前 30）。
- 变异验证：关掉 `freshNeedsHuman.length > 0` 后，新增的受阻一轮测试在 `summarySkipped` 上失败；恢复后通过。
- `packages/core` 的 `tsc --noEmit`：干净。`packages/cli`：73 个错误，全部位于 `src/acp-integration/*` 或 `src/serve/*`，由本 checkout 过旧的 `@qwen-code/acp-bridge` dist 引起；没有一个指向改动文件。
- 未跑全量 `npm run build`：本 checkout 的依赖停在旧 lockfile（`mime` 2.6.0、`ignore` 5.3.2、`playwright-core` 1.58.2），会让 `packages/browser-use` 因与本次改动无关的原因失败。构建与 typecheck 以 PR 上的 CI 为准。
- 所有改动文件的 ESLint 与 Prettier 均干净。

## 验收标准

- 什么都没推送、也没回答评论的一轮，只要留下需要人处理的事项，就发一条总结——在新 head 上如此，在上一轮已总结过的 head 上也如此。
- 重跑同一份计划什么都不发；之后同一 head 上出现新的受阻事项时再发一条。
- `--no-reply` 的监视在两种情况下都不发任何东西。
- skill 开头、启动确认和用户指南都写明：监视从不 approve、改变评审状态、合并、关闭或开启 auto-merge。
- 不新增 GitHub 写入面，不改闸门与游标，不改预算。

## 参考

- GitHub Changelog，2026-10-28：[Agent Merge watches and fixes pull requests in the cloud](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/)
- GitHub Docs：[Getting pull requests ready to merge with Agent Merge](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests)
- GitHub Docs：[REST API endpoints for Agent Merge](https://docs.github.com/en/rest/pulls/agent-merge)
