# Workflow child_run relay fault gates FG10b–FG10f

[English](2026-10-17-workflow-relay-fault-gates.md) | [简体中文](2026-10-17-workflow-relay-fault-gates.zh-CN.md)

## Problem and scope

Issue #14165 is Stage F round FG10 of #12380 (umbrella #14054): fault
gates for the `child_run` `workflow` kind enabled by #13858. FG10a (digest
integrity) landed with #14390 under
[the a+d design](2026-10-16-workflow-fault-gates-ad.md); FG10d (process
crash) was deferred there with the production finding it caught, #14387 —
the recovery re-drove an unsettled workflow Turn after a Harness kill —
whose fix (#14461) makes the coordinator leave a bound, non-cancelling
workflow Turn unsettled instead of re-driving it.
This design covers the five letters that remain: **FG10b (lost replies),
FG10c (store failures), FG10e (cancellation) and FG10f (notification and
output delivery)**, plus **FG10d (process crash)**, which joined as slice 3
once #14461 merged (below).

The a+d design called the first four "largely kind-agnostic". They are not
free, though: every one of them lives in the record's **relay-driven
settlement** — the walk from the launch to the parent's notification —
which FG10a's driver-held parent could not reach (its parent attach
conflicts with the relay's operations, and the coordinator-owned
alternative needs workspace execution, which the macOS loop lacks). On
Linux the coordinator-owned parent is the FG9 fixture's team lead, and a
probe on it runs one background workflow child end to end in about ten
seconds: the lead's `workflow` call is admitted, the relay creates and
binds the child Session, the child Turn runs the script and its
in-process `agent()` dispatch, the result revision settles the record,
the notification lands on the lead as a `<task-notification>` input, and
the lead's wake Turn reads it. FG10b, c, e and f pin that walk's
workflow-specific promises under fault:

- **at most one workflow instance per launch** — one child Session, one
  run of the script, one `agent()` dispatch per call — whichever reply of
  the walk is lost (FG10b);
- a refused commit **leaves the record blocked, never silently
  advanced**, and the notification is never lost without the record
  saying so (FG10c);
- a cancel with an in-process subagent in flight **settles the record
  cancelled and leaves nothing running under it** — the subagent's answer
  never lands — while a lost cancel reply and a post-settlement cancel
  resolve honestly (FG10e);
- the notification is **delivered at most once**, and a stream cut
  mid-workflow resumes with no gap and no duplicate (FG10f).

FG10d (process crash) joins as slice 3 once #14461 merged. It lands here
rather than in the a+d design's driver-held class for the reason above:
what it pins after the kill — the record's blocked settlement, its ledger
and the lead's notification — is the relay-driven walk. Under it, a run
the Harness died under is **never re-executed and never settled as if
its outcome had been observed** (FG10d).

Slices 1 and 2 touch **no production code**. Slice 3 fixes the two
defects its gate found and a third its review found (FG10d's _Findings
fixed with the gate_).

## Current state

Verified at `main` = `3547398d2b` (2026-10-17), by source reading and by a
probe on the FG9 fixture (one background workflow with one `agent()` call).

- **The launch.** `workflow` is advertised to a top-level Session with a
  child-agent funnel and a shell or background lane
  (`packages/cli/src/serve/hosted-workspace-tool-turn.ts:1855-1862`) — the
  coordinator-owned team lead qualifies. `acceptChildWorkflow` (`:5802`)
  pins the definition, admits the launch through `childLaunchAdmission`
  and commits it through `admitWorkflow` (`startChildRun`, revision 1,
  `admitted`). Background is the default: the call answers at once
  ("started in the background as `task_…`"), and the result arrives later
  as a notification; "a failed or cancelled child produces no
  notification" (`:1483`).
- **The relay walk.** `ChildResultRelay`
  (`packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/ChildResultRelay.java`)
  drives `create` (`:464`) → `bind` (`:851`) → `watch` (`:887`) →
  `complete` (`:1062`) → `accept` (`:1148`) → `deliver` (`:1261`), each
  step reconciling from committed state, with `defer` (`:1385`) backing
  off `1 s << attempts` to 300 s over `MAX_ATTEMPTS = 64`. A stop runs
  `stopChild` (`:299`).
