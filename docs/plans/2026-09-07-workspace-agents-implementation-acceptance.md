# Workspace agents implementation — step-by-step acceptance criteria

> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) §5.2 (ten steps, as numbered on the `codex/multi-agent-mesh-foundation` branch) and [`2026-09-07-workspace-agents-review-round2-handoff.md`](./2026-09-07-workspace-agents-review-round2-handoff.md).
> Delivery shape: **one implementation and delivery PR** (#11206). Runtime changes #11200 / #11202 / #11204 are merged into its branch. Because that branch was their PR base, GitHub records them as merged draft references; their review history remains available and none is merged separately to `main`.
> Nothing in this file was executed by its author. "Evidence" means what the implementer reports, with observed values, in the PR description or a `docs/verification/workspace agents/` package.

## 0. Corrections to the round-2 hand-off

- **C2 was wrong as stated.** `AgentHeadless.executeTurn` emits `EXTERNAL_MESSAGE` for a continuation `task_prompt` (`agent-headless.ts:279-288` at `703678136a`), and the transcript writer records that event. The reviewer read `:290-300` and missed the branch above it. The implementer reproduced cold-revive history with both continuation prompts present. What remains true: bare `task_prompt` has no delivery id and gets the parent-agent prefix, so workspace agents turns use structured input (#11202). The hand-off on this branch already carries the correction.
- **C1 is confirmed and fixed** (`[1, 1]` → `[1, 2]`, #11200).
- **Observation 1** (idle residents do not hold slots) settles the round-2 "verify" item on the concurrency cap.

## 1. How to read the steps

Each step lists: what lands, the acceptance gate, and the evidence to report. The owner's later demo-first instruction overrides the old local-build/CI-wait and child-PR workflow: changes go directly to #11206, with scoped source checks and actual daemon/browser observations. No unrun CI or test gate is represented as passing. Steps 1-6 need no model; 7 is the first live gate; 8-10 need the daemon or a browser.

### Current ACP-session evidence boundary (2026-09-08)

The numbered steps below retain the historical background-agent implementation
and its observations. They are not proof of the replacement session adapter.
Current run ids, timestamps and limitations are recorded in
[`2026-09-08-workspace-agents-vs-multica-gap-and-plan.md`](./2026-09-08-workspace-agents-vs-multica-gap-and-plan.md).

| Requirement                                         | Current evidence / remaining work                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent identities and separate sessions         | Existing leader/worker reused across tasks; leader continuation preserves its session id. Sessions share one ACP process.                                                                          |
| Concurrent same-thread handoff and human acceptance | Clean three-run peer handoff; 8,999 ms overlapping run lifetimes; both results submitted and Chrome Mark done succeeded.                                                                           |
| Child delegation and parent report                  | Earlier ACP demo reached done on child and parent, with manual startup retries; not a clean first-attempt run.                                                                                     |
| Live human input                                    | Same-run mid-turn transcript and consumed window verified; final review contains the correction. Late-drain/crash cases remain open.                                                               |
| Initial input receipt                               | A real assigned run persisted its initial prompt, consumed the matching trigger and reached review. The transcript-before-receipt crash window remains to be force-killed.                         |
| Cancellation                                        | Working → stopping → cancelled observed; usage retained; unresponsive-child case remains open.                                                                                                     |
| Running task after daemon restart                   | SIGKILL after a durable checkpoint exposed a startup-discovery defect; after its fix, the same run/session recovered as attempt 2 and reached human acceptance. Other crash windows remain open.   |
| Human resolves a blocker                            | Real thread_block question, human selection, same-session continuation, JSON review, and Chrome Mark done verified. Other blocker-acknowledgement scopes remain an owner decision.                 |
| Automatic-turn gate                                 | Isolated actual-source storage run: 12 running coalesces, posts 13/14 rejected, one pending turn-gate notification; human reply reset to 0, next agent delivery charged 1. Not a model experiment. |
| Read-only boundary and ambient ownership            | Guard wiring and direct source checks exist; full model-driven negative matrix has not been demonstrated.                                                                                          |
| Storage and reliability gates in steps 3/7/8        | Historical tests/observations remain below; no blanket revalidation claim for the current ACP path, nor a completed failure-injection matrix.                                                      |
| External notifications                              | Consumer exists, but no recipient is configured for current acceptance; no external send authorized or observed.                                                                                   |

The 2026-09-08 delegation run after the Agent Builder reuse change exposed one
routing false positive: the leader's summary containing the scoped package
`@qwen-code/qwen-code` produced `agent_unknown(qwen-code)`. Mention parsing now
ignores `@token` immediately followed by `/`; agent addresses followed by normal
punctuation are unchanged. This was found by the real model path, not by a test
exercise.

The same run exposed an acceptance loop: the parent had already consumed the
child's `in_review` report and submitted its own review, but marking the child
done emitted another parent report and spent a third leader run. Child-done
reports are now suppressed when the parent is already `in_review` or `done`;
the parent panel reads the child's final state directly. Open, in-progress and
blocked parents still receive the durable report. A direct daemon-route check
with an `in_review` parent observed the child become `done` with zero
`child_done` outbox events and the parent retain zero posts/runs; the temporary
records were deleted afterward.

Gate check (2026-09-08): before the fix, the same 12-turn experiment persisted
the skip outcomes but produced zero notifications while both runs stayed live.
Gate admission now writes its notification in the same transaction, without
requiring an aggregate status change. Replaying the rejected post's
`originEventId` left the entire stored record unchanged. A separate 10-token
usage / 10-token cap check rejected two admissions and retained one pending
token-gate notification. With no destination, the consumer made zero sender
calls, delivered zero events, and retained both gate reasons as pending.
These observations come from direct source assertions in temporary storage;
no model calls, build, lint, or test suite were run. The existing turn-gate test
now also asserts the pending notification and repeat suppression, but was not
executed through Vitest. Design §5.2 step 10 no longer describes gate events as
depending on state transitions: a rejected admission need not change status.

This ledger is not an overall completion claim. The explicit failure cases below
remain requirements; the demo-first workflow changes how work is sequenced, not
whether missing evidence can be called a pass.

Every step also updates the design doc: any sentence the implementation contradicts is changed in the same commit, with the reason. The doc is the contract; the code does not silently redefine it.

## 2. Steps

### Step 1 — Admission foundation (landed on this branch)

Gate: the three workspace agents test files pass on CI; `THREAD_STATUSES` includes `blocked`; a missing or invalid root fails closed; `countQueuedElsewhere` counts `queued` only; a human post on a child does not touch the root's `autoTurnsUsed`; unknown `@name` yields `agent_unknown` and does not wake the assignee; a post with no target yields `no_target`; `coalesce(running)` from an agent charges one turn.
Evidence: the test names covering each clause. Currently 38 tests; keep the count in §5.3 current.

### Step 2 — Read-only capability boundary

Lands: a built-in workspace file-reading allowlist intersected with the agent definition's tool list; shell, MCP, `save_memory`, `write_file`, `edit`, and every persistent or host-wide tool are denied; `thread_*` tools are added on top of the definition, never taken from it.
Gate: a table-driven test enumerates every registered tool name in core and asserts it is either allowed, denied, or `thread_*`; adding a new tool to core without classifying it fails the test. The tool configuration and invocation guard both deny shell by name.
Evidence: the classification table, committed as data, not prose.

Supporting local observation before the shell boundary correction: `capability.test.ts`, 10 tests passed. The step
is not complete until #11206 CI passes after the child PR merges.

### Step 3 — Versioned storage protocol

Lands: `schemaVersion` on every file; fail-closed on unknown version; migration under the workspace lock with the old file retained until the new one validates; the workspace mutation lock; lock-issued `queueSequence` and message `sequence`; `runs[].usageByRound` on the run record; outbox for parent reports and notifications only; deletion refusal for non-terminal runs, descendants, and unacknowledged outbox events.
Gate: (a) writing a file with `schemaVersion + 1` makes every read throw, never return empty state; (b) a crash injected between "write source" and "acknowledge" replays exactly once, proven by an apply that writes the target and throws before reconciliation is re-run; (c) two `child_process` workers allocating concurrently receive unique `queueSequence` values and each observes a strictly increasing series, not two promises in one process; (d) token gate at admission equals the sum of `usageByRound` across the tree, tested with a tree of depth 3 where the root file carries a deliberately stale `tokensUsed`.
Evidence: the four tests named, plus the migration test with a hand-written v1 fixture.

Supporting local observation: `store.test.ts`, `workspace-lock.test.ts`,
`thread-actions.test.ts`, `dispatch-policy.test.ts`, and `mentions.test.ts` pass
59 tests. This is not the step gate until the child merges and the resulting
#11206 whole-branch CI is green.

### Step 4 — Hidden host session, keepalive, launcher

Lands: one hidden `Config` + registry per workspace; keepalive registration reusing `scheduled-task-keepalive.ts`; `launchWorkspaceAgent(agent)` that builds the persona through `convertToRuntimeConfig` and starts a background agent; typed launch results `started | capacity_wait | agent_unavailable | launch_failed`.
Gate: (a) with `QWEN_CODE_MAX_BACKGROUND_AGENTS=1`, launching a second agent returns `capacity_wait` and books nothing; (b) an agent whose `agentType` names no definition returns `agent_unavailable` and no runtime is created; (c) the host session does not appear in the session list API; (d) after the real bridge reaper closes the host session, keepalive reloads it and the next launch succeeds without recreating the bridge; (e) `continueResidentAgent` returns `continued` for a completed resident and `capacity_wait` never triggers a cold revive (#11204's tests, now on this branch).
Evidence: report the reaper timeout and observed reload latency from an in-process `AcpSessionBridge` with a fake ACP child. Step 4 deliberately has no server-bootstrap caller before the dispatcher exists, so step 7 repeats this observation through the daemon dispatcher instead of adding unused wiring here.

Supporting local observations on the stacked step branch: `capability.test.ts`
and `launcher.test.ts` pass 16 tests; `background-agent-resume.test.ts` passes
52 tests including cold-revive capability restoration; `background-tasks.test.ts`
passes 150 tests including typed resident continuation; `agent-host-session.test.ts`
and `scheduled-task-keepalive.test.ts` pass 34 tests; `bridge.test.ts` passes
914 tests; and `acpAgent.test.ts` passes 629 tests. A targeted `acp-bridge`
package build also succeeds. The real `AcpSessionBridge` reaper was configured
to 20 ms in-process with a fake ACP child; it closed the host, a second channel
resumed the same session, and the next launch returned `started` after a
measured 4.3 ms reload (1,000 ms resume deadline), without recreating the
bridge. The child merge and #11206's whole-branch CI remain the step gate; the
daemon-process observation is part of step 7 for the reason above.

### Step 5 — Run envelope, tools, runtime correlation

Lands: `runWithAgentRunContext` at the per-turn seam; `thread_post`, `thread_wait`, `thread_block`, `thread_review`, `thread_create`, `thread_read`; the prompt assembler; structured external input with `deliveryId` (#11202, folded); `consumedMessageIds` recorded from the correlated event; `usageByRound` upserts from `USAGE_METADATA` with cumulative rounds (#11200, folded).
Gate: (a) a mutating tool invoked with a model-supplied `threadId` argument is rejected by schema, and one invoked outside a run context is rejected at execution; (b) `thread_create` under thread A from a body whose previous turn was on thread B creates the child under A, tested by running two turns on one `AgentHeadless` instance; (c) `thread_wait` without a live dependency returns a typed rejection; (d) the assembled prompt for a second wake contains title, body, status, the last N posts, and the delta after `committedThroughSequence`, and a retention gap renders the GAP line; (e) a `USAGE_METADATA` sequence across a `finishingInputs` continuation records rounds `[1, 2]` on one run.
Evidence: the assembled prompt text for cases first-entry / delta / gap / retry, committed as snapshot fixtures.

**5a landed (ambient binding and prompt envelope).** Gate (d) is met: `prompt.test.ts` covers first entry, delta after a watermark without dropping the recent window, a labelled gap with its size, a retry that does not hide the gap, a first entry into an already-trimmed thread, peer tokens for enabled peers excluding self, per-post elision, and a bounded recent window. `run-context.test.ts` covers absence outside a turn, the bound triple, two interleaved turns keeping their own threads across `await`, identical re-entry, and refusal to nest a different run. `resolveTargets`'s defaulted third parameter is now required, so a caller that omits it can no longer reinstate the unknown-mention fallback. Observed locally: `prompt.test.ts`, `run-context.test.ts`, `dispatch-policy.test.ts` → 3 files, 33 tests passed; `thread-actions.test.ts`, `store.test.ts`, `capability.test.ts` → 3 files, 44 tests passed; targeted ESLint clean. Gates (a), (b), (c) and (e) belong to 5b and remain unexecuted.

**Aggregate status landed.** `thread-status.ts` derives the status from every run's close obligation rather than letting the last run to finish stamp it, and the three round-2 findings are each pinned by a test: a same-thread wait is discharged by a later close (I1), any later successful booking discharges an earlier failure or unclosed return (I2), and a quiescent thread whose last admission booked nothing becomes `blocked` (I6). Also covered: a live run outranks another agent's review, a blocker outranks a review, a wait is `in_progress` only while a child can wake it, `done` is sticky against a late post, and a failed run reports as a failure even when it recorded a close kind. Observed locally: `thread-status.test.ts` → 1 file, 13 tests passed; targeted ESLint clean. The producers that write `closeKind` are the thread tools in 5b, so nothing calls this resolver yet.

**Run close and status application landed.** `run-lifecycle.ts` splits closing into two writes: the tool records `closeKind` and moves the run to `finishing`, ending the agent's turn, and the runtime callback records the terminal state — the only place the aggregate status is recomputed. A `waiting` close is refused when nothing could wake it, and a live _descendant_ counts while a mere sibling under the same root does not. Any close discharges peers' waits on the same thread. A clean exit with no closing tool is recorded as `unclosed`, never as implicit success. `finishRun` now delegates to this one path, and `postMessage` discharges outstanding obligations when it books work and then applies the aggregate status, so the I2 and I6 fixes have producers rather than only a resolver. Observed locally: `run-lifecycle.test.ts`, `thread-actions.test.ts`, `thread-status.test.ts`, `store.test.ts` → 4 files, 57 tests passed; targeted ESLint clean. The six thread tools that call `closeRun` are still to come, so gates (a), (b), (c) and (e) remain unexecuted.

**Thread tools landed.** `tools/thread-tools.ts` adds `thread_post`, `thread_wait`, `thread_block`, `thread_review`, `thread_create` and `thread_read`. Gate (a) is met twice over: a table-driven test asserts every mutating schema is `additionalProperties: false` and carries no thread, author, run or idempotency id — `thread_read`'s single `thread_id` is the read-only exception — and a call outside a run frame is refused at execution. Gate (b) is met: two frames on different threads each create their sub-thread under their own ambient thread; the test asserts the parent ids rather than the call order. Gate (c) is met: a wait with nothing to wait for is refused with the text that tells the model what to do instead. Every mutating tool verifies workspace, root, run, agent and attempt inside the same transaction as its write, so cancellation or revival cannot slip between authorization and mutation. Assignment goes through admission in the same transaction as the child's creation, system-authored but carrying the causing run.
Observed locally across this subsystem module and the tools: 10 files, 118 tests passed; targeted ESLint clean.
Gate (e) is only half done: #11200 pins the cumulative round, but nothing calls `upsertRunUsage` from a live `USAGE_METADATA` stream until the dispatcher exists. Still unexecuted for step 5: wiring `runWithAgentRunContext` at the real turn seam, `acceptedMessageIds`/`consumedMessageIds` from the correlated `EXTERNAL_MESSAGE`, and registering these tools in a workspace agent's registry.

### Step 6 — Minimal in-process dispatcher, no recovery

Lands: pick the lowest `queueSequence` queued run per agent; branch on registry state `completed+resident → continue`, `completed → revive`, `paused → resume`, `unbound → launch`; atomically claim before starting the runtime, bind the returned session on success, release the claim on `capacity_wait`, and consume the parent-report outbox.
Gate: with a fake `AgentHeadless` that answers scripted text, (a) an assignment trigger on an open thread results in exactly one `startRun` and one `finishRun`; (b) two threads queued for one agent start in `queueSequence` order regardless of file enumeration order (test by creating the later thread with a lexically smaller id); (c) a child `thread_review` produces exactly one parent post carrying the event id, and re-running the consumer produces zero more.
Evidence: the three tests. No live model.

**Step 6 landed (core half).** `dispatcher.ts` selects each idle agent's oldest queued run by the lock-issued `queueSequence` — never `queuedAt`, never file order — and atomically claims it before the fire-and-forget runtime can execute. A second dispatcher therefore cannot launch the same run, and the ambient attempt is already durable before a first tool call. The prompt is assembled from the claimed record; a successful start binds the session and delivery watermark, while `capacity_wait` releases the claim and restores the unspent attempt. A failed or unavailable start is terminal and releases the queue slot. Parent reports drain through the outbox with the event id as the idempotency key; a second pass posts nothing more, and a notification no consumer claims stays pending rather than being acknowledged into silence.
Gate (a): one `startRun`/`finishRun` per assignment — covered. Gate (b): two threads queued for one agent start in `queueSequence` order regardless of file order — covered by `selectCandidates`. Gate (c): a child review produces exactly one parent post and a replay produces none — covered.
Observed locally: 11 files, 127 tests passed; targeted ESLint clean.
Writing the production port corrected the design's four-branch idle path to three. Whether a completed body still has a resident runtime is not a choice the dispatcher can make — only the registry knows, and #11204 already reports its own fallback — so a dispatcher choosing between "continue resident" and "cold revive" would be guessing at state it cannot see and would cold-revive a live body. The three entry points it does choose between are `launch`, `resume` (a restart-recovered `paused` entry, which the revive path rejects) and `continue_completed`.
`dispatch-port.ts` binds those to the runtime and is the single place a non-local runtime would be substituted (§9.12). Its tests pin the registry-state mapping, the hot path not touching the transcript, capacity reported before any mutation, a state change under it not being forced, and a thrown runtime error becoming a typed failure rather than a start.
**Runtime wiring landed for the demo path.** Every launch, resident continuation, resume, and revive persists the next run binding, and both real background-turn seams establish it inside the turn body. Workspace agents see the six thread tools while ordinary subagents do not. Every agent turn carries the run id in structured external input; runtime acceptance records the accepted ids, the correlated consumed event advances consumed ids and the watermark, usage events upsert cumulative rounds, and body completion terminalizes the agent run. A recovered delivery's initial input is cleared before a later resident turn. This correction was deliberately not expanded with new test code or a local CI/build pass; step 7's live model run is the next evidence gate.

### Step 7 — Live vertical slice (first integration gate)

Lands: normally nothing; the first run may carry only defects that directly
block the slice. This run corrected the resident-continuation sidecar lookup to
use the same storage root as the background-agent launcher.
Gate: the §8 demo steps 1-5 complete against two real agents on a build-capable machine, plus: a forced `queueExternalInput` miss (kill the agent between its last tool round and finish) is rebooked and delivered on the next run; a synthetic ping-pong between two _running_ agents on one thread stops at 12 with `turn_budget_exhausted` in the thread and one channel-less notification record.
Evidence: the thread JSON files after the run, the two agents' transcript slices, the observed wall-clock between the child's `thread_review` and the parent's wake, and the host reaper timeout plus daemon-observed reload latency. If any prompt in §6 had to change to make the model close its run explicitly, the changed prompt and the failure it fixed.

**Happy-path observation (2026-09-07).** On a normal non-bare host, Alice was
the only target of the root post, created and assigned Bob's child, and closed
`waiting`. Bob posted three concrete checks and closed `review`. The parent
report applied after 13 ms; the same resident Alice body continued, summarized
the child, and closed the root `review`. Final status was `in_review` on both
threads; Alice's two runs were `completed/waiting` and `completed/review`, and
Bob's was `completed/review`. All six thread tools were in the real model tool
surface. No §6 prompt change was needed. The first continuation attempt failed
because `dispatch-port.ts` derived the sidecar path from the checkout rather
than `Config.storage.getProjectDir()`; the correction above made the next live
run pass. A first demo input also mentioned Bob directly and therefore woke him
according to the real routing rule; addressing only Alice fixed the driver, not
the product.

This proves the demo steps 1-5 only. The forced `queueExternalInput` miss,
12-turn ping-pong, daemon reaper replacement, and bare-mode exposure remain
unrun, so the full step-7 gate is not yet claimed.

**ACP-session delegation observation (2026-09-08).** Root
`th_8c68f839-637d-4472-9f8d-8544d13646f3` assigned the existing
`demo-leader`, which created child
`th_9cec20a2-0bd8-41fc-94e7-3de1a6fa495a`, assigned the existing
`demo-worker`, and closed its first run with `thread_wait`. The worker read the
repository root `package.json`, posted `@qwen-code/qwen-code` and `>=22.0.0`,
and closed with `thread_review`. Its run ended at `1788859290728`; the durable
parent report was posted at `1788859290779` (51 ms), and the leader's next run
started at `1788859291693` (965 ms after the child ended). Both leader runs used
session `63465788-a16b-5328-92fc-8020330969a9`; the worker used
`b48bad11-6e7c-5110-92a1-e560bf56eec6`. The leader posted both values and
closed the parent with `thread_review`. Chrome first refused parent acceptance
with `descendants_not_done`; after the person accepted the child, both records
were marked `done`. No new agent was created. The run also exposed the scoped
package mention and redundant child-done wake defects recorded above.

**Direct steering and concurrency observation (2026-09-07).** In thread
`th_6c12d77c-7d8a-4cd5-a535-2030a4c06d45`, a human post made while Alice's run
was `running` coalesced into that same run. Its delivery id appeared in both
`acceptedMessageIds` and `consumedMessageIds`, and Alice's final review included
the newly requested `/etc` result. In thread
`th_7aee128a-78f3-44be-80a9-ebb676937de6`, Alice and Bob entered `running` 138
ms apart, posted separately attributed reviews, completed independently, and
the aggregate thread reached `in_review`. This proves the accepted direct-input
path and concurrent agents on one shared thread; it does not prove the forced
enqueue-miss recovery path.

**Deliberate ping-pong observation (2026-09-07).** Thread
`th_ea937a51-1e41-406c-b328-878fcab0b06e` launched Alice and Bob concurrently
and recorded three unattended deliveries. The second Alice post coalesced into
Bob's running attempt; its id appears in both `acceptedMessageIds` and
`consumedMessageIds`. Bob then closed without emitting another reply. The three
runs accounted 428,636 tokens, so the 200,000-token gate pre-empts a 12-turn
live loop with this model footprint. The run therefore does not satisfy the
12-turn gate. Reaching that gate without changing product semantics requires a
minimal model frame or a scenario-only token-limit override; the ordinary
runtime correctly keeps the settled token ceiling in force.

### Step 8 — Dispatcher reliability

Lands: `delivery_race` detach/rebook; `launch_failed` with `failureStage`; done/cancel (`cancelling` state, runtime abort); restart recovery (`running` → reconcile → resume once → terminal on second failure); stale host-session binding replacement after a definitive resume failure; stall sweeper; full outbox replay on startup.
Gate: failure injection at each named point, as separate tests: enqueue returns false; process exit after `acceptedMessageIds` write; process exit after transcript record but before `consumedMessageIds` write; process exit after parent apply but before acknowledge; daemon restart with one `running` and one `queued` run; a stored host session that cannot be resumed is replaced once; N-minute stall. Each test asserts the thread file's final state and that no message id is both unconsumed and unbooked.
Evidence: the injection matrix as a table in the PR, one row per test, with the asserted final state.

**Production path implemented; gate not run.** The dispatcher now sends a
structured, correlated input only to the exact ambient run binding; a rejected
or raced delivery detaches its unaccepted trigger ids into the queued
successor. Accepted-but-unconsumed input survives restart and is replayed once;
late callbacks are attempt-guarded. Stored running work is resumed once and a
second failure becomes terminal. The hidden host binding is replaced only
after the resume promise definitively rejects, never merely on its timeout.
An aggregate child-review report carries the review summary's source run id,
so the parent wake remains auditable across the system-authored hop.
Workspace agents reuses the existing three-minute workflow watchdog, including its
tool-in-flight suspension, and requeues the first stalled attempt. Per the
demo-first instruction, no local tests, lint, typecheck, build, or CI wait was
performed for this implementation. Route startup now reopens owners for durable
live work or pending outbox events. Cancellation is source-first: the run is
persisted as `cancelling`, the dispatcher verifies the ambient runtime binding,
then stops the body and records terminal `cancelled`; queued cancellation also
wakes the dispatcher so the next FIFO item is not stranded. A racing runtime
completion observes `cancelling` and also settles as `cancelled`.
Prompt replay now detects internal retention holes by counting missing message
sequences, rather than trusting the first retained message, because referenced
old posts can survive trimming. The frame no longer tells an agent to recover
physically deleted posts through `thread_read`; it marks the gap unrecoverable
and tells the agent to ask a person when the missing context is required.
Undelivered triggers are rebooked only from a running, finishing, or completed
attempt where delivery can genuinely have raced completion. Failed and
cancelled runs remain terminal, so a later dispatcher pass cannot undo an
explicit cancellation or retry a definition/start failure forever. The
rebooking transaction checks that status again rather than trusting its scan
snapshot, closing the cancellation-versus-delivery race.
Cancellation admission now reads and changes the run under one workspace lock.
A queued run cannot be claimed between the route's observation and its write,
and the response is based on the stored post-dispatch state rather than the
stale status that initiated the request.
The hidden host owner is also bound to the selected workspace runtime
generation. A replaced or drained generation stops its keepalive loop and is
rejected before later launch or dispatch; generation checks bracket host claims
and releases, and a raced stale spawn is cleaned up. Reusing the same bridge
object cannot keep the old owner alive. This path was source-inspected only
under the same demo-first constraint.

**Crash-recovery observation (2026-09-07).** A real daemon was killed with
`SIGKILL` while run `rn_4bd80535-7fe6-4024-aeac-70dbaf338fea` was `running`.
Restart recovery kept the run id, advanced it to attempt 2, consumed its durable
trigger, and completed it with `thread_review`. A second run,
`rn_04d3aa17-39d1-4ddc-958f-38c5f003c537`, was killed after message
`ms_d4fe89c5-ecaa-4a87-a7c2-6c6f451c2476` appeared in
`acceptedMessageIds` but before it appeared in `consumedMessageIds`. On restart,
the same run advanced to attempt 2, consumed that delivery, and its final review
contained both requested replay markers. This manually proves running-run
restart and accepted-but-unconsumed replay; it does not prove enqueue returning
false, transcript-written-before-consumed recovery, stale-host replacement, or
the watchdog. The long replay run also exposed the conservative accounting
policy visibly: it closed at `666,749 / 200,000` tokens because the limit is
checked at admission, not between tool rounds.

**Initial-receipt observation (2026-09-08).** Real ACP run
`rn_bcd7f190-5958-4dcd-9c92-ea207d4aad16` posted
`INITIAL-RECEIPT-8391` and closed with `thread_review`. Its durable trigger
`ms_c7dcb7be-dda0-496f-90f7-e3663dec5130` is the sole consumed id and the
committed watermark is sequence 1. Reloading session
`b48bad11-6e7c-5110-92a1-e560bf56eec6` from disk found the assigned prompt and
marker in its transcript. The session path now flushes that initial user record
before writing the receipt; dispatch no longer marks it consumed before
activation. This proves the normal path and source order, not the named
process-exit injection between those two writes. No build, lint, test suite, or
CI ran.

### Step 9 — REST and Web Shell

Design direction is settled ahead of the build in [`2026-09-07-workspace-agents-web-shell-design.md`](./2026-09-07-workspace-agents-web-shell-design.md): the thread view is a ledger of outstanding obligations with the conversation as evidence, not a chat log with a status badge. It inherits Web Shell's existing tokens and adds no new colour or typeface. Step 9 renders `resolveThreadStatus`'s `status` and `reason` rather than inventing a second status vocabulary, shows one lane per agent that has worked the thread, and bounds every transcript view to the run's own slice.

Lands: routes for agents, threads, posts, runs; roster, thread list, thread view with run slices, busy reason, gate/failure display, cancel; #11140's sidebar entry absorbed.
Gate: Playwright visuals for roster, thread view with two agents' posts attributed by name snapshot, a `blocked` thread with its question, and a run slice rendered from `transcriptStartOffset..EndOffset` showing only that run; deleting an agent keeps old posts readable with the tombstoned name.
Evidence: screenshots from the visuals config, in CI.

**Demo-path observation (2026-09-07).** A real `qwen serve` daemon and Web
Shell created two fresh persistent identities and an assigned root thread from
the Agents page. `alice-demo` created one child for `bob-demo`, closed
`waiting`, received the durable child report, resumed the same body, and closed
the root `review`. `bob-demo` closed the child `review`. The page updated from
the resolver reason while the runs were active and finished with the root in
`in_review`, Alice's two past runs collapsed behind their count, and Alice's
attributed result visible in the ledger. The tree accounted 186,317 of 200,000
tokens.

The first browser-driven attempt exposed an actual prompt failure: agents put
peer mentions in ordinary result prose, which booked unintended runs back and
forth and exhausted the tree budget before the parent could resume. The turn
envelope now states that an at-sign address books work, forbids it in status or
result prose unless another wake is intended, and states that child completion
already reports to the parent. A fresh run with that wording completed without
the extra bookings. A separate draft containing the literal word `@mentions`
was correctly rejected as an unknown agent name. The new-thread form now runs
the selected assignee through the same admission rule before creation, so a
full queue or disabled/unknown target is visible before the durable write.

**Latest-source smoke (2026-09-07).** From the Web Shell, the new-thread form
previewed `Will start @alice`, then durably created and assigned thread
`th_eca773de-4efa-4c82-bdeb-9bdafc521077`. After a daemon restart, the queued
run `rn_077865eb-b3da-4ab0-8521-ab8c96882818` was replayed, Alice inspected the
workspace, posted an attributed conclusion, and explicitly closed with
`thread_review`. The API and browser both showed the run as
`completed/review` and the thread as `in_review`. This was a manual demo-path
observation only: no test suite, lint, typecheck, or CI was run. The source-mode
daemon required the ACP bridge package output to be refreshed because this
worktree shared a `node_modules` link whose existing bridge build predated the
workspace agents dispatch method.

The same live daemon then covered the remaining visible step-9 paths. A fresh
run recorded transcript offsets `16990..22071`; opening its history row showed
only that byte range beside the still-visible thread. A second agent called
`thread_block` and the page rendered both `Which target file should I inspect?`
and the resolver reason that the run was waiting for a person. Cancelling a
running agent changed the row from `working` to `stopping`, reached terminal
`cancelled`, and the thread could then be marked done. Deleting `alice-demo`
removed it from the roster while its existing post remained attributed as
`alice-demo (removed)`. The first-class Agents sidebar entry from #11140 and
inline child-thread navigation were also exercised in the same browser.
Assigned creation now writes the new thread, assignment, admission outcome, and
first run in one replacement; a human post also invokes the dispatcher for a
running coalesce, not only for a newly queued run. These last production-path
changes were inspected from source only. No local unit tests, lint, typecheck,
build, or CI wait were run. Roster and header activity copy now follows the
actual active run state instead of calling a queued or cancelling run
"working", and an unacknowledged cancellation is shown as an outstanding
obligation. The dead `agent_unavailable` composer branch was removed: missing
definitions remain typed dispatcher launch failures because the pure admission
rule has no runtime definition loader. The roster now exposes the designed
enable/disable state. Disabling is one workspace-locked mutation that rejects
new admissions while already-booked work keeps draining; deletion still
refuses live or queued work. A booking cannot race either roster change.
Root and child creation revalidate the chosen assignee under that same lock, so
a concurrent disable or delete cannot leave a new thread pointing at a stale
identity.
Agent creation reuses the storage protocol's mention-name validator at the REST
boundary and reports case-insensitive duplicates as a conflict instead of a
generic server failure.
Deleting an idle identity now makes the hidden host forget its resident body
and removes that deterministic body's transcript and sidecar from every host
session directory under the selected workspace runtime; historical thread posts
keep their name snapshot. Removing the last identity also stops the owner,
releases its workspace claim, and closes the now-unused hidden host session.
Creating the first identity starts that host immediately; daemon startup only
restores it for a non-empty roster, so retained notification events cannot
resurrect a host after every identity was removed.
The thread header also supports atomic human reassignment: changing the default
assignee writes a structured assignment through admission without cancelling
work already booked for another agent; choosing no assignee only clears the
future fallback. Marking a thread done now scans its complete descendant tree,
refuses live children, cancels its own work, and writes the terminal state in
one workspace transaction, so a racing agent cannot create an open child after
the check. Repeating the command does not enqueue another `child_done` report.
The Web Shell also surfaces a background-processing failure after a durable
mutation as "saved, but background processing failed"; periodic refreshes no
longer erase that action error a second later. These paths were source-inspected
only.
The daemon's ordinary session catalog already returned agent sessions, but the
sidebar exposed only Tasks and Channels and therefore hid them behind the
default-source filter. The existing source switch now includes Agents and
feeds `sourceType: agent` into the same `WorkspaceSection`; it does not add a
second conversation list or renderer. In the live Web Shell that tab listed
the existing `demo-leader` and `demo-worker` sessions, and opening
`demo-leader` loaded session `63465788-a16b-5328-92fc-8020330969a9` in the
ordinary conversation page with its full ten-turn transcript. A hard reload
preserved that transcript. No test suite, build, lint, typecheck, or CI ran.
The Agents navigation now opens runnable workspace Agents and their shared tasks
instead of leading with reusable subagent definition files. New Agent reuses the
existing manual/model-assisted builder but writes one roster identity directly;
Definitions and linking an existing definition remain secondary compatibility
paths.
Tool responses now report booking as queued work rather than claiming the peer
has already started, and `thread_block` reports the durable blocked state
without promising channel delivery while §9.12 remains open.
An unassigned `open` child no longer satisfies `thread_wait`: only a live run,
pending parent report, or non-open descendant state is a future wake path, so a
parent cannot silently sleep behind an inert child.
An accepted delivery replay that repeats `thread_create` with the same parent
and normalized title now reuses the existing child instead of duplicating the
delegated work.

**Step 10 landed (the consumer; the destination is a product choice).** `run-lifecycle.ts` had been writing `notification` outbox events at four points since step 5, and nothing read them: `deliverParentReports` filters to `parent_report`, so every blocker, review, gate and failure notification sat pending forever — which also meant a thread that ever raised one could never be deleted, because deletion refuses pending events.
`deliverNotifications` is the missing consumer. It drains only `notification` events, through the same persist-attempt → apply → acknowledge protocol, and sends through an injected sender so core never reaches the channel worker. `routes/workspace-agents.ts` supplies that sender from the daemon's `deliverChannelMessage` and flushes after every mutation that dispatches, because the worker lives in the daemon while the dispatch loop runs in the host session.
**No default destination.** `AgentWorkspaceState.notifyTarget` is absent until someone sets it with `setAgentNotifyTarget`, and while it is absent the events stay pending rather than being acknowledged into silence — the same rule every unconsumed event kind follows. Guessing a channel would send a person's work somewhere nobody chose. Who sets it, and whether it belongs per workspace or per agent, is the product decision this leaves open.
Observed: four new cases in `dispatcher.test.ts` — pending while unconfigured, sent exactly once with the event id as the delivery id, a failed send left pending with its attempt counted and retried, and parent reports untouched by the notification pass. Suite counts before and after this change are identical at 16 pre-existing failures; passing tests went 113 → 117.

### Step 10 — Channel notifications

Lands: four events to the channel workers.
Gate: with one configured channel, each event produces exactly one message, and a replayed outbox after a simulated crash produces at most one duplicate and never zero.
Evidence: the channel transcript.

## 3. Product decisions the implementer must not make

Open in §9 of the design: envelope role transport (§9.9), parent-to-child replies (§9.10), human blocker acknowledgement scope (§9.11), channel notification destination (§9.12), token reservation vs accounting (§9.5), and persona drift policy (§9.4). Until each is decided the implementation takes the conservative reading: user-role envelope, ambient-thread-only mutation, acknowledgement of every open blocker on a human post that books, notification events retained without broadcasting, accounting limit with overshoot, and definition read at revive only.

The owner settled three step-3 inputs: v1 denies every MCP tool; the v1 schema declares the full §3 shape in one migration; and runtime is a first-class concept, represented by generic `runtimeId` beside the local `backgroundAgentId`. Step 4 keeps the launcher surface minimal and supplies the local implementation first.

The relationship to the Agent Board (#9402) also remains the owner's call. §7.1's conservative v1 default keeps separate stores and distinct names and imports nothing from `board-*.ts` in step 3. The settled first-class runtime shape makes a later foreign-runtime adapter possible without deciding whether #9402 becomes its seed. MCP names fail closed unless a future policy can prove an individual tool preserves the read-only ceiling.

## 4. Current single-PR workflow

- #11206 is the only delivery PR. Append work directly to `codex/multi-agent-mesh-foundation`; do not create more child PRs or issues for these steps.
- Do not run local CI/build/lint or make remote CI waiting the critical path. Record the actual source checks and live observations performed, with missing verification named explicitly.
- Runtime preparation was merged in the order #11200 → #11204 → #11202. The expected final conflict keeps both contracts: structured external input and typed continuation outcomes. GitHub automatically records those draft PRs as merged because their base is this branch; no PR was merged separately to `main` or manually closed.
- Merge `main` into the agents branch when it falls behind; never rebase (repo policy, and the force-push bot).
- Keep the design doc and this file current in the same commit as the code that changes them.

## 5. Watch list — what the implementer keeps in view at every step

Ordered by how much damage a miss does. Each item names the step where it is proven.

1. **The close contract (§6) is the first thing a live model can break.** A run must end with `thread_wait`, `thread_block`, or `thread_review`; a plain final answer is `unclosed`. Nothing before step 7 proves a model will do this. Run step 7 as early as the plan allows, and record every prompt change together with the failure it fixed.
2. **Step 3 is where later bugs get blamed.** Sequence counter written before the thread file; outbox persisted before apply and acknowledged after; migration keeps the `.v0.json` backup until the migrated file reads back through the validator. Each has a crash-injection test in step 3's gate; do not weaken them to make the step land sooner.
3. **Ambient binding lives inside `runBody`, and mutating tools re-check it.** The per-turn `runWithAgentRunContext` frame is the only hard boundary against wrong-thread actions; the prompt frame is advisory. Every mutating tool reads the ambient triple and then verifies the run is still `running` on that thread before writing (step 5).
4. **No silent path.** Every admission result is persisted on the message and rendered; a quiescent thread with nothing runnable becomes `blocked`, never idle `in_progress`. Round 2 found more defects of this class than any other.
5. **Runtime hot paths need narrow changes, not more PRs.** Shared runtime changes stay minimal and go directly to #11206 under the owner's current workflow; check their ordinary-session consumers as well as agent callers.
6. **Trust labels are not boundaries.** Until §9.9 is decided, no prompt heading is called "trusted" and no code treats one as a policy input. Provenance is derived from the ambient run, never from model or HTTP input.
7. **Product decisions stay open until decided.** §9.4, §9.5, §9.9, §9.10, §9.11 and the #9402 relationship; the conservative defaults in §3 above apply meanwhile. Runtime shape, schema batching, and v1 MCP denial are settled in §3.
8. **Keep acceptance evidence honest.** Follow the current demo-first workflow in §4. Never turn a source check into a claimed live observation, or historical background-runtime evidence into an ACP-session pass.
