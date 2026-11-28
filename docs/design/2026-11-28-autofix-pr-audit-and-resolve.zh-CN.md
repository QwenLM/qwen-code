# `/autofix-pr`：内建无方向/对抗审计、本地真实环境验证、`--audit` 与 Fail-Closed 线程 Resolve

[English](2026-11-28-autofix-pr-audit-and-resolve.md) | [简体中文](2026-11-28-autofix-pr-audit-and-resolve.zh-CN.md)

状态：已实现。扩展自
[`2026-10-21-autofix-pr-command.zh-CN.md`](2026-10-21-autofix-pr-command.zh-CN.md)
与
[`2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md`](2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md)。

## 1. 动机

对维护者真实工作区中 65 个历史 PR 会话的实证分析显示，现有 `/autofix-pr`
单轮修复契约与复杂 PR 达到可合入质量的真实闭环之间存在 5 处结构性差距：

1. **Fix Brief 验证标准过浅。** 仅跑最窄单元测试会漏掉大量在单测全绿后才暴露的缺陷——这些缺陷实际是通过多轮无方向 diff 审计（漏改的同源调用点、未接线的死开关、契约/文档漂移）、对抗审计（边界输入、竞态、清理回滚、检验测试是否真正承重）以及本地真实环境验证（真实构建产物、真实子进程/daemon、临时 git 仓、无头浏览器）挖出来的。
2. **安静 PR 无法主动发起审计。** PR 刚提交或暂无新评论/CI 报错时，`snapshot`
   返回 `wait`，`/autofix-pr` 直接退出，无法按需跑一轮深度审计与实测。
3. **重复执行重型本地 `/review`。** 本地修复轮偶尔调用 `/review` 或
   `qwen review run`，而 CI 在每次 push 后本身就会运行正式评审，本地重复做既慢又消耗尝试预算。
4. **评论清账与线程收口不完整。** 评审者与验证工具常把 findings 或延后清单写在
   `review` 正文或可信 `issue_comment` 验证报告（如 `Verdict: findings`）中；维护者也期望已验证并推送修复的评审线程自动
   `resolve conversation`，而 v1 规则完全禁止 resolve 线程。
5. **长周期 PR 与重型实测预算偏紧。** 复杂 PR 常需 10–17 轮迭代，包含构建 +
   多轮审计 + 本地真实环境验证的单轮容易触达原 30 分钟后台修复上限。

## 2. 设计决策

### 2.1 默认内建多轮无方向/对抗审计 + 本地真实环境验证

`packages/core/src/skills/bundled/autofix-pr/SKILL.md` 中的 fix brief
在提交前默认强制三阶段闭环：

1. **全量事件清账（`## What to do`）**：
   - 处理冲突与 `baseBehind` 合并时，保留双方有效改动并核对跨文件契约、schema、版本号与棘轮上限。
   - 区分聚合汇总 CI job 与实际失败子 job，准确分辨 PR 缺陷与外部基础设施/runner 负载 flake/base 基线自坏。
   - 覆盖行内 `review_thread`、`review` 正文中的 findings/deferred 清单，以及可信 `issue_comment` 中的验证报告（如 `Verdict: findings`、`F1..Fn`）和维护者追问；同时区分纯程序性 bot 状态提示（如 CI-pending downgrade），避免无意义改代码。
2. **多轮无方向审计与对抗审计（`## Audit until clean`）**：
   - **无方向审计**：不带预设检查表通读相对 `<remote>/<baseRefName>` 的完整 PR diff 与邻近调用方，排查漏改调用点、未接线的死开关、契约/文档（含仓库要求的双语设计文档）漂移与合并副作用。
   - **对抗审计**：假设现有实现与测试都有错，主动用边界输入、路径/平台边缘情形、并发/重启/断连/失败清理、旧格式兼容等反例攻击，并检验测试是否真承重（删或破坏修复能否打红测试，而非 mock 假绿）。
   - **收敛门控**：每修一个 PR 范围内的真实缺陷，补回归测试、重跑受影响检查并重置干净计数。非平凡代码改动需**连续 2 轮干净**（上限 5 轮，超限未收敛则停止扩改并如实报告残余风险）；纯文档/极小配置改动 1 轮仔细干净通读即可。
   - **禁止本地 `/review`**：`## Never` 明确禁止运行本地 `/review` skill 或 `qwen review run`，正式评审交由 CI 完成。
