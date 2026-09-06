# Mesh implementation — step-by-step acceptance criteria

> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) §5.2 (ten steps, as numbered on the `codex/multi-agent-mesh-foundation` branch) and [`2026-09-07-mesh-review-round2-handoff.md`](./2026-09-07-mesh-review-round2-handoff.md).
> Delivery shape: **one PR to main** (#11206), fed by sub-PRs based on its branch. Runtime changes #11200 / #11202 / #11204 are the first three sub-PRs; see §4 for the order and the CI caveat.
> Nothing in this file was executed by its author. "Evidence" means what the implementer reports, with observed values, in the PR description or a `docs/verification/mesh/` package.

## 0. Corrections to the round-2 hand-off

- **C2 was wrong as stated.** `AgentHeadless.executeTurn` emits `EXTERNAL_MESSAGE` for a continuation `task_prompt` (`agent-headless.ts:279-288` at `703678136a`), and the transcript writer records that event. The reviewer read `:290-300` and missed the branch above it. The implementer reproduced cold-revive history with both continuation prompts present. What remains true: bare `task_prompt` has no delivery id and gets the parent-agent prefix, so mesh turns use structured input (#11202). The hand-off on this branch already carries the correction.
- **C1 is confirmed and fixed** (`[1, 1]` → `[1, 2]`, #11200).
- **Observation 1** (idle residents do not hold slots) settles the round-2 "verify" item on the concurrency cap.

## 1. How to read the steps

Each step lists: what lands, the acceptance gate, and the evidence to report. A step is done when its gate holds on CI for the whole branch, not when its own tests pass locally. Steps 1-6 need no model; 7 is the first live gate; 8-10 need the daemon or a browser.

Every step also updates the design doc: any sentence the implementation contradicts is changed in the same commit, with the reason. The doc is the contract; the code does not silently redefine it.

## 2. Steps

### Step 1 — Admission foundation (landed on this branch)

Gate: the three mesh test files pass on CI; `THREAD_STATUSES` includes `blocked`; a missing or invalid root fails closed; `countQueuedElsewhere` counts `queued` only; a human post on a child does not touch the root's `autoTurnsUsed`; unknown `@name` yields `agent_unknown` and does not wake the assignee; a post with no target yields `no_target`; `coalesce(running)` from an agent charges one turn.
Evidence: the test names covering each clause. Currently 37 tests; keep the count in §5.3 current.

### Step 2 — Read-only capability boundary

Lands: a built-in allowlist for `run_shell_command`, intersected with the agent definition's tool list; an explicit deny list containing `save_memory`, `write_file`, `edit`, and every tool that persists outside the process; `thread_*` tools are added on top of the definition, never taken from it.
Gate: a table-driven test enumerates every registered tool name in core and asserts it is either allowed, denied, or `thread_*`; adding a new tool to core without classifying it fails the test. The shell predicate refuses every command the AST classifier does not return `read-only` for, with tests for allowed and refused commands.
Deferred to step 4/5: proving the refusal happens in the tool layer. `executionAllowedTools` is name-level, so a per-command predicate needs an invocation-time hook that arrives with the launcher (see the steps 2-3 brief §2).
Evidence: the classification table, committed as data, not prose.

### Step 3 — Versioned storage protocol

Lands: `schemaVersion` on every file; fail-closed on unknown version; migration under the workspace lock with the old file retained until the new one validates; the workspace mutation lock; lock-issued `queueSequence` and message `sequence`; `runs[].usageByRound` on the run record; outbox for parent reports and notifications only; deletion refusal for non-terminal runs, descendants, and unacknowledged outbox events.
Gate: (a) writing a file with `schemaVersion + 1` makes every read throw, never return empty state; (b) a crash injected between "write source" and "acknowledge" replays exactly once, proven by a test that kills the apply mid-way and re-runs reconciliation; (c) two processes posting concurrently receive strictly increasing `queueSequence`, tested with two `child_process` workers, not two promises; (d) token gate at admission equals the sum of `usageByRound` across the tree, tested with a tree of depth 3 where the root file carries a deliberately stale `tokensUsed`.
Evidence: the four tests named, plus the migration test with a hand-written v1 fixture.

### Step 4 — Hidden host session, keepalive, launcher

Lands: one hidden `Config` + registry per workspace; keepalive registration reusing `scheduled-task-keepalive.ts`; `launchMeshAgent(agent)` that builds the persona through `convertToRuntimeConfig` and starts a background agent; typed launch results `started | capacity_wait | agent_unavailable | launch_failed`.
Gate: (a) with `QWEN_CODE_MAX_BACKGROUND_AGENTS=1`, launching a second agent returns `capacity_wait` and books nothing; (b) an agent whose `agentType` names no definition returns `agent_unavailable` and no runtime is created; (c) the host session does not appear in the session list API; (d) after the reaper closes the host session, keepalive reloads it and the next launch succeeds without a daemon restart; (e) `continueResidentAgent` returns `continued` for a completed resident and `capacity_wait` never triggers a cold revive (#11204's tests, now on this branch).
Evidence: (d) is the one that needs the daemon; report the reaper timeout used and the observed reload latency.

### Step 5 — Run envelope, tools, runtime correlation

Lands: `runWithMeshRunContext` at the per-turn seam; `thread_post`, `thread_wait`, `thread_block`, `thread_review`, `thread_create`, `thread_read`; the prompt assembler; structured external input with `deliveryId` (#11202, folded); `consumedMessageIds` recorded from the correlated event; `usageByRound` upserts from `USAGE_METADATA` with cumulative rounds (#11200, folded).
Gate: (a) a mutating tool invoked with a model-supplied `threadId` argument is rejected by schema, and one invoked outside a run context is rejected at execution; (b) `thread_create` under thread A from a body whose previous turn was on thread B creates the child under A, tested by running two turns on one `AgentHeadless` instance; (c) `thread_wait` without a live dependency returns a typed rejection; (d) the assembled prompt for a second wake contains title, body, status, the last N posts, and the delta after `committedThroughSequence`, and a retention gap renders the GAP line; (e) a `USAGE_METADATA` sequence across a `finishingInputs` continuation records rounds `[1, 2]` on one run.
Evidence: the assembled prompt text for cases first-entry / delta / gap / retry, committed as snapshot fixtures.

### Step 6 — Minimal in-process dispatcher, no recovery

Lands: pick the lowest `queueSequence` queued run per agent; branch on registry state `completed+resident → continue`, `completed → revive`, `paused → resume`, `unbound → launch`; `startRun` / `finishRun`; consume the parent-report outbox; leave `capacity_wait` queued.
Gate: with a fake `AgentHeadless` that answers scripted text, (a) an assignment trigger on an open thread results in exactly one `startRun` and one `finishRun`; (b) two threads queued for one agent start in `queueSequence` order regardless of file enumeration order (test by creating the later thread with a lexically smaller id); (c) a child `thread_review` produces exactly one parent post carrying the event id, and re-running the consumer produces zero more.
Evidence: the three tests. No live model.

### Step 7 — Live vertical slice (first integration gate)

Lands: nothing new; this is a run.
Gate: the §8 demo steps 1-5 complete against two real agents on a build-capable machine, plus: a forced `queueExternalInput` miss (kill the agent between its last tool round and finish) is rebooked and delivered on the next run; a synthetic ping-pong between two *running* agents on one thread stops at 12 with `turn_budget_exhausted` in the thread and one channel-less notification record.
Evidence: the thread JSON files after the run, the two agents' transcript slices, and the observed wall-clock between the child's `thread_review` and the parent's wake. If any prompt in §6 had to change to make the model close its run explicitly, the changed prompt and the failure it fixed.

### Step 8 — Dispatcher reliability

Lands: `delivery_race` detach/rebook; `launch_failed` with `failureStage`; done/cancel (`cancelling` state, runtime abort); restart recovery (`running` → reconcile → resume once → terminal on second failure); stall sweeper; full outbox replay on startup.
Gate: failure injection at each named point, as separate tests: enqueue returns false; process exit after `acceptedMessageIds` write; process exit after transcript record but before `consumedMessageIds` write; process exit after parent apply but before acknowledge; daemon restart with one `running` and one `queued` run; N-minute stall. Each test asserts the thread file's final state and that no message id is both unconsumed and unbooked.
Evidence: the injection matrix as a table in the PR, one row per test, with the asserted final state.

### Step 9 — REST and Web Shell

Lands: routes for agents, threads, posts, runs; roster, thread list, thread view with run slices, busy reason, gate/failure display, cancel; #11140's sidebar entry absorbed.
Gate: Playwright visuals for roster, thread view with two agents' posts attributed by name snapshot, a `blocked` thread with its question, and a run slice rendered from `transcriptStartOffset..EndOffset` showing only that run; deleting an agent keeps old posts readable with the tombstoned name.
Evidence: screenshots from the visuals config, in CI.

### Step 10 — Channel notifications

Lands: four events to the channel workers.
Gate: with one configured channel, each event produces exactly one message, and a replayed outbox after a simulated crash produces at most one duplicate and never zero.
Evidence: the channel transcript.

## 3. Product decisions the implementer must not make

Open in §9 of the design: envelope role transport (§9.9), parent-to-child replies (§9.10), human blocker acknowledgement scope (§9.11), token reservation vs accounting (§9.5), persona drift policy (§9.4). Until each is decided the implementation takes the conservative reading: user-role envelope, ambient-thread-only mutation, acknowledgement of every open blocker on a human post that books, accounting limit with overshoot, definition read at revive only.

One more decision that predates all of these: the relationship between this subsystem and the agent board in #9402. Both are filesystem-backed shared work items under the runtime dir with per-item locks. Decide before step 3 whether the board becomes the thread store, the thread store supersedes the board, or they stay separate with a documented reason. Two stores for the same concept is the outcome to avoid.

## 4. Working as a stack under one PR

- #11206 is the only PR that merges to `main`. Every step lands as a **sub-PR whose base is `codex/multi-agent-mesh-foundation`**, merged into that branch with an ordinary merge commit (no squash; the integration bot squashes #11206 at the end).
- **A PR based on the mesh branch runs no unit tests and no lint** in this repo (`ci.yml` triggers on `main` and `release/**` only). The gate for every sub-PR is therefore #11206's CI *after* the merge. Merge one sub-PR, watch #11206's run, then merge the next; never merge several and read one run.
- Runtime preparation is part of the stack: merge order #11200 → #11204 → #11202. #11202 conflicts with #11204 in the resident-continuation tests and must be merged onto it first.
- Merge `main` into the mesh branch when it falls behind; never rebase (repo policy, and the force-push bot).
- Keep the design doc and this file current in the same commit as the code that changes them.

## 5. Watch list — what the implementer keeps in view at every step

Ordered by how much damage a miss does. Each item names the step where it is proven.

1. **The close contract (§6) is the first thing a live model can break.** A run must end with `thread_wait`, `thread_block`, or `thread_review`; a plain final answer is `unclosed`. Nothing before step 7 proves a model will do this. Run step 7 as early as the stack allows, and record every prompt change together with the failure it fixed.
2. **Step 3 is where later bugs get blamed.** Sequence counter written before the thread file; outbox persisted before apply and acknowledged after; migration keeps the `.v0.json` backup until the migrated file reads back through the validator. Each has a crash-injection test in step 3's gate; do not weaken them to make the step land sooner.
3. **Ambient binding lives inside `runBody`, and mutating tools re-check it.** The per-turn `runWithMeshRunContext` frame is the only hard boundary against wrong-thread actions; the prompt frame is advisory. Every mutating tool reads the ambient triple and then verifies the run is still `running` on that thread before writing (step 5).
4. **No silent path.** Every admission result is persisted on the message and rendered; a quiescent thread with nothing runnable becomes `blocked`, never idle `in_progress`. Round 2 found more defects of this class than any other.
5. **Runtime hot paths change only through sub-PRs.** `agent-core.ts`, `background-tasks.ts`, `background-agent-resume.ts`, `agent-headless.ts`, `agent.ts` are shared with Agent Team and every subagent. A mesh step branch never edits them; it opens a sub-PR that does, with its own tests, and records the dependency.
6. **Trust labels are not boundaries.** Until §9.9 is decided, no prompt heading is called "trusted" and no code treats one as a policy input. Provenance is derived from the ambient run, never from model or HTTP input.
7. **Product decisions stay open until decided.** §9.4, §9.5, §9.9, §9.10, §9.11, §9.12 and the #9402 relationship; the conservative defaults in §3 above apply meanwhile.
8. **Read the CI of #11206, not of the sub-PR.** A sub-PR based on the mesh branch runs no unit tests or lint here.