- **The commits one pass makes**, read from the store proxy's
  `op=` log:
  - lead: `startChildRun`; the relay's `commitChildRunRecord` ×2
    (dispatch, attach); the result `commitChildRunRecord`;
    `acceptChildResult` (the notification input); the wake Turn's commits;
    two more `commitChildRunRecord` (delivered, consumed);
  - child: `session.create`, `installActivation`, `submitInput`,
    `commitCheckpoint`, `commitMessage` ×2, `settleTurn`. The in-process
    subagent commits nothing of its own; its answer reaches the journal
    only as the workflow Turn's messages.

  The record walks revision 1 `admitted` → 3 `running` (child attached)
  → 6 `settled` / `completed`, delivery `consumed`. The relay ledger
  (`ma_delivery`) holds one `CHILD_RESULT` row,
  `delivered`/`accepted`/`consumed`.

- **Cancellation.** `workflow` is in `CANCELLABLE_TASK_KINDS`
  (`store/ManagedExtensionProjection.java:133`; actions `:244`), so the
  public `POST /v1/agents/sessions/{id}/tasks/{taskId}/cancel` admits a
  `TASK_CANCEL` operation. Probed with the `agent()` request held at the
  model:
  - the child Turn ends `CANCELLED` within three seconds, and the record
    settles revision 5 `cancelled` / `stop_requested`;
  - the `agent()` dispatch count stays one, and the `CHILD_RESULT` row's
    reception stays `pending` (no notification for a cancelled child);
  - the child Session's close is left as a debt;
  - a cancel after settlement answers 409 `task_action_unavailable`, and
    a re-issue under the same `Idempotency-Key` answers 202
    `replayed: true`.
- **A lost notification reply.** With the reply to the lead's first
  `acceptChildResult` dropped after it committed, the retry replays the
  original transaction and the lead holds exactly one
  `<task-notification>` input, read by one wake round.
