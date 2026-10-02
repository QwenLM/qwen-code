# Workspace agent token budget: failure/replay acceptance

Hands-on check for the budget contract on PR #11206 (`d8e418c5aa` and later).
Nothing below has been run yet. The author's box cannot build or run a model,
so every expected value here is derived from the code, not observed.

## The contract under test

- **Admission.** Once a thread tree has spent `DEFAULT_THREAD_TOKEN_BUDGET`,
  an agent-authored post books no run (`token_budget_exhausted`). A person's
  post still books.
- **While running (new).** On each dispatch pass the host records every
  running run's spend so far. When the tree is at or over budget, it moves
  the agent-triggered running runs to `cancelling` with
  `error: token_budget_exhausted`. The ordinary cancel path then stops them.
  The overshoot is bounded by one pass's spend (the host ticks every 1 s).
- **Person-triggered runs** are never stopped by the budget.
- **Retention (#12854 `c70a17dd55`).** Trimming a run that spent tokens folds
  its spend into `trimmedTokens`, so the tree total never goes down.

## Setup

1. Build the daemon from the PR head (`npm install && npm run bundle`).
2. Lower the budget so a real model reaches it quickly. Temporarily set
   `DEFAULT_THREAD_TOKEN_BUDGET` in
   `packages/core/src/agents/workspace-agents/types.ts` to `20_000` in the
   local build only, and do not commit it. Then **re-run `npm run bundle`**:
   esbuild inlines the constant into the artifact, so editing the source after
   step 1 changes nothing in `dist/`. Confirm the edit landed before going on —
   `grep -c 'DEFAULT_THREAD_TOKEN_BUDGET=2e4' dist/chunks/*.js` must be
   non-zero (a stale artifact still reads `1e6`).
3. Start the daemon step 2 rebuilt, from the checkout root and in a scratch
   workspace:
   `QWEN_CODE_ENABLE_AGENT_COLLABORATION=1 node dist/cli.js serve`. Not a bare
   `qwen serve` — that runs whichever installed release `PATH` resolves to,
   which contains none of this PR, so the tag is absent, every `agent/*` route
   404s, and the matrix reads as a budget-contract failure. Confirm
   `GET /capabilities` lists `agent_collaboration_v1` before starting row 1.
   Create two agents, `lead` and `helper`.

## Matrix

| #   | Scenario                                                                                    | Expected                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Post `@lead` asking for a long task that makes `lead` hand work to `helper` back and forth  | Before the tree passes 20k, runs proceed. Once the tree passes it, the next pass marks the running agent-triggered run `cancelling` / `token_budget_exhausted`, and it ends `cancelled`. The thread shows `blocked`. Tree total ≤ 20k + one pass's spend. |
| 2   | After 1, `helper` posts (agent-authored)                                                    | Admission refuses with `token_budget_exhausted`; no run is booked.                                                                                                                                                                                        |
| 3   | After 1, a person posts `@lead continue`                                                    | A run is booked and keeps running past the budget; it is not cancelled.                                                                                                                                                                                   |
| 4   | Kill the daemon (`kill -9`) while a run is mid-turn, with the tree near the budget; restart | The replayed attempt's spend is charged: `usageByRound` has an entry for each attempt. If the tree is over budget, the replayed agent-triggered run is stopped within one pass.                                                                           |
| 5   | Kill the daemon while a run is `cancelling` for budget; restart                             | The run ends `cancelled`, keeps `error: token_budget_exhausted`, and is not re-dispatched.                                                                                                                                                                |
| 6   | Drive a thread past 200 runs (lower `MAX_THREAD_RUNS` locally if needed)                    | The thread file stops growing in runs; `trimmedTokens` > 0; the tree total at admission equals the pre-trim total.                                                                                                                                        |

For each row, record: tree total before and after, the run's final
`status` / `error`, and the thread `status` / `reason`
(`GET /workspaces/:ws/agent/threads/:id`). The `budget.tokensUsed` that route
reports is the same total admission enforces — it includes `trimmedTokens`, so
it must not drop when row 6 trims.

## Remote Agent Hosts (#12582)

A Host running Qwen Code reports its attempt's spend (the session total minus
the total when the turn started) with every progress post, about every 2 s,
and with its result. The coordinator records it, so admission and the running
check both count remote spend, and a remote run stopped for budget ends when
its next lease renewal is refused. Codex and Claude Code runs report no spend
and are still uncharged. Add a row to the matrix: bind `lead` to a remote Host
and repeat row 1.

## Report back

Post the filled matrix as a comment on #11206, noting the head SHA you ran.
Call out any row where the tree total exceeded the budget by more than one
turn's spend. That would contradict the "bounded by one pass" claim in
`dispatcher.ts` (`enforceTreeBudgets`).

---

中文摘要：本文是 #11206 预算契约的验收交接说明，以上内容均未实际运行。在本地构建里把 `DEFAULT_THREAD_TOKEN_BUDGET` 临时调低到 20k（不要提交），然后按矩阵逐行验证：

- 运行中超预算时，由 agent 触发的 run 会在一个周期内被取消；
- 由人触发的 run 不会被预算截断；
- 崩溃重放的用量会被计入；
- 线程超过 200 个 run 后，裁剪不会让树的总用量下降。

结果请以评论形式贴回 #11206，并注明跑的是哪个 head SHA。