3. **构建、静态检查与本地真实环境验证（`## Verify in a real environment, then commit`）**：
   - 按仓库文档运行受影响构建（多包仓库先建上游包，避免消费陈旧 `dist/`）、针对性测试、lint 与 typecheck。
   - **本地真实环境验证**：单测与静态检查全绿后，以尽量少的 mock 覆盖本 PR 触及的真实运行边界（真实构建产物/CLI、真实子进程/本地服务、临时 git 仓与文件系统、无头浏览器/UI 或合并树）。实测挖出缺陷则修根因、补永久回归测试并重置审计收敛；若改动无运行时边界或本机确实缺少前提（如特定 OS/外部服务），如实报告具体未覆盖项，绝不把单测绿冒充真实环境已验。
   - 提交前停止所有自建后台子进程/本地服务、释放端口并删除未忽略临时产物，保持工作树干净。

### 2.2 主动审计模式 `--audit`

`/autofix-pr` 新增 `--audit` 选项：

- 单轮语义（与 `--once` 对称）：只跑一轮前台检查与审计、不创建定时任务、不干扰已有运行中的 watch、若为本轮新创建则在结束时清理。与 `--watch` / `--every` 互斥，可与 `--in-place`、`--no-reply`、`--no-resolve`、`--yes` 及自由文本指令组合。
- 与 `--once` 的区别：当 `snapshot` 返回 `action: "wait"`（暂无新评论、CI 失败或冲突）时，`--audit` 不退出，而是进入修复 agent 对完整 PR diff 执行多轮无方向 + 对抗审计和本地真实环境验证。
- 若干净无修改（`commits` 为空且 `verified: true`），跳过 `push` 与 `reply` 并输出单行简洁报告；若产出已验证的新提交，则沿标准 `sync` → `push` → `reply` 链路推送并汇总。

### 2.3 `autofix-pr reply` 的 Fail-Closed 线程 Resolve（及 `--no-resolve`）

resolve 线程的写操作严格收敛在确定性 helper
（`packages/cli/src/commands/autofix-pr/reply.ts`）内部；模型依然绝不允许直接调用带写方法的 `gh api` 或 GraphQL。

- `ReplyPlan.replies[i]` 新增可选布尔字段 `resolve?: boolean`。skill 仅在线程对应的修复在本轮**已验证并成功推送**（`outcome: "fixed"` 且有推送提交）时设为 `"resolve": true`；`declined`、`needs_human` 或未推送轮次一律不设。
- `autofix-pr reply` 支持 `--resolve`（默认 `true`，`--no-resolve` 置为 `false`）。`schedule` 持久化 `watch.resolve`（`--no-resolve` 写为 `false`），在定时 tick prompt 和 `BackgroundFix.followUp()` 中透传 `--no-resolve`，在 `schedule --again` 时保留该配置；当 `watch.resolve === false` 而定时轮次调用 `reply` 漏传 `--no-resolve` 时拒绝 `plan_invalid`。缺省该字段的旧状态文件默认按 `true` 处理。
- 线程 resolve **仅在**线程回复、总结评论与 `handledCommentIds` 全部持久化之后执行，并在调用 GitHub GraphQL `resolveReviewThread` 前强制通过全部 fail-closed 门禁：
  1. `post === true`（`--no-post` 时以 `no_post` 跳过）。
  2. `resolve !== false`（`--no-resolve` 时以 `disabled` 跳过）。
  3. `state.pushedShas.includes(head)` **且**本轮 prepared snapshot（`autofix-pr-<n>-snapshot.json` 或后台修复认领后的 `autofix-pr-<n>-fix-snapshot.json`）存在且 `headSha !== head` —— 证明本轮在读取该线程之后确实推送了新 head，防止后续未推送的轮次误关在同一已推 head 上新开的线程（否则 `not_pushed`）。
  4. `pr.headRefOid === head` —— GitHub 实时 PR head 与已推 head 一致（否则 `head_mismatch`）。
  5. 线程存在且有合法 GraphQL id（否则 `thread_not_found`），且当前处于未关闭状态（已关闭则幂等跳过并记 `already_resolved`，绝不调用 `unresolveReviewThread`）。
  6. 线程上存在本计划匹配的回复（本次刚发，或线程中已有 `isOwnReply` 且 `bodyHash` 匹配的评论）且 `reply.handled` 全部已入 `done`（否则 `not_replied`）。校验 `bodyHash` 可防止后续推送轮次误关闭先前回复过 `"Needs a human decision"` 的旧线程。
  7. 线程内不存在未进入 `done` 的新可信追问评论（否则 `new_comment_in_thread`）。
  8. GraphQL `resolveReviewThread` 通过 `ghWithInput` 走 stdin JSON（`gh api --method POST graphql --input -`，杜绝参数注入），校验 `!errors?.length` 并后验 `data.resolveReviewThread.thread.isResolved === true`。单条失败（`graphql_error`、`not_resolved`、`request_failed`）隔离记录进 `resolveSkipped`，绝不丢失已发回复与已持久化状态；重跑同一计划可幂等补完 resolve 且不重复发帖。
