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

### 1. `reply.ts`——受阻的一轮该有一条总结，直到有一条真的送达

两个刻意分开的键：

- `needsHuman` 保存一轮留给人处理的每个事项，供 `status` 使用。它在任何 POST **之前**写入，所以更晚失败的运行仍会把这份列表留下。它的 `(head, text)` 去重不变。
- `reportedNeedsHuman`（`{ sha, texts }`）记录**已到达 PR** 的总结报告过什么。它只在这条总结发出之后前进，或者在后一次运行认领一条"已送达但响应丢失"的总结时前进——按那条总结自己的 `pendingPosts` 意图里记下的事项，绝不按之后计划的措辞。

触发器读的是第二个键与计划的差集，而不是第一个键：

```ts
const planNeedsHuman = [...new Set(plan.needsHuman)].filter((t) => t !== '');
const reportedBlocked = new Set(
  state.reportedNeedsHuman?.sha === head ? state.reportedNeedsHuman.texts : [],
);
const unreportedNeedsHuman = planNeedsHuman.filter(
  (text) => !reportedBlocked.has(text),
);

const summaryDue =
  summary !== null &&
  (unreportedNeedsHuman.length > 0 ||
    ((summary.handled ?? []).length > 0
      ? summaryHandled.length > 0 || pushUnsummarized
      : state.summarizedSha !== head));
```

总结的意图里带上它所报告的那些行（`PendingPost.needsHuman`），所以认领时标记的正是那些事项。`prepare` 重建 worktree 时把 `reportedNeedsHuman` 与 `summarizedSha` 一起带过去。该字段可选，并像状态里其他字段一样被校验；旧版 CLI 写下的状态文件根本没有它，代价最多是升级后重复报告一次。`status` 不暴露它，所以 `reply` 之外没有读者需要改。

### 2. `SKILL.md`——边界与总结规则

- 开头一段：监视把 PR 修到可合并并保持在那里；它从不 approve、改变评审状态、合并或关闭 PR，也不开启 auto-merge；它可以与仓库的 auto-merge 组合。
- 启动确认（Start 第 5 步）多一条同样内容的 bullet，让用户是在职责上限被说明白的前提下同意启动。
- Round 第 7 步的 `summary`：什么都没推送时，只要 `needsHuman` 非空就照发一条——尝试了什么、被什么卡住、需要人决定什么。只有在"没推送、没回答 review 或 issue 评论、且 `needsHuman` 为空"时才为 `null`。去重被明确写成助手的行为，而不是这一轮要自己把握的事。
- `needsHuman` 那条 bullet 说明总结会把这些事项报告到 PR 上。
- 总结规则还写明：从未到达 PR 的那一条仍然欠着，所以失败的 `reply` 要用同一份计划再跑一次。

### 3. 文档

- `docs/users/features/autofix-pr.md`：开头与启动确认段落写明边界；"What a check does" 第 5 步写明受阻一轮的总结。
- `docs/design/2026-10-21-autofix-pr-command.md` 及其中文版：一条非目标、一条确认 bullet、`reply` 的去重规则（第 6.5 节）、一轮对需要人工事项的回答（第 7 节），以及 Replies 的一条 bullet（第 9 节）。

### 4. 测试

- `reply.test.ts`，两条关于去重的测试：受阻的一轮在已总结过的 head 上照发，同一份计划不再发，没有新事项的总结仍被跳过，同一 head 上新增事项再发一条；以及 `--no-post` 只记录不发出。两条都从"该 head 已被总结过"出发，所以都不可能只靠"每 head 一条"那条路径通过。
- `reply.test.ts`，三条关于送达的测试，正是评审要求的：总结的 POST 从未到达 GitHub 时，这条报告仍然欠着，重跑会把它发出去（然后才把失败记为已处理）；同一次运行中更早的 thread 回复失败，同样留着这条报告；已到达 GitHub 但响应丢失的总结，按它自己的意图被认领、标记为已报告，且不会发第二次。
- `SKILL.test.ts`：为边界段落、确认 bullet 和总结规则的各句话加 pin，包括重跑那句。
- 变异验证：把"送达前就被消耗的触发器"放回去（用 `freshNeedsHuman` 代替 `unreportedNeedsHuman`），恰好两条失败注入测试变红，认领对照组保持绿。

## 设计决策与理由

