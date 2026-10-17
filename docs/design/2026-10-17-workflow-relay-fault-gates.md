# Workflow child_run relay fault gates FG10b, FG10c, FG10e, FG10f

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
This design covers the four letters that remain: **FG10b (lost replies),
FG10c (store failures), FG10e (cancellation) and FG10f (notification and
output delivery).**

The a+d design called these four "largely kind-agnostic". They are not
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
the lead's wake Turn reads it. The four letters pin that walk's
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

It touches **no production code**.

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

1. **Four letters, two slices.** Slice 1 = **FG10b + FG10f** — lost and
   delayed replies and stream continuity, no restart. Slice 2 = **FG10c + FG10e** — store
   refusals with a cold restart, and cancellation. FG10d stays with
   #14387. Each slice is its own PR and marks its letters delivered on
   #14165.
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
   this round arms a kill or a restart across a running workflow Turn;
   that is FG10d's.
4. **Pinned outcomes, not error codes.** As in FG9, a gate asserts what the
   record, the journals and the model saw, and attributes each fault by
   its own witness: a drop counter, a fire count, a held request.
   Intermediate error codes are recorded in the mechanics notes, not
   asserted, so a fix to a mislabel (#14419's kind) never reddens a gate.
5. **#13339 discipline.** New class only; every case proves its fault
   fired before its expectations; JDBC mutations are scoped to the case
   tenant; the lead's own Turn has settled before any refusal or restart
   arm (the FG9 slice-3 lesson).
6. **Closeability.** After slice 2 only FG10d remains on #14165, blocked
   on #14387. Whether the tracker stays open for it or hands it to #14387
   is the tracker owner's call, recorded on #14165 when slice 2 lands.

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
defers the step, spending an attempt on its creation row (the witness),
and only then is the hold released, so the step really ran twice. The
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

### FG10c — store failures (slice 2)

A test-only trigger on `ma_session_record`, scoped to the case tenant and
one Session and record shape, refuses every matching write until the case
drops it: the FG9b shape, `fg9b_fire`-style fire counts, exactly three
fires per refusal. Each case arms only after the child Turn completed
(decision 3), drops the trigger, and restarts the Harness cold.

| Case                      | Injection                                                                                       | Expect                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result-revision-refused` | Refuse the update of the lead's `child_run` record to `settled`, after the child Turn completed | While latched, the record stays `running`: never silently advanced, no notification, no wake. After the drop and the cold restart, the relay's retry settles it once (`completed`), one notification lands, and the script never re-runs: one `agent()` dispatch for the case, the child Turn untouched |
| `notification-refused`    | Refuse the lead's write that lands the notification input; the exact row is pinned at landing   | The record says the notification is owed: delivery never reads `consumed` while refused, and the `CHILD_RESULT` row's reception is not `accepted`. After the heal, exactly one notification and one wake round                                                                                          |

### FG10e — cancellation (slice 2)

The cancel is the public task cancel on the lead. The in-flight window is
a held `agent()` request at the scripted model, released only after the
case read the cancel's outcome.

| Case                        | Injection                                                                                                                                        | Expect                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-subagent-in-flight` | Cancel the workflow task while its `agent()` request is held                                                                                     | One `TASK_CANCEL` operation completes. The child Turn ends `CANCELLED`, and the record settles `cancelled` / `stop_requested`. No notification: the `CHILD_RESULT` reception never reads `accepted`. Nothing runs under the cancelled record: the `agent()` dispatch count stays one, and the held subagent's answer, released afterwards, never reaches the child journal. The task view reads `cancelled` |
| `cancel-reply-lost`         | The same window, with the cancel POST sent through a public-API proxy that drops its reply after it committed; the client re-issues the same key | The re-issue answers 202 `replayed: true` for the same operation, with one `TASK_CANCEL` operation and one request receipt for the key; every `cancel-subagent-in-flight` expectation                                                                                                                                                                                                                       |
| `cancel-after-settlement`   | Cancel a workflow task whose run already completed and was consumed                                                                              | 409 `task_action_unavailable`. No operation row; the record is unchanged (revision and state as before); no second notification                                                                                                                                                                                                                                                                             |

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
the uncapped setup steps.

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

Planned for slice 2, refined when it lands:

- FG10c — the relay advancing the record past a refused result revision:
  `result-revision-refused` red at the never-advanced assertion.
- FG10e — the child stop not aborting the in-process run (the abort
  signal dropped before `agent()`): `cancel-subagent-in-flight` red; the
  held answer reaches the child journal, or the child Turn completes.

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

## Open questions

1. Resolved at slice 1: the lead's wake Turn is not projected, the child
   Session's workflow Turn is, so FG10f cuts the child's streams (see
   FG10f's mechanics notes).
2. Which row `acceptChildResult` writes for the notification, and so
   where FG10c's `notification-refused` trigger sits. It is pinned at
   slice-2 landing against the committed shape.
3. The kind gate's re-check on every revision commitment, the a+d
   design's open question 1. These gates assert that `kind` is
   `workflow` at every revision. They cannot assert the re-check itself:
   the kind is enabled throughout, and no fault can disable it mid-run.
   The re-check stays with the functional tests of
   `managed-session-authority.ts`.