- `ReplyOutcome` 新增 `resolvedThreads: string[]` 与 `resolveSkipped: Array<{ replyTo: number; reason: ResolveSkipReason }>`。

### 2.4 放宽长周期 PR 与重型实测预算

为支撑长周期 PR 多轮迭代以及含构建 + 审计 + 真实环境验证的单轮耗时：

| 预算项                                            |    原值 |      调整后 |
| ------------------------------------------------- | ------: | ----------: |
| `MAX_PUSHES`（`state.ts`）                        |      10 |      **20** |
| `FIX_TIME_LIMIT_MS`（`autofix-pr-grants.ts`）     | 30 分钟 | **60 分钟** |
| `FIX_CLAIM_DEADLINE_MS`（`autofix-pr-grants.ts`） | 40 分钟 | **70 分钟** |
| `FIX_MAX_AGE_MS`（`fix.ts`）                      | 45 分钟 | **75 分钟** |

原有安全差值不变量（`FIX_CLAIM_DEADLINE_MS = FIX_TIME_LIMIT_MS + 10 分钟`，`FIX_MAX_AGE_MS = FIX_CLAIM_DEADLINE_MS + 5 分钟`）保持不变。

## 3. 非目标与保留的安全边界

- 依然绝不批准 PR、不修改 review 状态、不合并/关闭 PR、不开启 auto-merge、不编辑 PR 标题或正文、不强推。
- 依然绝不 unresolve 评审线程，也绝不响应不可信作者的评论。
- 定时 `tick` 轮次在 `wait` 时保持完全静默（绝不在无显式 `--audit` 时于安静 PR 上空转）。
- `authorCanPush === false` 依然仅允许单轮运行（`--once`、`--audit` 或一次性 `--in-place`）并强制人工确认。

## 4. 验收标准

1. `SKILL.md` 与 `SKILL.test.ts` 明确并钉住默认无方向 + 对抗审计（连续 2 轮干净，上限 5 轮）、本地真实环境验证与清理、禁止本地 `/review`、全覆盖 `review` 正文与可信 `issue_comment` 清账、`--audit` 在 `wait` 时触发、仅对已推修复设 `resolve: true`、`--no-resolve` 与新预算值。
2. `reply.test.ts` 覆盖 GraphQL 正向 resolve 与全部 fail-closed 跳过原因（`no_post`、`disabled`、`not_pushed`、`head_mismatch`、`already_resolved`、`not_replied`、`new_comment_in_thread`、`graphql_error`、`not_resolved`、`request_failed`）、幂等重试以及 `watch.resolve === false` 强制校验。
3. `chain.integration.test.ts` 通过 `fake-gh` 端到端证明 `prepare` → `snapshot` → 修复提交 → `push` → `reply` 真实 resolve 已修复线程、保持 declined 线程打开，并在 `--no-resolve` 下不关闭线程。
4. `schedule.test.ts`、`state.test.ts`、`fix.test.ts` 与 `autofix-pr.test.ts` 覆盖 `watch.resolve` 持久化、`--no-resolve` 经由 `schedule`/`reply`/`autofix_pr` 工具/`BackgroundFix.followUp()` 的全链路透传、旧状态文件兼容以及 20 次推送 / 60-70-75 分钟新预算。