- **Machinery from FG9** (#14164): the store-fronting lose-once/hold proxy
  with per-commit `op=`/`status=` logging (`journalCommits`), the
  trigger-plus-`fg9b_fire` store refusal and its mechanics — the store
  client retries an ambiguous 5xx three times, then the Session latches
  its writes and only a cold Harness heals it — the cold restart with its
  writer-generation witness, the public-API proxy for a lost client
  reply, and the in-JVM SSE observer.

## Scope decisions

1. **Five letters, three slices.** Slice 1 = **FG10b + FG10f** — lost and
   delayed replies and stream continuity, no restart. Slice 2 = **FG10c + FG10e** — store
   refusals with a cold restart, and cancellation. Slice 3 = **FG10d** —
   the Harness killed under a running workflow Turn, after #14387's fix
   (#14461) merged. Each slice is its own PR and marks its letters
   delivered on #14165.
2. **A new class on the FG9 fixture.** The letters live in
   `HostedWorkflowRelayFaultGatesIT`: Java-only, coordinator-owned lead,
   in-JVM Spring, the packaged Harness, a scripted model, selectors
   `-Dqwen.fg10b.case` … `-Dqwen.fg10f.case`, and evidence under
   `target/fg10-cases/<letter>/`.

   They do not join `HostedWorkflowFaultGatesIT`. FG10a's driver-held
   parent pins the digest at the child Turn by design, while these letters
   assert the record's settlement, which needs the coordinator-owned
   parent. The class name matches the existing `hosted-workflow-gates`
   focused profile.

   The fixture is a private copy, the #14147 convention FG8/FG9 follow,
   while `HostedSessionRelayForwardingProxy` is reused as it is: it is a
   generic store/API proxy with no FG9 semantics. Coordinator-owned
   workspace execution confines the class to Linux, as the lane is.

3. **Restarts land only after the child Turn settled.** A cold restart
   across a running workflow Turn is FG10d's ground: its recovery is what
   #14387 found and #14461 changes (the Turn is left unsettled rather than
   re-driven), and the FG10d gate pins it. So FG10c refuses only
   commits made after the child Turn completed — the result revision and
   the notification — and its restart reloads the lead alone. Nothing in
   slices 1 and 2 arms a kill or a restart across a running workflow Turn;
   that is FG10d's, in slice 3.
4. **Pinned outcomes, not error codes.** As in FG9, a gate asserts what the
   record, the journals and the model saw, and attributes each fault by
   its own witness: a drop counter, a fire count, a held request.
   Intermediate error codes are recorded in the mechanics notes, not
   asserted, so a fix to a mislabel (#14419's kind) never reddens a gate.
5. **#13339 discipline.** New class only; every case proves its fault
   fired before its expectations; JDBC mutations are scoped to the case
   tenant; the lead's own Turn has settled before any refusal or restart
   arm (the FG9 slice-3 lesson).
6. **Closeability.** After slice 2 only FG10d remained on #14165, blocked
   on #14387. With slice 3 every FG10 letter is delivered; closing the
   tracker is its owner's call.

## The gate ledger

Ground truth is JDBC: the lead's `child_run` record (`ma_session_record`
with its resource body), the `CHILD_RESULT` row in `ma_delivery`, the
`ma_operation` rows, the child Session's journal and `ma_turn`, the lead's
inputs, and the public-event ledger for FG10f's streams. The scripted
model's request log counts the workflow's `agent()` dispatches — a
subagent request is the one whose system prompt says it was spawned by a
workflow orchestration script — and is the in-flight witness for FG10e.
Every case asserts its fault actually fired.

The shared choreography: a fresh tenant and team lead per case; the
lead's first round calls `workflow` with a script making one `agent()`
call and returning its answer; its later rounds close with text. Slice
1's cases arm before the launch: their injections never latch a Session
or restart the Harness. Slice 2's refusal and restart arms wait for the
lead's own Turn to settle first.

### FG10b — lost replies (slice 1, delivered)

The relay's steps on the lead run as Harness child operations
(`runChildOperation`, a fresh `operationId` per attempt), so "the
original identity" is the Harness funnel's per-revision command id
(`<promptId>:<callId>:<revision>`), and before that the relay's own
reconciliation from committed state. A drop the store client re-drives
inside one commit call never reaches the relay at all — it is the
kind-agnostic replay FG9a already pins — so the two relay-step cases
**hold** the commit's reply past the relay's request timeout instead
(`qwen.managed-agent.harness.request-timeout` = 3 s for the letter, as
FG9f): the commit lands upstream, the relay's call times out and the relay
defers the step, and only then is the hold released, so the step really
ran twice. The witness is the relay's creation row spending one attempt
beyond the count read as the hold began: the count is cumulative over the
whole creation (an earlier bind may have deferred already), and while the
call is held the relay's one scan thread is blocked in it, so nothing else
of the row can spend that attempt — FG9f's baseline-plus-one. The
child Turn's own journal commit involves no relay step; it keeps the drop.

| Case                  | Injection                                                                                                                 | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-reply`      | Hold the reply to the lead's `dispatch_started` revision (`commitChildRunRecord`, revision 2) until the relay deferred it | One child Session, one `CHILD_SESSION_START` operation, one workflow run: one `agent()` dispatch at the model. The record walks once to `settled` / `completed` / `consumed`, revision 6, with `kind` `workflow`. Each of its five relay revisions is committed once, and the held one is never re-committed. One `CHILD_RESULT` row `delivered`/`accepted`/`consumed`, one notification carrying the script's return, one wake round on the lead |
| `child-message-reply` | Drop the reply to the child Session's first `commitMessage` (the workflow Turn's own journal) after it committed          | The dropped reply was the child Session's. The store client's replay lands the message once, the child Turn completes once, and the script ran once. Every `dispatch-reply` expectation holds                                                                                                                                                                                                                                                     |
| `result-reply`        | Hold the reply to the lead's `commit_result` revision (revision 4) until the relay deferred it                            | The record settles once — never a second terminal revision, still revision 6 — and is notified once, read in one wake round; the script never re-runs. Every `dispatch-reply` expectation holds                                                                                                                                                                                                                                                   |

### FG10f — notification and output delivery (slice 1, delivered)

| Case                  | Injection                                                                                                                                                                        | Expect                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-reply`  | Hold the reply to the lead's first `acceptChildResult` (the commit that lands the notification input) until the relay deferred the acceptance                                    | Exactly one `<task-notification>` input on the lead, read by one wake round. The record ends `consumed` once (revision 6), and the `CHILD_RESULT` row reads `delivered`/`accepted`/`consumed`                                                                                                                          |
| `child-stream-resume` | Hold the `agent()` request; open the child Session's public and WebShell streams, cut both once caught up, release the request, resume each by `Last-Event-ID` / `afterSequence` | The subagent's answer, the Turn's output and its terminal all commit while both clients are cut, as JDBC proves before the resume. Each resumed view is one sequence from 1, with no gap and no duplicate, frame for frame the ledger as that surface serves it, and carries the workflow Turn's terminal exactly once |

Mechanics notes recorded at landing:

- **Defense in depth on the re-driven steps.** A re-driven `commit_result`
  never reaches the Harness: the relay reads the committed record first
  (`settledAlready`, `ChildResultRelay.java:1035`) and, finding the
  result, goes straight to the acceptance. Behind it, the Harness funnel
  answers a replayed result from the committed copies
  (`settleCompleted`, byte equality, `hosted-child-agent-session.ts:1362`).

  A re-driven acceptance does reach the Harness, and meets the funnel's
  deep-equality check (`accept`, `:1505`). Behind that, the record contract
  refuses a second acceptance commit: even with the check and the
  `:accept` command key both removed, no second notification lands.

  Neutralizing any one of these layers is an equivalent mutant at these
  windows, so the slice's mutations remove all of them at once (see
  _Mutation checks_).

