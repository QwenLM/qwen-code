# Mesh design review, round 2 — hand-off to the implementing agent

> Reviewed: [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) at `af7fed7021e94b83df3aa013fd4dae3b2a0357e1` (PR #11072)
> Runtime facts checked against `origin/main` @ `703678136a`; Multica against `multica-ai/multica@7a438bd5b`
> Original review method: source reading only. The implementation update and §4 observations explicitly identify the later checks that were executed. Every `file:line` below was read at the commits named above; line numbers drift, symbols do not.
> Audience: the agent that implements §5.2. Read §0 of the design first, then this file.

## 0. Verdict

**Keep the root model; change the contract.** Long-lived body + shared thread + admission/dispatcher split + at-least-once delivery survives source inspection. Round 2 identified three contract problems (C1–C3), not a reason to change the execution model; the implementation update below supersedes C1 and corrects C2's premise.

State at the reviewed commit: the seven files under `packages/core/src/agents/mesh/` at `af7fed70` are byte-identical to the round-1 revision. The §5.1 "verified but uncommitted" patch was not on that branch, and the four named store defects were still present. The implementation update below records the later correction.

### Implementation update (2026-09-07)

- The missing §5.1 patch is committed on #11206; its three named files pass 37 tests, plus targeted lint and core typecheck.
- C1 reproduced as usage rounds `[1, 1]` across two execute segments and is fixed to `[1, 2]` by the runtime preparation merged from draft #11200.
- C2 contained a false premise: current `AgentHeadless.executeTurn` already emits `EXTERNAL_MESSAGE` for resident `task_prompt` continuations, and cold revival seeds `initialUserPrompt`. What was actually missing was durable correlation. The runtime preparation merged from draft #11202 adds `deliveryId` to structured external input, the consumed event, resident structured continuation, and the transcript record.
- I5's boolean ambiguity is fixed by the runtime preparation merged from draft #11204. The design now inserts a minimal dispatcher before the live slice and gives `paused` its actual `resumeBackgroundAgent` path.
- I1, I2, I4, I6, I7, I8, and I10 are corrected in the authoritative design. Their aggregate/storage/dispatcher producers do not exist yet, so no dead optional fields were added to the foundation.
- C3, I3, and S5 remain explicit product decisions. No implementation choice was made for them.

## 1. Runtime facts the implementation must not re-derive

These are the load-bearing seams. Each was read directly.

| Fact                                                                                                                                                   | Where                                                                                                            | Consequence for the mesh                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resumeBackgroundAgent` returns an already-running entry without consuming the continuation message                                                    | `background-agent-resume.ts:783-791`; the `queueMessage` at `:609` fires only when a resume is already in flight | Mid-run delivery is `registry.queueExternalInput`; idle-resident is `continueResidentAgent`; cold is revive/resume. Same split as `tools/send-message.ts:295-341`  |
| `queueExternalInput` returns `false` when not `running` or after `beginFinishing`                                                                      | `background-tasks.ts:1515-1522`                                                                                  | `delivery_race` in the design is the right shape                                                                                                                   |
| Final drain and `beginFinishing` are adjacent synchronous calls                                                                                        | `agent.ts:3576-3586`, `background-agent-resume.ts:1294-1300`                                                     | The finishing window is closed at the runtime; no extra guard needed                                                                                               |
| `EXTERNAL_MESSAGE` is emitted when input is appended to the next request, **before** the model call                                                    | `agent-core.ts:1249-1262`, `:1269-1274`, `:1296`                                                                 | "consumed" means _durably in history_, not _answered_. Write the definition that way                                                                               |
| The transcript writer records external messages synchronously with `fs.writeSync`                                                                      | `agent-transcript.ts:711`, `:838-840`                                                                            | A crash after drain does not lose the message: cold revive replays it                                                                                              |
| `AgentExternalMessageEvent` carries only `kind` and `text`                                                                                             | `agent-events.ts:195-202`, `agent-core.ts:1405-1412`                                                             | A `deliveryId` must be added to the structured `AgentExternalInput` and threaded through `emitExternalInputEvents`                                                 |
| String inputs get the `[Message from parent agent]:` prefix; structured inputs do not                                                                  | `agent-core.ts:1382`                                                                                             | Use the structured form                                                                                                                                            |
| Resident continuation re-enters `runBackgroundTurn` → `runWithAgentContext` on every turn                                                              | `background-agent-resume.ts:1389-1401`, `:1418-1487`; launch path `agent.ts:3738-3760`                           | A nested `runWithMeshRunContext` per turn is valid. `finishingInputs` continuation runs inside the same closure, same run                                          |
| `continueResidentAgent` requires `status === 'completed'`; `continue()` returns `false` for five different reasons                                     | `background-tasks.ts` (`continueResidentAgent`), `background-agent-resume.ts:1419-1450`                          | The dispatcher cannot tell `capacity_wait` from "fall back to revive" from a boolean. Add a typed result                                                           |
| Restart-recovered running agents are registered as `paused`, not `completed`                                                                           | `background-agent-resume.ts:561`                                                                                 | Sweeper "revive once" must call `resumeBackgroundAgent` for `paused`; `reviveCompletedBackgroundAgent` rejects them                                                |
| The concurrency cap **throws** from `register`                                                                                                         | `background-tasks.ts:559`, `:579`                                                                                | The launcher must catch to produce `capacity_wait`. Whether idle resident agents hold a "claimed" slot was **not** verified — read `getClaimedBackgroundSlotCount` |
| The chat is created once and reused; system instruction is fixed at `createChat`                                                                       | `agent-headless.ts:296-299`, `agent-core.ts:588-595`                                                             | There is no per-turn system-role seam. Every continuation enters as user role via `task_prompt`                                                                    |
| Resident continuation prompts are written through `EXTERNAL_MESSAGE`; cold revival also seeds `initialUserPrompt`                                      | `agent-headless.ts:279-288`; `background-agent-resume.ts` (`writerInitialPrompt`, `buildAgentTranscriptAttach`)  | The original C2 transcript-absence claim was wrong. Mesh still needs structured input with `deliveryId` for correlation                                            |
| `USAGE_METADATA.round` is `turnCounter`, which restarts at 0 per `runReasoningLoop`; `roundOffset` only feeds `executionStats.rounds`                  | `agent-core.ts:920`, `:1198`, `:2695`                                                                            | See C1                                                                                                                                                             |
| Usage is recorded once per round from the last chunk, after `ROUND_TEXT` (which carries `usageMetadata` into the transcript) and before tool execution | `agent-core.ts:1099`, `:1195-1210`                                                                               | Transcript-first, event-second: the design's "reconstruct from transcript" direction holds                                                                         |
| Retry inside a stream resets `lastUsage`; compaction's own call emits no usage                                                                         | `agent-core.ts:1050`, `:1058-1067`                                                                               | Token gate under-counts. Call it an accounting limit                                                                                                               |
| `runReasoningLoop` is invoked a second time inside one run when the final drain finds pending input (`executeExternalInputs(..., {resetStats:false})`) | `background-agent-resume.ts:1255-1261`; `agent-headless.ts:246-255`                                              | Any per-run key that uses `round` collides across the two segments                                                                                                 |
| The system prompt is assembled with QWEN.md and auto-memory                                                                                            | `agent-core.ts:2646-2650` (`assembleSystemPrompt` with `getUserMemory`, `getAutoMemoryPrompt`)                   | See I8 and open question 8                                                                                                                                         |
| `save_memory` exists as a tool                                                                                                                         | `tool-names.ts:29`                                                                                               | Must be excluded by the read-only boundary                                                                                                                         |
| Multica's prior session is per `(agent, issue)`                                                                                                        | `handler/daemon.go` `GetLastTaskSession{AgentID, IssueID}`; `daemon/types.go:108`                                | Already corrected in the design                                                                                                                                    |
| Multica allows a run to comment on **another** issue, carrying lineage                                                                                 | `handler/comment.go:1775-1790` (`source_task_id` deliberately not scoped to the run's own issue)                 | See I3                                                                                                                                                             |
| Multica gates every hop on attribution and invocation policy                                                                                           | `comment.go:2261`, `:2352` (`ReasonAttributionBlocked`), `:3158-3212` (`ReasonInvocationNotAllowed`)             | Design §7 records the looser choice; fine                                                                                                                          |

## 2. Findings

Status labels: **closed** (design now matches source), **defect** (design or code is wrong), **product** (a choice the owner must make), **e2e** (cannot be settled by reading).

### Critical

**C1 — defect. `(runId, attempt, round)` charge key collides and silently drops token charges.**
`USAGE_METADATA.round` restarts per `runReasoningLoop`. The runtime itself invokes the loop twice inside one mesh run when the final drain finds pending input (the normal mid-run delivery path). Second-segment rounds 1..n carry the same key as the first segment; the idempotent apply discards them. `agentRound` in the transcript is the same counter, so reconstruction collides too.
Fix (one of): emit `roundOffset + turnCounter` in the event (stats already compute it), or add an execute-segment ordinal (count `START` events per run) to the key.

**C2 — corrected defect. Resident prompts already reach the transcript; durable delivery correlation was missing.**
The original review overlooked the continuation branch in `AgentHeadless.executeTurn` and the cold-revive `initialUserPrompt`. Runtime verification found both prompts in their expected records. Mesh nevertheless must deliver each durable turn window as a structured `AgentExternalInput` with a `deliveryId`, because bare `task_prompt` has no stable consumed watermark and receives the parent-agent prefix. The integrated runtime preparation adds that structured path and correlation metadata without rewriting ordinary background-agent continuation.

**C3 — product + runtime. The "trusted envelope in system/developer role" has no injection point.**
Either state that the envelope is a fixed prefix of a user-role message and that trust comes from ambient binding and provenance, not from role; or schedule a per-turn system-instruction update on `LlmChat` and record the prompt-cache cost (Multica works to keep that cache warm, `daemon/prompt.go` around `PriorSessionID`). Do not claim both.

### Important

**I1 — defect. Same-thread `thread_wait` has no acknowledgement rule.** Only a booked parent dependency event acknowledges a wait. A waits for B on the same thread; B closes with `thread_review` and does not `@A`. At quiescence A's wait counts as "dependency vanished", blocked-class outranks review-class, thread becomes `blocked` instead of `in_review`. Add: a same-thread wait is acknowledged by any later close record or human post on that thread.

**I2 — defect. Failure and unclosed records are acknowledged only by human feedback.** One terminal launch failure pins the thread to `blocked` even after another agent later reviews. The acknowledgement boundary must include any later successful booking, not only a human post.

**I3 — product. A parent agent cannot answer its child.** Mutating tools act only on the ambient thread; `thread_create` only nests under the current one. A child that `thread_block`s wakes the parent assignee, who can only post on the parent. Multica lets a run comment on another issue with lineage (`comment.go:1775-1790`). Decide: allow posting into descendants the run created (still provenance-stamped), or write down that children are unblocked by people only.

**I4 — defect / simplification. Token outbox is both underspecified and unnecessary.** "Admission drains pending charge events for the root" needs a tree scan because source-first events live in the run's thread file. Smaller model: write per-round usage on the run record (same file, atomic), sum `runs[].usage` across the tree under the workspace lock at admission, keep root `tokensUsed` as a cache. `appliedTokenChargeIds`, `chargedUsageRounds`, and the token outbox disappear. Keep the outbox for parent reports and notifications only.

**I5 — defect in the plan. §5.2 step 6 cannot run.** The vertical slice needs a run picker, launch/continue/resume/revive dispatch, `finishRun`, and an outbox consumer to apply the child's report to the parent. Step 5 has none; step 7 is the full reliability build. Insert "6a — minimal in-process dispatcher, no recovery". Also give `continueResidentAgent` a typed result (see §1) so `capacity_wait` is distinguishable.

**I6 — defect. A quiescent thread with no close record and no runnable target stays `in_progress` forever.** The matrix maps only turn/token/queue/unavailable gates to `blocked`. A human post whose assignee is disabled/unknown, or `no_target`, books nothing and changes nothing. Rule: any admission on a non-done thread that books nothing, at quiescence, yields `blocked`.

**I7 — defect. Dispatcher "idle → continue / revive / launch" lacks `paused`.** See §1. The sweeper path in §4 is wrong as written for restart recovery.

**I8 — defect. Read-only boundary omits `save_memory` and the context files.** Auto-memory is a persistent write channel shared with every session; a mesh agent writing it is a cross-agent, cross-session injection path that bypasses decision 1. Decision 2 must list it as excluded.

**I9 — process, resolved.** At the reviewed commit, §5.3's "3 files, 37 tests passed" referred to a patch that was not on the branch. The patch and evidence are now on #11206.

**I10 — defect. FIFO key `queuedAt` is caller wall-clock.** `postMessage` uses `options.now ?? Date.now()`; tool calls run in the agent process, REST in the daemon. Use a sequence issued under the workspace lock as the primary key.

### Suggestions

- **S1** Infer waiting: clean exit with a live dependency = waiting, without = unclosed. Keep `thread_wait` as explicit intent but drop the rejection path; a rejected wait costs another model turn.
- **S2** Deduplicate `thread_create` after replay by (parent, normalised title) and return the existing child. Cheaper than UI collapse and avoids double budget.
- **S3** Record in §9.5 that compaction calls and pre-retry stream usage are outside `USAGE_METADATA`.
- **S4** Decision 17 lets a parent at 11 turns hand a child 1 turn; the assignment trigger then trips the gate immediately. Floor it or document it.
- **S5** A human `@bob` on a thread blocked by alice's question acknowledges alice's blocker; the question can be dropped silently. Consider acknowledging only blockers from the targeted agents or the assignee.
- **S6** = C2 fix.
- **S7** If `appliedTokenChargeIds` survives I4, store a high-water mark per (runId, attempt, segment) instead of an unbounded id set.

### Closed since round 1 (why)

- `resumeBackgroundAgent` entry point: §0.1/§1 now name the three-way split used by `send-message.ts`.
- Finishing window: closed at the runtime (adjacent drain + `beginFinishing`) and handled as `delivery_race`.
- Multica per-(agent, issue) session, polling fallback, `decidePostMergeMiss` replay: all stated correctly now.
- Turn gate per thread / token per tree, `coalesce(running)` charging, system-authored parent event bypassing `self_trigger`, assignment through admission, no-defer justification, global FIFO: correct in the design; none of it is in the PR code.
- ALS per-turn seam: verified valid; the mesh launcher must own its copy of `runBackgroundTurn` or a hook, since the existing one is a closure.

## 3. Minimal change set, in order

1. C1: cumulative round in `USAGE_METADATA` or a segment ordinal in the key.
2. C2/S6: mesh deliveries use structured external input with `deliveryId`; ordinary resident prompts were already transcripted.
3. C3: product decision pending; do not implement either transport yet.
4. I4: derive tokens from run records; delete the token outbox and both id lists.
5. I1, I2, I6: three lines in the aggregation rules.
6. I5, I7: add step 6a; typed result from `continueResidentAgent`; `paused` branch.
7. I8: exclude `save_memory`.
8. I3 and S5: product decisions pending; keep both explicit in §9.
9. I9: fixed by keeping the patch and its evidence on #11206 and updating §0.2.
10. I10: allocate `queueSequence` under the workspace lock in storage step 3; never sort by `queuedAt`.

## 4. What only an end-to-end run can settle

Run these on a machine that can build. Report the observed value, not "passed".

1. `getClaimedBackgroundSlotCount` with N idle resident agents: does an idle `completed` resident hold a slot? Decides whether the cap is roster-size or throughput.
2. `continueResidentAgent` → `false` while the resident is still registered, followed by `reviveCompletedBackgroundAgent`: does a second runtime get instantiated for the same agent? Check `registry.get(agentId)` identity and the resident map before/after.
3. Deliver via `queueExternalInput` immediately after the model's last tool round: confirm the final drain picks it up and `executeExternalInputs` runs as a second segment; capture the `USAGE_METADATA.round` sequence across both segments (this is the C1 reproduction).
4. Cold revive after two resident continuations: dump the replayed history and confirm which user turns are missing (C2 reproduction).
5. The two negative cases the design already lists: ping-pong between two _running_ agents on one thread tripping the turn gate, and `queueExternalInput(false)` being rebooked.
6. Targeted tests for the parked patch, named files only: `src/agents/mesh/mentions.test.ts`, `dispatch-policy.test.ts`, `thread-actions.test.ts` under `packages/core`. Do not run directory sweeps.

### Observations from the implementation pass

These are the values observed in targeted runtime harnesses. They are not a claim that the still-unbuilt mesh launcher/dispatcher has run end to end.

1. With cap `1`, three `completed` resident runtimes leave `canStartBackgroundAgent() === true`; registering one new running agent succeeds. Idle residents therefore do not claim throughput slots.
2. The ambiguous boolean path was removed before a duplicate-runtime failure could be made a supported contract. The observed typed outcomes are: `capacity_wait` does not attempt cold revival; `continued` reuses the same resident (`createAgentHeadless` remains at one call); `fallback` is reserved for an unavailable resident and permits reconstruction. The exact old "false while still registered, then revive" race remains unobserved rather than blessed.
3. The reproduced two-segment usage-round sequence was `[1, 1]`; after the integrated runtime fix it is `[1, 2]`.
4. Cold-revive reconstruction produced, in order, `original task`, the tool call/result, `working`, `and another thing`, `still working`, `one final constraint`. Both external user turns were present; zero were missing. Structured mesh delivery additionally records its `deliveryId`. This corrects C2 rather than confirming it.
5. Admission tests observed the running coalesce increase the local turn count to the limit, and the following agent trigger returned `turn_budget_exhausted`. The `queueExternalInput(false)` detach/rebook half cannot execute until §5.2 step 6 creates the dispatcher, so it remains an explicit vertical-slice assertion rather than a reported pass.
6. The three named mesh test files produced exactly `3 files, 37 tests passed`.

## 5. Open question 8

**Who controls a mesh agent's system prompt.** Decision 4 scopes trust to the workspace and §3 keeps thread text out of the repo because it is an injection surface. But every agent's system role is assembled from repo-controlled QWEN.md, the agent definition file, and auto-memory written by other sessions (`agent-core.ts:2646-2650`), at higher trust than any thread post. A `git pull` in another terminal silently changes every agent's system prompt while the resident body still holds the old one. §9.4 hashes the definition only; QWEN.md and auto-memory have no version, no gap marker, no provenance. I8 is the write side of this; the read side needs a version stamp in the run record.

<details>
<summary>中文摘要</summary>

结论：根模型保留，改契约。C1 已复现为 `[1, 1]` 并修成 `[1, 2]`；C2 的原前提被运行验证推翻，resident 输入本来就会进入 transcript，真正缺的是 `deliveryId` 关联；C3 仍需产品拍板。Important 项已写回权威设计：聚合规则补齐三处，token outbox 删除，第 6 步前补最小 dispatcher，`paused` 单独恢复，排除 `save_memory`，FIFO 改用锁内序号。§5.1 patch 已进入拆分后的 mesh 分支。开放问题扩展为 11 个，其中 C3、I3、S5 明确保留给人决定。§4 的六项检查已记录实际观测值；尚无 dispatcher 的部分明确标为未执行。

</details>
