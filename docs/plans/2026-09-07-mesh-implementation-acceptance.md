# Mesh implementation — step-by-step acceptance criteria

> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md) §5.2 (ten steps, as numbered on the `codex/multi-agent-mesh-foundation` branch) and [`2026-09-07-mesh-review-round2-handoff.md`](./2026-09-07-mesh-review-round2-handoff.md).
> Delivery shape: **one implementation and delivery PR** (#11206). Runtime changes #11200 / #11202 / #11204 are merged into its branch. Because that branch was their PR base, GitHub records them as merged draft references; their review history remains available and none is merged separately to `main`.
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
Evidence: the test names covering each clause. Currently 38 tests; keep the count in §5.3 current.

### Step 2 — Read-only capability boundary

Lands: a built-in allowlist for `run_shell_command`, intersected with the agent definition's tool list; an explicit deny list containing `save_memory`, `write_file`, `edit`, and every tool that persists outside the process; `thread_*` tools are added on top of the definition, never taken from it.
Gate: a table-driven test enumerates every registered tool name in core and asserts it is either allowed, denied, or `thread_*`; adding a new tool to core without classifying it fails the test. The shell predicate refuses every command the AST classifier does not return `read-only` for, with tests for allowed and refused commands.
Deferred to step 4/5: proving the refusal happens in the tool layer. `executionAllowedTools` is name-level, so a per-command predicate needs an invocation-time hook that arrives with the launcher (see the steps 2-3 brief §2).
Evidence: the classification table, committed as data, not prose.

Supporting local observation: `capability.test.ts`, 10 tests passed. The step
is not complete until #11206 CI passes after the child PR merges.

### Step 3 — Versioned storage protocol

Lands: `schemaVersion` on every file; fail-closed on unknown version; migration under the workspace lock with the old file retained until the new one validates; the workspace mutation lock; lock-issued `queueSequence` and message `sequence`; `runs[].usageByRound` on the run record; outbox for parent reports and notifications only; deletion refusal for non-terminal runs, descendants, and unacknowledged outbox events.
Gate: (a) writing a file with `schemaVersion + 1` makes every read throw, never return empty state; (b) a crash injected between "write source" and "acknowledge" replays exactly once, proven by an apply that writes the target and throws before reconciliation is re-run; (c) two `child_process` workers allocating concurrently receive unique `queueSequence` values and each observes a strictly increasing series, not two promises in one process; (d) token gate at admission equals the sum of `usageByRound` across the tree, tested with a tree of depth 3 where the root file carries a deliberately stale `tokensUsed`.
Evidence: the four tests named, plus the migration test with a hand-written v1 fixture.

Supporting local observation: `mesh-store.test.ts`, `workspace-lock.test.ts`,
`thread-actions.test.ts`, `dispatch-policy.test.ts`, and `mentions.test.ts` pass
59 tests. This is not the step gate until the child merges and the resulting
#11206 whole-branch CI is green.

### Step 4 — Hidden host session, keepalive, launcher

Lands: one hidden `Config` + registry per workspace; keepalive registration reusing `scheduled-task-keepalive.ts`; `launchMeshAgent(agent)` that builds the persona through `convertToRuntimeConfig` and starts a background agent; typed launch results `started | capacity_wait | agent_unavailable | launch_failed`.
Gate: (a) with `QWEN_CODE_MAX_BACKGROUND_AGENTS=1`, launching a second agent returns `capacity_wait` and books nothing; (b) an agent whose `agentType` names no definition returns `agent_unavailable` and no runtime is created; (c) the host session does not appear in the session list API; (d) after the real bridge reaper closes the host session, keepalive reloads it and the next launch succeeds without recreating the bridge; (e) `continueResidentAgent` returns `continued` for a completed resident and `capacity_wait` never triggers a cold revive (#11204's tests, now on this branch).
Evidence: report the reaper timeout and observed reload latency from an in-process `AcpSessionBridge` with a fake ACP child. Step 4 deliberately has no server-bootstrap caller before the dispatcher exists, so step 7 repeats this observation through the daemon dispatcher instead of adding unused wiring here.

Supporting local observations on the stacked step branch: `capability.test.ts`
and `launcher.test.ts` pass 16 tests; `background-agent-resume.test.ts` passes
52 tests including cold-revive capability restoration; `background-tasks.test.ts`
passes 150 tests including typed resident continuation; `mesh-host-session.test.ts`
and `scheduled-task-keepalive.test.ts` pass 34 tests; `bridge.test.ts` passes
914 tests; and `acpAgent.test.ts` passes 629 tests. A targeted `acp-bridge`
package build also succeeds. The real `AcpSessionBridge` reaper was configured
to 20 ms in-process with a fake ACP child; it closed the host, a second channel
resumed the same session, and the next launch returned `started` after a
measured 4.3 ms reload (1,000 ms resume deadline), without recreating the
bridge. The child merge and #11206's whole-branch CI remain the step gate; the
daemon-process observation is part of step 7 for the reason above.

### Step 5 — Run envelope, tools, runtime correlation

Lands: `runWithMeshRunContext` at the per-turn seam; `thread_post`, `thread_wait`, `thread_block`, `thread_review`, `thread_create`, `thread_read`; the prompt assembler; structured external input with `deliveryId` (#11202, folded); `consumedMessageIds` recorded from the correlated event; `usageByRound` upserts from `USAGE_METADATA` with cumulative rounds (#11200, folded).
Gate: (a) a mutating tool invoked with a model-supplied `threadId` argument is rejected by schema, and one invoked outside a run context is rejected at execution; (b) `thread_create` under thread A from a body whose previous turn was on thread B creates the child under A, tested by running two turns on one `AgentHeadless` instance; (c) `thread_wait` without a live dependency returns a typed rejection; (d) the assembled prompt for a second wake contains title, body, status, the last N posts, and the delta after `committedThroughSequence`, and a retention gap renders the GAP line; (e) a `USAGE_METADATA` sequence across a `finishingInputs` continuation records rounds `[1, 2]` on one run.
Evidence: the assembled prompt text for cases first-entry / delta / gap / retry, committed as snapshot fixtures.

**5a landed (ambient binding and prompt envelope).** Gate (d) is met: `prompt.test.ts` covers first entry, delta after a watermark without dropping the recent window, a labelled gap with its size, a retry that does not hide the gap, a first entry into an already-trimmed thread, peer tokens for enabled peers excluding self, per-post elision, and a bounded recent window. `run-context.test.ts` covers absence outside a turn, the bound triple, two interleaved turns keeping their own threads across `await`, identical re-entry, and refusal to nest a different run. `resolveTargets`'s defaulted third parameter is now required, so a caller that omits it can no longer reinstate the unknown-mention fallback. Observed locally: `prompt.test.ts`, `run-context.test.ts`, `dispatch-policy.test.ts` → 3 files, 33 tests passed; `thread-actions.test.ts`, `mesh-store.test.ts`, `capability.test.ts` → 3 files, 44 tests passed; targeted ESLint clean. Gates (a), (b), (c) and (e) belong to 5b and remain unexecuted.

**Aggregate status landed.** `thread-status.ts` derives the status from every run's close obligation rather than letting the last run to finish stamp it, and the three round-2 findings are each pinned by a test: a same-thread wait is discharged by a later close (I1), any later successful booking discharges an earlier failure or unclosed return (I2), and a quiescent thread whose last admission booked nothing becomes `blocked` (I6). Also covered: a live run outranks another agent's review, a blocker outranks a review, a wait is `in_progress` only while a child can wake it, `done` is sticky against a late post, and a failed run reports as a failure even when it recorded a close kind. Observed locally: `thread-status.test.ts` → 1 file, 13 tests passed; targeted ESLint clean. The producers that write `closeKind` are the thread tools in 5b, so nothing calls this resolver yet.

**Run close and status application landed.** `run-lifecycle.ts` splits closing into two writes: the tool records `closeKind` and moves the run to `finishing`, ending the agent's turn, and the runtime callback records the terminal state — the only place the aggregate status is recomputed. A `waiting` close is refused when nothing could wake it, and a live _descendant_ counts while a mere sibling under the same root does not. Any close discharges peers' waits on the same thread. A clean exit with no closing tool is recorded as `unclosed`, never as implicit success. `finishRun` now delegates to this one path, and `postMessage` discharges outstanding obligations when it books work and then applies the aggregate status, so the I2 and I6 fixes have producers rather than only a resolver. Observed locally: `run-lifecycle.test.ts`, `thread-actions.test.ts`, `thread-status.test.ts`, `mesh-store.test.ts` → 4 files, 57 tests passed; targeted ESLint clean. The six thread tools that call `closeRun` are still to come, so gates (a), (b), (c) and (e) remain unexecuted.

**Thread tools landed.** `tools/mesh-thread.ts` adds `thread_post`, `thread_wait`, `thread_block`, `thread_review`, `thread_create` and `thread_read`. Gate (a) is met twice over: a table-driven test asserts every mutating schema is `additionalProperties: false` and carries no thread, author, run or idempotency id — `thread_read`'s single `thread_id` is the read-only exception — and a call outside a run frame is refused at execution. Gate (b) is met: two frames on different threads each create their sub-thread under their own ambient thread; the test asserts the parent ids rather than the call order. Gate (c) is met: a wait with nothing to wait for is refused with the text that tells the model what to do instead. Every mutating tool verifies workspace, root, run, agent and attempt inside the same transaction as its write, so cancellation or revival cannot slip between authorization and mutation. Assignment goes through admission in the same transaction as the child's creation, system-authored but carrying the causing run.
Observed locally across the mesh module and the tools: 10 files, 118 tests passed; targeted ESLint clean.
Gate (e) is only half done: #11200 pins the cumulative round, but nothing calls `upsertRunUsage` from a live `USAGE_METADATA` stream until the dispatcher exists. Still unexecuted for step 5: wiring `runWithMeshRunContext` at the real turn seam, `acceptedMessageIds`/`consumedMessageIds` from the correlated `EXTERNAL_MESSAGE`, and registering these tools in a mesh agent's registry.

### Step 6 — Minimal in-process dispatcher, no recovery

Lands: pick the lowest `queueSequence` queued run per agent; branch on registry state `completed+resident → continue`, `completed → revive`, `paused → resume`, `unbound → launch`; atomically claim before starting the runtime, bind the returned session on success, release the claim on `capacity_wait`, and consume the parent-report outbox.
Gate: with a fake `AgentHeadless` that answers scripted text, (a) an assignment trigger on an open thread results in exactly one `startRun` and one `finishRun`; (b) two threads queued for one agent start in `queueSequence` order regardless of file enumeration order (test by creating the later thread with a lexically smaller id); (c) a child `thread_review` produces exactly one parent post carrying the event id, and re-running the consumer produces zero more.
Evidence: the three tests. No live model.

**Step 6 landed (core half).** `dispatcher.ts` selects each idle agent's oldest queued run by the lock-issued `queueSequence` — never `queuedAt`, never file order — and atomically claims it before the fire-and-forget runtime can execute. A second dispatcher therefore cannot launch the same run, and the ambient attempt is already durable before a first tool call. The prompt is assembled from the claimed record; a successful start binds the session and delivery watermark, while `capacity_wait` releases the claim and restores the unspent attempt. A failed or unavailable start is terminal and releases the queue slot. Parent reports drain through the outbox with the event id as the idempotency key; a second pass posts nothing more, and a notification no consumer claims stays pending rather than being acknowledged into silence.
Gate (a): one `startRun`/`finishRun` per assignment — covered. Gate (b): two threads queued for one agent start in `queueSequence` order regardless of file order — covered by `selectCandidates`. Gate (c): a child review produces exactly one parent post and a replay produces none — covered.
Observed locally: 11 files, 127 tests passed; targeted ESLint clean.
Writing the production port corrected the design's four-branch idle path to three. Whether a completed body still has a resident runtime is not a choice the dispatcher can make — only the registry knows, and #11204 already reports its own fallback — so a dispatcher choosing between "continue resident" and "cold revive" would be guessing at state it cannot see and would cold-revive a live body. The three entry points it does choose between are `launch`, `resume` (a restart-recovered `paused` entry, which the revive path rejects) and `continue_completed`.
`dispatch-port.ts` binds those to the runtime and is the single place a non-local runtime would be substituted (§9.12). Its tests pin the registry-state mapping, the hot path not touching the transcript, capacity reported before any mutation, a state change under it not being forced, and a thrown runtime error becoming a typed failure rather than a start.
**Runtime wiring landed for the demo path.** Every launch, resident continuation, resume, and revive persists the next run binding, and both real background-turn seams establish it inside the turn body. Mesh agents see the six thread tools while ordinary subagents do not. Structured resident delivery uses the run id as its correlation id; the consumed event advances that run's accepted/consumed ids and watermark, usage events upsert cumulative rounds, and body completion terminalizes the mesh run. Launch/revive inputs are marked consumed when the runtime accepts their initial prompt. This correction was deliberately not expanded with new test code or a local CI/build pass; step 7's live model run is the next evidence gate.

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

This proves the demo steps 1-5 only. The forced delivery miss, 12-turn
ping-pong, daemon reaper/reload observation, and bare-mode exposure remain
unrun, so the full step-7 gate is not yet claimed.

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
Mesh reuses the existing three-minute workflow watchdog, including its
tool-in-flight suspension, and requeues the first stalled attempt. Per the
demo-first instruction, no local tests, lint, typecheck, build, or CI wait was
performed for this implementation. Route startup now reopens owners for durable
live work or pending outbox events. Cancellation is source-first: the run is
persisted as `cancelling`, the dispatcher verifies the ambient runtime binding,
then stops the body and records terminal `cancelled`; queued cancellation also
wakes the dispatcher so the next FIFO item is not stranded. A racing runtime
completion observes `cancelling` and also settles as `cancelled`.
The hidden host owner is also bound to the selected workspace runtime
generation. A replaced or drained generation stops its keepalive loop and is
rejected before later launch or dispatch; generation checks bracket host claims
and releases, and a raced stale spawn is cleaned up. Reusing the same bridge
object cannot keep the old owner alive. This path was source-inspected only
under the same demo-first constraint.

### Step 9 — REST and Web Shell

Design direction is settled ahead of the build in [`2026-09-07-mesh-web-shell-design.md`](./2026-09-07-mesh-web-shell-design.md): the thread view is a ledger of outstanding obligations with the conversation as evidence, not a chat log with a status badge. It inherits Web Shell's existing tokens and adds no new colour or typeface. Step 9 renders `resolveThreadStatus`'s `status` and `reason` rather than inventing a second status vocabulary, shows one lane per agent that has worked the thread, and bounds every transcript view to the run's own slice.

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
was correctly rejected as an unknown agent name; creation-time routing preview
is not implemented yet.

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
enable/disable state; disabling or deleting is one workspace-locked mutation
that refuses live or queued work, so a booking cannot race the roster change.
The thread header also supports atomic human reassignment: changing the default
assignee writes a structured assignment through admission without cancelling
work already booked for another agent; choosing no assignee only clears the
future fallback.

### Step 10 — Channel notifications

Lands: four events to the channel workers.
Gate: with one configured channel, each event produces exactly one message, and a replayed outbox after a simulated crash produces at most one duplicate and never zero.
Evidence: the channel transcript.

## 3. Product decisions the implementer must not make

Open in §9 of the design: envelope role transport (§9.9), parent-to-child replies (§9.10), human blocker acknowledgement scope (§9.11), channel notification destination (§9.12), token reservation vs accounting (§9.5), and persona drift policy (§9.4). Until each is decided the implementation takes the conservative reading: user-role envelope, ambient-thread-only mutation, acknowledgement of every open blocker on a human post that books, notification events retained without broadcasting, accounting limit with overshoot, and definition read at revive only.

The owner settled three step-3 inputs: v1 denies every MCP tool; the v1 schema declares the full §3 shape in one migration; and runtime is a first-class concept, represented by generic `runtimeId` beside the local `backgroundAgentId`. Step 4 keeps the launcher surface minimal and supplies the local implementation first.

The relationship to the Agent Board (#9402) also remains the owner's call. §7.1's conservative v1 default keeps separate stores and distinct names and imports nothing from `board-*.ts` in step 3. The settled first-class runtime shape makes a later foreign-runtime adapter possible without deciding whether #9402 becomes its seed. MCP names fail closed unless a future policy can prove an individual tool preserves the read-only ceiling.

## 4. Working through stacked step PRs

- #11206 is the only PR that merges to `main`. Each numbered step gets one child PR whose base is `codex/multi-agent-mesh-foundation`; merge one child at a time, then use #11206's whole-branch CI as that step's gate before opening or merging the next.
- Child PRs do not run the repository's unit-test or lint jobs. Their named local tests are supporting evidence only; the required CI signal appears after merge on #11206.
- Runtime preparation was merged in the order #11200 → #11204 → #11202. The expected final conflict keeps both contracts: structured external input and typed continuation outcomes. GitHub automatically records those draft PRs as merged because their base is this branch; no PR was merged separately to `main` or manually closed.
- Merge `main` into the mesh branch when it falls behind; never rebase (repo policy, and the force-push bot).
- Keep the design doc and this file current in the same commit as the code that changes them.

## 5. Watch list — what the implementer keeps in view at every step

Ordered by how much damage a miss does. Each item names the step where it is proven.

1. **The close contract (§6) is the first thing a live model can break.** A run must end with `thread_wait`, `thread_block`, or `thread_review`; a plain final answer is `unclosed`. Nothing before step 7 proves a model will do this. Run step 7 as early as the plan allows, and record every prompt change together with the failure it fixed.
2. **Step 3 is where later bugs get blamed.** Sequence counter written before the thread file; outbox persisted before apply and acknowledged after; migration keeps the `.v0.json` backup until the migrated file reads back through the validator. Each has a crash-injection test in step 3's gate; do not weaken them to make the step land sooner.
3. **Ambient binding lives inside `runBody`, and mutating tools re-check it.** The per-turn `runWithMeshRunContext` frame is the only hard boundary against wrong-thread actions; the prompt frame is advisory. Every mutating tool reads the ambient triple and then verifies the run is still `running` on that thread before writing (step 5).
4. **No silent path.** Every admission result is persisted on the message and rendered; a quiescent thread with nothing runnable becomes `blocked`, never idle `in_progress`. Round 2 found more defects of this class than any other.
5. **Runtime hot paths change in isolated child PRs.** `agent-core.ts`, `background-tasks.ts`, `background-agent-resume.ts`, `agent-headless.ts`, `agent.ts` are shared with Agent Team and every subagent. Keep each such change minimal, pair it with its own tests, and merge it into the foundation without creating another PR to `main`.
6. **Trust labels are not boundaries.** Until §9.9 is decided, no prompt heading is called "trusted" and no code treats one as a policy input. Provenance is derived from the ambient run, never from model or HTTP input.
7. **Product decisions stay open until decided.** §9.4, §9.5, §9.9, §9.10, §9.11 and the #9402 relationship; the conservative defaults in §3 above apply meanwhile. Runtime shape, schema batching, and v1 MCP denial are settled in §3.
8. **Read the CI of #11206 after every numbered step.** Local and source-branch tests are supporting evidence; only the whole delivery branch is the gate.