- **两个键：一个给 `status`，一个给送达。** 第一版实现用 `freshNeedsHuman`（`needsHuman` 列表尚未记录的行）作为总结的触发条件，为的是不新增状态字段。评审指出这会在送达之前就把触发器消耗掉：那份列表在任何 POST 之前写入，所以一条 POST 失败的总结、或一次更早在 thread 回复处就失败的运行，会在每次重跑时被压制，而这一轮却照样把失败记为已处理、闸门也不再报告它们。阻塞会同时从 PR **和**闸门上消失——正是本改动要消除的那种静默。把列表的写入改成惰性被否掉了：那次提前写入对"更晚失败之后 `status` 仍看得到"是承重的。于是改为分离两个关注点，`reportedNeedsHuman` 只在送达或被认领时前进。一个可选状态字段，就是"失败的 POST 无法消耗掉触发器"的代价。
- **该条件对 `summaryDue` 的两个分支都生效。** 既回答评论、又留下人工事项的一轮同样是受阻的；它的总结不该取决于它点名的评论是否已被上一次运行回答过。
- **用一条评论，而不是可编辑的状态面板。** Agent Merge 在合并框里保留面板、每次开工发一条 timeline 事件。要复刻就得引入助手目前没有的 GitHub 写入（编辑评论，或自定义 timeline 事件），还要一套防止它越积越多的标记协议。受阻总结用现有写入面就覆盖了真正要紧的情形——监视变得无声无息。
- **边界要在用户读得到的地方说三次。** brief 的 `## Never` 约束修复 agent；开头段落约束会话；启动确认才是用户真正同意的东西。只写在其中一处，另外两处的读者就只能猜。
- **不写 auto-merge。** 只说明如何组合，绝不去开启：一个会打开 auto-merge 的监视，等于合并没人 approve 的代码，与本次要写明的边界正好相反。

## 约束与风险

- 每个尚无总结的 head 最多额外一条评论；在已总结过的 head 上，每轮新增受阻事项再各一条。新增受阻事项必须有新事件（新的失败 attempt、新的可信评论），而闸门只报告一次、随后由 `handledChecks` / `handledCommentIds` 压掉，所以安静的 PR 不花任何成本，卡住的 PR 也不会围绕同一件事刷屏。
- `--no-reply`（`reply --no-post`）记录同样的状态、什么都不发，行为不变。
- "新增"判的是计划里 `needsHuman` 文本的精确字符串相等，而这段文本由模型撰写，助手只做空白归一化并在 300 字符处截断。因此后一轮把同一个阻塞换个说法，就会再报告一次。真正的限流器是闸门——一轮只在有新事件时才运行——所以代价是多一条评论，绝不会成循环。
- 报告的去重对一个 head 是精确的：`reportedNeedsHuman` 保存已送达总结报告过的每一行，没有窗口。20 项上限（`MAX_NEEDS_HUMAN`）属于 `needsHuman`，也就是 `status` 列出的那份，所以旧事项可能滚出 status 列表，却仍在 PR 上处于已报告状态。
- 闸门探针、游标、推送预算和信任规则都不动。

## 验证

- `cd packages/core && npx vitest run src/skills/bundled/autofix-pr/SKILL.test.ts`——11 通过（本次改动前 9）。
- `cd packages/cli && npx vitest run src/commands/autofix-pr`——16 个文件、485 通过；其中 `reply.test.ts` 35 通过（本次改动前 30）。
- 变异验证：把"送达前就被消耗的触发器"放回去（用 `freshNeedsHuman` 代替 `unreportedNeedsHuman`），恰好两条失败注入测试失败——未送达的总结、以及被更早的 thread 回复挡住的那条——认领对照组与 `--no-post` 用例保持绿。文件从字节级备份还原（比对 sha256），不是从 git 还原，随后套件重新全绿。
- `packages/core` 的 `tsc --noEmit`：干净。`packages/cli`：68 个错误，全部位于 `src/acp-integration/*` 或 `src/serve/*`，来自本 checkout 过旧的 `@qwen-code/acp-bridge` dist；没有一个指向改动文件。把四个改动的 cli 文件换回它们在 `origin/main` 上的内容再跑一次，错误清单完全相同，所以这 68 个都是存量。文件从字节级备份还原并用 sha256 校验。
- 未跑全量 `npm run build`：本 checkout 的依赖停在旧 lockfile（`mime` 2.6.0、`ignore` 5.3.2、`playwright-core` 1.58.2），会让 `packages/browser-use` 因与本次改动无关的原因失败。构建与 typecheck 以 PR 上的 CI 为准。
- 所有改动文件的 ESLint 与 Prettier 均干净。

## 验收标准

- 什么都没推送、也没回答评论的一轮，只要留下需要人处理的事项，就发一条总结——在新 head 上如此，在上一轮已总结过的 head 上也如此。
- 重跑同一份计划什么都不发；之后同一 head 上出现新的受阻事项时再发一条。
- POST 从未到达 PR 的总结——或更早在 thread 回复处就失败的那次运行——仍然欠着：重跑同一份计划会把它发出去，然后才把这一轮的失败记为已处理。
- 已到达 PR 但响应丢失的总结，按它自己的意图被认领、标记为已报告，绝不发第二次。
- `prepare` 重建 worktree 时带上 `reportedNeedsHuman`，而 `status` 不暴露它。
- `--no-reply` 的监视在上述任何情况下都不发任何东西。
- skill 开头、启动确认和用户指南都写明：监视从不 approve、改变评审状态、合并、关闭或开启 auto-merge。
- 不新增 GitHub 写入面，不改闸门与游标，不改预算。

## 参考

- GitHub Changelog，2026-10-28：[Agent Merge watches and fixes pull requests in the cloud](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/)
- GitHub Docs：[Getting pull requests ready to merge with Agent Merge](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests)
- GitHub Docs：[REST API endpoints for Agent Merge](https://docs.github.com/en/rest/pulls/agent-merge)