- The `CHILD_RESULT` ledger row is classified after the record's consumed
  revision lands, so the gates wait for both.
- The lead's wake Turn is not projected to its public stream (as FG9e
  found for member wake Turns); the workflow child Session's Turn is,
  from `turn.accepted` through `turn.completed`. FG10f therefore cuts the
  child's streams, not the lead's, whose ledger ends with the launch
  Turn.
- `child-stream-resume` asserts no extra notification, and so runs every
  `assertOneWorkflowInstance` expectation besides the streams.

### FG10c — store failures (slice 2, delivered)

A test-only trigger on `ma_session_record`, scoped to the case tenant, the
lead and one record shape, refuses every matching write until the case
drops it: the FG9b shape, with a MyISAM `fg10c_fire` count and exactly
three fires per refusal (the store client's bounded retry). The subagent
is held until the lead's own Turn settled, and only then is the trigger
armed and the subagent released. So the refusal latches an idle lead and
lands after the child Turn completed — never across a running workflow
Turn (decision 3) — and the case then drops the trigger and restarts the
Harness cold.

| Case                      | Injection                                                                                                                                  | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result-revision-refused` | Refuse the update of the lead's `child_run` record to its result revision (revision 4), after the child Turn completed                     | Three fires; the child Turn reads `COMPLETED`. While latched the record stays revision 3 `running` — never silently advanced — with no notification, no wake and no accepted `CHILD_RESULT` row. After the drop and a cold restart (a new writer generation holds the lead), the relay's retry settles the record once and the walk completes: every `assertOneWorkflowInstance` expectation, one `agent()` dispatch for the case — the script never re-ran |
| `notification-refused`    | Refuse the insert of the lead's `child_acceptance` record, the commit that lands the notification input with it, after the child completed | Three fires. While latched the record is settled (the result committed) but its delivery never reads `consumed`, and there is no notification, no wake and no accepted `CHILD_RESULT` row — the owed notification is visible in the record. After the heal, exactly one notification and one wake round, and every `assertOneWorkflowInstance` expectation                                                                                                  |

### FG10e — cancellation (slice 2, delivered)

The cancel is the public task cancel on the lead
(`POST /v1/agents/sessions/{lead}/tasks/{taskId}/cancel`, the task id being
`task_` + the record key of the `child_run`). The in-flight window is a held
`agent()` request at the scripted model, released only after the case
read the cancel's outcome. The held request is a live stream: its headers
go out at once and an SSE comment every 250 ms. The run settling
`cancelled` does not show that the subagent stopped — the sandbox's abort
race settles the run with its dispatch still in flight — so the case has
its own witness: a keepalive write failing while the hold is still
closed, which only a Harness that aborted the subagent's request itself
produces.

| Case                        | Injection                                                                                                                                        | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-subagent-in-flight` | Cancel the workflow task while its `agent()` request is held                                                                                     | 202, then the child Turn ends `CANCELLED` and the record settles `cancelled` / `stop_requested`. One `TASK_CANCEL` operation, with one admission under the key. Nothing runs under the cancelled record: the held `agent()` request is aborted while still held, the dispatch count stays one, and no answer reaches the child journal. No notification and no wake: the `CHILD_RESULT` reception never reads `accepted`. The task view reads `cancelled` |
| `cancel-reply-lost`         | The same window, with the cancel POST sent through a public-API proxy that drops its reply after it committed; the client re-issues the same key | The lost POST fails client-side, with the drop witnessed once. The re-issue answers 202 `replayed: true` for the same task, and every `cancel-subagent-in-flight` expectation holds — still one `TASK_CANCEL` operation and one admission under the key                                                                                                                                                                                                   |
| `cancel-after-settlement`   | Cancel a workflow task whose run already completed and was consumed                                                                              | 409 `task_action_unavailable`. No `TASK_CANCEL` operation; the record's revision is unchanged; every `assertOneWorkflowInstance` expectation still holds (one notification, one wake round)                                                                                                                                                                                                                                                               |

Mechanics notes recorded at landing:

- The notification is the `child_acceptance` record's own commit: its
  first revision is inserted in the transaction that carries the
  notification input (open question 2).
- A refused relay write latches the lead (FG9b's mechanics); the relay
  keeps re-driving with backoff until the cold restart reloads the lead,
  and then resumes from the committed state.
- A task cancel keeps its idempotency key on its `TASK_CANCEL` admission
  row in `ma_operation` (unlike the session-event cancel of FG9d, which
  writes `ma_request_receipt`), so "one request receipt" is one admission
  under the key.
- A workflow Turn honours its stop through two paths: the Turn's abort
  signal handed to `WorkflowRunner.start`, and the abort listener calling
  `handle.abort()` (`hosted-workflow-turn.ts:261-278`). Either alone stops
  the run.
- The run's stop reaches its in-flight `agent()` dispatch only through
  the run controller's signal, handed to `createProductionDispatch`
  (`workflow-runner.ts:519-523`). Without it the run still settles
  `cancelled`, the child Turn `CANCELLED`, and the answer released later
  lands nowhere; only the aborted-request witness tells the two apart
  (mutation 9).
- #14456 (merged while slice 1 was in review) changed
  `TaskCancelCoordinator`'s reconciliation of parked rows; the live cancel
  path these cases drive is green on top of it.

### FG10d — process crash (slice 3, delivered)

The packaged Harness is SIGKILLed under an **attached** run (the record
reads `running_attached`) after the lead's own Turn settled, and a cold
one starts on the same port. Two windows:

- the run's `agent()` request is held at the model. Its abort, a failed
  keepalive write (FG10e's witness), shows that the kill took the
  in-flight subagent with it;
- the run's work is done — its answer is in the child journal — and the
  child Turn's settlement commit is swallowed at the store, never
  forwarded, so the kill lands before that commit leaves the wire. The
  swallow is the deterministic form of the a+d design's
  settlement-observed kill.

| Case                                         | Injection                                                                                                                                                  | Expect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill-mid-workflow-subagents-in-flight`      | SIGKILL the Harness while the run's `agent()` request is held; start a cold one                                                                            | The kill aborts the held request. Nothing settles the Turn while no Harness runs. After the restart the Turn stays `RUNNING`, marked `hosted_workflow_recovery_blocked` — never settled — and the restarted Harness answers the child's load `hosted_turn_recovery_required`. The record settles `recovery_blocked` / `outcome_unknown` / `runtime_lost`, with no stop reason and no result, its `definitionDigest` still the script's sha256. Never re-executed: one `agent()` dispatch, no answer in the child journal, no Turn result reading `completed`. The `CHILD_RESULT` row reads `unknown/pending/pending`, the walk's ledger row `unknown`. The lead gets one `<status>blocked</status>` notification whose result line says the run is recovery blocked (outcome unknown), read by one wake round |
| `kill-after-last-subagent-before-settlement` | Let the subagent answer and swallow the child Turn's `settleTurn` commit at the store; SIGKILL the Harness while it waits on that commit; start a cold one | The swallow is witnessed once and the swallowed command never passes through. The run's answer is in the child journal exactly once, and stays so. Every other `kill-mid-workflow-subagents-in-flight` expectation holds: the work that finished is not taken for an observed outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Mechanics notes recorded at landing:

- The coordinator's in-flight drive of the child Turn fails with the
  Harness and retries with backoff (1, 2, 4, 8 s). The first drive
  against the cold Harness takes the recovery path (the Session is
  bound). The restarted Harness's takeover load first meets the dead
  writer (`managed_session_writer_conflict`), then refuses with
  `hosted_turn_recovery_required` / `takeover_unrecovered`, and the
  coordinator's takeover-refusal arm parks the Turn blocked. The relay
  settles the record on its next scan, about 20 s after the restart in
  both windows. The reason is a mechanics fact, not an expectation
  (decision 4); the gate asserts the refusal and the mark.
- Before refusing, the takeover closes the child journal's Turn as
  interrupted (`cancelled` / `harness_interruption`, a journal fact),
  while the managed Turn row stays `RUNNING` and marked. That commit is a
  new command, never the swallowed one.
- A blocked background child owes its parent a notification
  (`settleRecoveryBlocked` commits it with the record and kicks the
  idle lead), so FG10d expects exactly one notification and one wake,
  not none.
- The relay is the walk's only writer after the restart: the lead itself
  is idle and reloads on demand.

**Findings fixed with the gate.** On the first runs the gate went red on
two production defects. Both were in the honest-settlement path #14461
added, and slice 3 fixes them:

1. **A close debt rewrote the walk's classification.** This fixture's
   host cannot close a Workspace Session, so every settled arm retains a
   close debt. `ChildResultRelayStore.advance(close_debt)` retired the
   walk `done` and its `CHILD_RESULT` row `delivered` whatever the arm
   proved. The `unknown` that the recovery-blocked arm (#14461) and the
   relay's give-up chain intend therefore read as a delivered result
   wherever the close is not admitted at once. The debt now parks under
   the walk's own classification (`retainCloseDebt`), exactly as the
   closed arm's `classify` does. Unit tests pin both classifications
   (`ChildResultRelayStoreTest`) and the blocked arm passing `unknown`
   (`ChildResultRelayTest`).
2. **The blocked notification described the running revision.**
   `settleRecoveryBlocked` rendered the parent's notification from the
   record it replaces, so under `<status>blocked</status>` the result
   line read "Workflow child run running (unknown).". It now renders the
   blocked revision it commits, as a unit test in
   `hosted-child-agent-session.test.ts` pins.

Review found a third, which fix 1 widened:

3. **An `unknown` child start held its parent's collection forever.**
   `SessionResourceCollectionCollector` holds a retired parent's
   resources while a `CHILD_SESSION_START` walk is not `done` or
   `orphaned`. But `unknown` is just as terminal: the relay's discovery
   page and claim exclude it, and nothing rewrites it. So an `unknown`
   walk held the collection with no release, wherever the close is
   admitted at once, and fix 1 carried the same hold to hosts without
   close capability. The collector now treats `unknown` as terminal. An
   owed close rides its own `CHILD_SESSION_CLOSE` row and reads no parent
   resource, so it does not hold the collection either, as before.
   `SessionResourceCollectionCollectorTest` pins the hold and its release
   for all three classifications.

## Fixture design

**Shape.** `HostedWorkflowRelayFaultGatesIT` is the FG9 class's fixture
re-cut for one parent and one child:

- one in-JVM `ManagedAgentServerApplication` per letter, MySQL
  properties mandatory, Spring and the embedded broker on ephemeral ports
  read back after boot;
- the packaged Harness on a pre-picked port, with its log appended
  across restarts;
- per case a fresh tenant, a seeded workspace, and a team lead created
  through `insertInternalTeamLeadSessionCommand` and the public input
  route.

**The scripted model.** It recognizes three requests: the lead's (its
case marker), the wake round's (the same marker with the notification in
the history), and a subagent's (its system prompt). The lead's plan is
the `workflow` call with the case's script, then closing text. A
subagent answers a fixed text, or parks on the case's latch for FG10e and
FG10f, which is the in-flight witness. The scripts are plain ASCII with
one `agent()` call, and the case asserts the result text it returns.

**Proxies.** The store proxy fronts the Session-Store boundary for every
Session, lead and child. Its rules arm by commit operation and the
child_run revision in the command id, and its log now names each commit's
command id beside its operation and status, so a replay is told from a
new step. FG10b and FG10f run with the Harness request timeout at 3 s, so
a reply held past it outlives the relay's call. A second instance fronts
the public API for FG10e's lost cancel reply.

**Refusals and restarts** (slice 2) are FG9b's `refuse`/`dropRefusals`,
fire table and `restartHarness` with the writer-generation witness,
applied only after the child Turn settled.

**Kills** (slice 3) reuse `killHarness`, the kill half of
`restartHarness`. The store proxy gains a `SWALLOW` disposition, which
never forwards and answers 503 once released. The proxy runs every
handler on its one dispatcher thread, so a swallow (like a hold) stalls
all store traffic while it waits. FG10d therefore releases it as soon as
the kill is confirmed, before the cold Harness needs the store; the 503
then meets a closed connection.

**CI.** The class name places it in the `hosted-harness-mysql` lane
(`Hosted*IT`; `check-failsafe-reports.js hosted` enforces it ran), and the
existing `hosted-workflow-gates` profile runs it locally. Each slice
re-derives the shared fork budget by **composing** its measured cost with
whatever sibling rounds moved meanwhile, never by overwriting the
literal (the #14420 review lesson), and updates
`scripts/tests/hosted-process-ci.test.js` with a per-class ceiling block.
`target/fg10-cases/` is already among the uploaded report paths.

Slice 1 measures the class at 81.6–81.7 s healthy locally across three
runs (FG10b ~44 s, FG10f ~38 s), ~165 s budgeted at 2× as FG10a did. That
composes with main's allowance after FG9 slice 3 (#14420): 3380 + 165 ≈
3545 s. One 600 s ceiling plus that needs a fork of at least 4145 s, so the
fork moves 3990→4155 s. The Verify step, which wraps the fork plus its
600 s, moves 80→85 minutes (345 s of margin; 80 would leave 45). The job
ceiling moves 325→330 to stay above the summed step ceilings (315) plus
the uncapped setup steps. The per-letter slack is then 10 s (600 + 3545 =
4145 against 4155), so slice 2 on the same class re-measures the whole
class and composes its own cost the same way rather than carrying slice
1's number forward.

Slice 2 re-measures the four-letter class at 181.2–181.6 s healthy locally
across three runs (FG10c ~64 s, FG10e ~47 s, the slice-1 letters
unchanged), ~363 s budgeted at the same 2×, 198 s over slice 1's 165 s. It
composes onto main's allowance after slice 1: 3545 + 198 ≈ 3743 s. One
600 s ceiling plus that needs a fork of at least 4343 s, so the fork moves
4155→4353 s. The Verify step moves 85→90 minutes (447 s of margin; 85 would
leave 147), and the job ceiling moves 330→335 to stay above the summed
step ceilings (320) plus the uncapped setup steps.

Slice 3 re-measures the five-letter class at 246.1–246.8 s healthy
locally across three runs (FG10d ~65 s, the other letters unchanged),
~494 s budgeted at the same 2×, 131 s over slice 2's 363 s. It composes
onto main's allowance after slice 2: 3743 + 131 = 3874 s. One 600 s
ceiling plus that needs a fork of at least 4474 s, so the fork moves
4353→4484 s. The Verify step's 90 minutes still wrap the fork plus its
600 s (316 s of margin), so the Verify step and the job ceiling (185 since
#14467 moved the failover arms to their own job) stay as they are.

## Mutation checks

Each mutation is applied, shown to turn exactly its case red, then
reverted. The Harness-side ones patch the packaged bundle's chunks in place
and restore them byte for byte; the Java ones patch the source.

Slice 1, each run against its case alone (`-Dqwen.fg10b.case` /
`-Dqwen.fg10f.case`):

1. FG10b — an identical `dispatch_started` restatement conflicts instead of
   resolving (`dispatchStarted`'s no-op arm removed): `dispatch-reply` red;
   the re-driven dispatch fails forever and the record never leaves
   `running`.
2. FG10b — the store client's retry mints a fresh transaction identity:
   `child-message-reply` red; the replayed message is refused as a new
   transaction behind the one that landed, and the walk never completes.
3. FG10b — the relay re-commits a settled result, and the Harness takes it
   as a new settlement (`settledAlready`'s result arm and
   `settleCompleted`'s replay check both removed): `result-reply` red; the
   second terminal revision is refused, and the record never leaves
   `accepting`. Either layer alone is an equivalent mutant here.
4. FG10f — a re-driven acceptance is neither checked nor keyed by its run
   (`accept`'s replay check removed and its command id salted per call):
   `notification-reply` red. The record contract still refuses the second
   acceptance, so no second notification lands, but the relay never
   classifies its row. Either change alone is an equivalent mutant.
5. FG10f — the public `Last-Event-ID` cursor read one short:
   `child-stream-resume` red with a duplicate at the resume boundary.

Slice 2, each run against its case alone (`-Dqwen.fg10c.case` /
`-Dqwen.fg10e.case`):

6. FG10c — a deferred relay step is not retried once the store heals (its
   backoff runs away to a day): `result-revision-refused` red. Nothing
   re-drives the refused step after the drop, so no new writer ever takes
   the lead and the walk never resumes. Two narrower mutations are
   equivalent here:
   - the Harness answering the refused result commit as committed:
     the relay's next step meets the latched lead, and after the restart
     it reconciles the record still at revision 3 and commits the result
     itself;
   - the relay giving up on the first failure (its attempt bound
     collapsed): the give-up chain settles from the committed truth,
     a completed child Turn, and lands the same result.
7. FG10c — the Harness answers a refused acceptance as committed:
   `notification-refused` red; the relay moves on, and the walk never
   reaches `consumed`.
8. FG10e — the child stop never reaches the in-process run (the abort
   signal handed to `WorkflowRunner.start` and the `handle.abort()`
   listener both dropped): `cancel-subagent-in-flight` red; the child Turn
   never leaves `CANCELLING`. Either path alone stops the run.
9. FG10e — the run's stop not forwarded to its `agent()` dispatch (a fresh
   signal handed to `createProductionDispatch` in place of the run
   controller's; the workflow's own cancellation intact):
   `cancel-subagent-in-flight` red at the aborted-request witness. The run
   still settles `cancelled` and the child Turn `CANCELLED` first, so
   without that witness the case passed.
10. FG10e — the task cancel's request digest not stable across a retry (a
    per-call nonce): `cancel-reply-lost` red; the re-issued cancel answers
    409 instead of replaying the committed admission.
11. FG10e — a settled task still advertising and admitting cancel
    (`completed` added to the cancellable states):
    `cancel-after-settlement` red; the cancel is admitted with 202 instead
    of 409 `task_action_unavailable`.

Slice 3, each run against its case alone (`-Dqwen.fg10d.case`); the
Harness-side mutation patches the packaged bundle's chunk and restores it
byte for byte, the others patch the Java source:

12. FG10d — the coordinator no longer recognizes a workflow Turn
    (`isWorkflowLaunchTurn` always false), so every #14461 refusal arm is
    off: `kill-mid-workflow-subagents-in-flight` red at the mark. The
    takeover's refusal keeps the drive on the generic retry path — five
    retries by the time the case gives up — so the Turn is never parked
    and the record never settles.
13. FG10d — the relay ignores the recovery-blocked mark on the Turn line:
    `kill-mid-workflow-subagents-in-flight` red; the Turn parks marked,
    but the record stays `running`.
14. FG10d — a close debt retires every walk `done` (slice 3's relay fix
    reverted): `kill-after-last-subagent-before-settlement` red at the
    ledger, whose `CHILD_RESULT` row reads `delivered/pending/pending`.
15. FG10d — the blocked notification renders the running revision it
    replaces (slice 3's Harness fix reverted):
    `kill-after-last-subagent-before-settlement` red at the notification,
    whose result line reads "Workflow child run running (unknown).".

The fixes' unit tests are red with their fix reverted:
`ChildResultRelayStoreTest.retainsACloseDebtUnderTheWalksOwnClassification`
and, in `ChildResultRelayTest`,
`aBlockedRunWithoutCloseRetainsTheDebtUnderUnknown`,
`aGiveUpWithoutCloseSupportRetainsItsCloseDebt` (red when the give-up arm passes
`done`) and `aHostWithoutCloseSettlesAndRetainsTheCloseDebt` for the
relay; `tells a background child's parent the run is blocked, not
running` in `hosted-child-agent-session.test.ts` for the Harness; and
`SessionResourceCollectionCollectorTest.aChildStartHoldsCollectionOnlyUntilTheRelayClassifiesIt`
(its `unknown` case) for the collector.

## Validation and acceptance

- The new class green on a local MySQL 8.4, three consecutive full-class
  runs per slice, every case's fault witnessed; per-letter selectors
  working.
- Each slice's mutations individually red, source restored, the gate
  green again.
- The module's `mvn verify` (surefire, Checkstyle, SpotBugs) and the
  workflow/pom meta-tests green, with the composed budget.
- This design lands in both languages with slice 1; each slice records
  its letters on #14165.
- Slice 3's three fixes ship with their unit tests, each shown red with
  its fix reverted.

## Open questions

1. Resolved at slice 1: the lead's wake Turn is not projected, the child
   Session's workflow Turn is, so FG10f cuts the child's streams (see
   FG10f's mechanics notes).
2. Resolved at slice 2: `acceptChildResult` inserts the
   `child_acceptance` record with the notification input in one
   transaction, so FG10c's `notification-refused` trigger refuses that
   insert.
3. The kind gate's re-check on every revision commitment, the a+d
   design's open question 1. These gates assert that `kind` is
   `workflow` at every revision. They cannot assert the re-check itself:
   the kind is enabled throughout, and no fault can disable it mid-run.
   The re-check stays with the functional tests of
   `managed-session-authority.ts`.
