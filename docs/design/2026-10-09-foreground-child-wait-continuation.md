# Foreground child wait continuation (restart-recoverable)

[English](2026-10-09-foreground-child-wait-continuation.md) | [简体中文](2026-10-09-foreground-child-wait-continuation.zh-CN.md)

Status: proposed. Tracks GitHub issue #13708, the deferred P1 carried past the
merge of #13550 (H4b child Session runtime).

## Problem

A **foreground** child-agent call in a Hosted Workspace Turn skips the Runtime
reservation — correctly, since the child's execution belongs to the
control-plane relay, not this Turn's Broker pipeline. But skipping the
reservation also skips the only durable checkpoint of the wait
(`commitAwaitRuntimeBatch`), and agent calls write no `tool.intent` (the Broker
pipeline they bypass owns that marker). Nothing durable records that this Turn
is waiting on admitted child runs.

If the Hosted process stops after `children.admit()` and before the tool result
commits:

1. The Harness checkpoint still names the pre-agent phase
   (`model_output_committed`), which `recoverHostedRuntimeTurn` can only
   classify as `declined('model_start')` — or `unresolved_after_settle` when
   the checkpoint names a different Turn.
2. Every later Turn of the parent meets `hosted_turn_recovery_required`.
3. The child run sits at `binding`/live in the ledger, the child Session stays
   ACTIVE, and its committed result is never consumed.
4. Close/delete of the wedged parent can never pay the cascade debt: every
   cascade step rides `runLifecycleChildOperation` against the parent's own
   Harness session, which never becomes attachable, so close stays `CLOSING`
   and delete answers 409 `session_state_conflict` (rig round 9).

## Current state (verified against `origin/main` after #13550)

- `hosted-workspace-tool-turn.ts#acceptChildAgent` admits the child and enters
  `awaitChildToolResult`, an in-memory 250 ms polling loop over
  `children.record` / `children.acceptance`. No checkpoint commit happens
  between admission and the `tool_result` commit.
- `managed-harness-checkpoint.ts` phases are
  `before_model | model_output_committed | await_action | await_runtime |
results_ready | turn_settled`. Durable waits exist for approvals
  (`await_action` + `approval` group) and Runtime batches (`await_runtime` +
  `tools`/`runtime` groups). Nothing names an agent wait.
- `recoverHostedRuntimeTurn`
  (`packages/cli/src/serve/hosted-runtime-recovery.ts`) drives
  `await_runtime`/`results_ready`, resolves requested approvals, answers
  `inapplicable` for `turn_settled`, and declines everything else.
- The recovery-wire protocol is validated Java-side:
  `HostedHarnessClient.RUNTIME_RECOVERY_PHASES = {"await_runtime",
"results_ready"}`; `HarnessRuntimeRecovery.isContinuationReady()` /
  `isCancellationReady()` gate `HarnessCoordinator`'s
  `recoverManagedRuntime` admission — a non-null recovery report whose ready
  predicate is false **fails the Turn** (`managed_runtime_recovery_incomplete`),
  and any execution with outcome `unknown` fails it
  (`managed_runtime_recovery_blocked`). On success the coordinator issues
  `continueManagedRuntime` / `cancelManagedRuntime` back to the daemon.
- `ToolPublicationStore.requireCheckpoint` (dispatch authorization for Shell
  publication) requires phase `await_runtime`; an `await_agent` checkpoint can
  never reach that path (Runtime work and the agent wait are mutually
  exclusive), so it is audit-only, unchanged.

## Goals

1. A restarted Harness re-enters the foreground wait instead of declining the
   Turn (interruption point 1: after admission).
2. A child answer committed while the parent was dead is folded into the
   original tool call exactly once (interruption point 2: after the
   result/acceptance commits).
3. A wedged parent becomes closeable and deletable through the API once its
   Session is attachable again (probe 3 of #13708).
4. The rig's two independent TypeScript foreground-recovery expectations —
   red by construction today — turn green.

## Non-goals

- No change to background (`run_in_background: true`) delegations; they are
  unaffected by the defect.
- No new Runtime/Broker path: the child executes on the control-plane relay.
- No `tool.intent` synthesis for agent calls; the wait gets its own checkpoint
  group instead.
- No schema-version bump: the additions keep checkpoint schema 1 (new phase
  value + new optional group; older daemons classify an unknown-phase
  checkpoint as `checkpoint_blocked`, never as a wrong verdict).

## Proposed design

### 1. Checkpoint: `await_agent` phase + `agentWait` group (core)

`packages/core/src/managed-runtime/managed-harness-checkpoint.ts`:

- `HARNESS_CHECKPOINT_PHASES` gains `'await_agent'`. It is deliberately **not**
  in `HARNESS_MODEL_START_PHASES`: it is a wait, not a model-start safety
  point.
- New group:

  ```ts
  interface HarnessAgentWaitRun {
    readonly childRunId: string;
    readonly functionCallId: string;
    readonly toolName: string;
    readonly modelMessageId: string;
    readonly consumed: boolean;
  }
  interface HarnessAgentWaitGroup {
    readonly runs: readonly HarnessAgentWaitRun[];
  }
  ```

  `HarnessCheckpointV1.agentWait: HarnessAgentWaitGroup | null`, added to
  `ROOT_KEYS` and the parser. Every existing constructor sets `agentWait`
  explicitly (carried over only where a wait may persist across an adjacent
  checkpoint; otherwise `null`) **except**
  `createHookStoppedRuntimeHarnessCheckpoint`, which spreads `previous` —
  sound because its `results_ready` precondition cannot carry a group
  (`assertPhaseShape` fails any `results_ready` that does), so the spread can
  only ever see `null`. The encode omits the key whenever no group rides the
  checkpoint: an absent key parses as `null` on both reader generations, so a
  pre-`agentWait` daemon can still open every non-agent checkpoint, and only
  checkpoints that actually carry the group become unreadable to an older
  reader. (Earlier drafts also carried `partIndex`/`ordinal`/`inputDigest`;
  the round a resume re-derives from the journal itself, so the record keeps
  only fields with a live consumer — the schema was trimmed before merge, and
  since the group is new in this PR no stored bytes can carry them.)

- New constructor `createAwaitAgentHarnessCheckpoint`: phase `await_agent`,
  `approval: null`, `tools`/`runtime` carried from the previous checkpoint,
  `agentWait` set. It refuses while a `requested` approval or an
  `await_runtime` batch is live (one durable wait domain at a time — the same
  discipline as `commitDurableWait` vs `commitAwaitRuntimeBatch`).

### 2. Harness handle: `commitAwaitAgent` / `resolveAwaitAgent` (core)

`packages/core/src/managed-runtime/managed-harness-factory.ts`:

- `commitAwaitAgent(runs, { turnId, promptId })` commits the wait with the
  same transaction discipline as `commitAwaitRuntimeBatch` (one
  `commitHarnessCheckpoint` under `HARNESS_DURABLE_WAIT_BOUNDARY`; turn-binding
  rules identical). `turn` is required — the absent branch would skip both
  the binding guard and the activation adoption. Boundary-side validation
  mirrors the parser: duplicate `childRunId`/`functionCallId` and
  already-`consumed` runs are refused at the call instead of becoming a
  durable-blocked checkpoint at the next read. Replay-safe: restating the
  identical run set against an existing `await_agent` wait answers the same
  boundary; a conflicting set conflicts, never rewrites.
- `resolveAwaitAgent(childRunId)` marks one run `consumed`. It does **not**
  remove the run; while runs remain the phase stays `await_agent`, and with
  every run consumed the continuation advances to `model_output_committed`
  **carrying** the fully-consumed group — the folded results owe the next
  model round, and the carried group keeps the wait re-enterable for a
  second crash: §4's branch classifies exactly that shape instead of ever
  reading settled work as `model_start`.

### 3. Turn arm: commit at admission, resolve after the fold (cli)

`packages/cli/src/serve/hosted-workspace-tool-turn.ts`:

- `acceptChildAgent` (foreground arm) commits `commitAwaitAgent` immediately
  after `children.admit` succeeds, naming
  `{ childRunId, functionCallId: call.callId, toolName: call.name, ... }` from
  the admission. The admit→checkpoint gap is two statements. A crash inside it
  before any wait carries no `agentWait` group, so the checkpoint reads as the
  bare `model_output_committed`/`before_model` it always was — the
  pre-existing `model_start` verdict, the same window the Runtime batch
  family already accepts between its intent commits and
  `commitAwaitRuntimeBatch`. A crash in that same gap with an earlier wait
  already consumed in the batch leaves the carried all-consumed group: the
  child's ledger record survives, and §5's gap fill is ledger-honest about
  it — an admitted orphan drives to its own terminal and folds what really
  happened (never the fabricated never-admitted answer), while a call with
  no ledger record still takes the honest never-admitted fold.
- `awaitChildToolResult` calls `resolveAwaitAgent(childRunId)` after every
  terminal fold — the acceptance fit+commit, the failed/cancelled error fold,
  and the aborted-wait abandoned fold — so each outcome is marked consumed in
  the same breath as its `tool_result` commit.

### 4. Recovery: `await_agent` reconstructor (cli)

`packages/cli/src/serve/hosted-runtime-recovery.ts` gains a phase branch
before the Runtime branch:

- Read the wait's runs from `checkpoint.agentWait`; classification is
  checkpoint-sourced only — `consumed` reads as `settled`, outstanding as
  `executing`. The relay ledger is consulted only by §5's resume-arm poll,
  never by the classifier.
- **Classification only — the fold belongs to §5.** Recovery is used by both
  the plain attach and the takeover paths, but only the route's resume arm
  owns the Turn's commit channel, the inline fit predicate and the
  consumption set. Recovery therefore never commits on this branch.
- **Report what remains (interruption point 1):** runs that are neither
  settled nor folded stay outstanding. The report uses
  `phase: 'await_agent'`; each run maps to an execution entry
  `{ executionCallId: childRunId, functionCallId, toolName, outcome: 'known',
status: { state: 'executing' } }` when waiting and
  `{ ..., status: { state: 'settled' } }` when folded. Outcomes are always
  `known`: the relay ledger makes a waiting child an observable fact, never an
  unknown outcome, so the coordinator's `managed_runtime_recovery_blocked`
  gate cannot fire on this phase. Each entry also carries
  `runtimeSessionId` — required on the wire for every execution entry — filled
  with `hostedRuntimeSessionId(promptId)`: this phase holds no Runtime
  session, the hosted runtime-session identity of the parked Turn rides the
  field, and no consumer reads it today.
- **The carried group closes the second-death window:** the branch also
  classifies `model_output_committed` checkpoints that still carry an
  `agentWait` group — by the phase-shape invariant that group is fully
  consumed (a model round is owed), so the same `await_agent` report shape
  (every run `settled`) routes the takeover into the continue arm instead of
  ever falling back to `model_start` with settled work on the line.
- A passive load answers the same classification without folding (no commit
  authority), so the coordinator learns the truth on a read-only attach.

### 5. Continue route: re-enter the waiter (cli)

The daemon's `continueManagedRuntime` route (the one the coordinator already
issues for `results_ready`) gains an `await_agent` arm:

- The route's pre-admission phase gate widens to three continuable shapes:
  `results_ready`, `await_agent`, and `model_output_committed` carrying an
  `agentWait` group (the same wait a breath past its last fold).
- The arm instantiates a fresh `HostedWorkspaceToolTurn` in resume mode and
  runs its agent-wait reconstruction (`resumeAgentWaitRuns`): for every
  unconsumed run, the same poll `awaitChildToolResult` runs live — against
  the live `children` view re-created from the authority — folding each
  terminal outcome into the original tool call. **Exactly-once is the
  journal, not the process:** the arm builds the journaled set from the
  Turn's committed `tool_result` ids; a replayed resume skips only the
  commit, while `markAccepted` and `resolveAwaitAgent` still run because
  both are replay-safe. After folding, the route re-projects the journal so
  the resume request (`resumeFromToolResults`) carries the fold's own
  tool result into the next model round.
- **The gap fill (`fillParkedRoundAgentGaps`):** a foreground batch parks
  with some later calls of its last assistant round never reached by the
  dead loop — the durable wait names only the admitted ones. The fill takes
  the checkpoint's `agentWait.runs` (fresh from the run authorization: the
  round is the one the wait's `modelMessageId`s name, never whatever
  assistant record came later), the Turn's assistant record, the journaled
  `tool_result` id set, and the session's child ledger; it answers each
  remaining function call so the resume request is well-formed. Three
  answer shapes, exactly once each behind the journaled set (which gates
  the fold only — the replay-safe marks still run): a call with no ledger
  record fills the never-admitted answer (per-family wording: the continue
  route and the interrupted-turn funnel name the interruption, the cancel
  route names the cancellation, so the durable journal never asserts a
  cause that never happened); a call whose child was admitted in the
  admit→commit gap drives to its own terminal through the same poll the
  live wait ran and folds what really happened (a background-completion
  record folds the live arm's started receipt instead of being polled);
  and a leftover from the wait's own carried group is not a gap at all —
  its marks belong to the wait arm. The same fill runs on the cancel
  route and from the interrupted-turn funnel's settlement.
- Cancellation (`CANCELLING` takeover + `cancelManagedRuntime`) settles an
  `await_agent` wait deterministically: each unconsumed run gets a cancelled
  `tool_result` fold ("The turn was cancelled before the child agent
  finished; the child keeps running and its committed result is retained." —
  the live arm's own vocabulary) plus `resolveAwaitAgent`, guarded by the
  same journaled dedupe, and the Turn settles as cancelled. The abandoned
  child is not revoked; its ledger line belongs to the relay.

### 6. Wire protocol (Java, qwencode + managed-agent-server)

- `HostedHarnessClient.RUNTIME_RECOVERY_PHASES` gains `"await_agent"`.
  `RUNTIME_EXECUTION_STATES` already contains `"executing"` and `"settled"`;
  no new wire value is needed because a waiting run reports `executing` (the
  child run is literally still running).
- `HarnessRuntimeRecovery`:
  - `isContinuationReady()` := (`results_ready` with all settled) **or**
    (`await_agent` with non-empty executions, all `known`). The coordinator's
    existing success path (`continueManagedRuntime`) is exactly the
    re-entry the daemon implements in §5.
  - `isCancellationReady()` := (`await_runtime`/`results_ready` rules) **or**
    (`await_agent` with all `known`), routing the cancel to §5's settlement.
- `HarnessCoordinator` needs no branch change: both predicates already decide
  its `managed_runtime_recovery_incomplete` gate, and
  `hasUnknownOutcome()` never fires on this phase.
- `ToolPublicationStore.requireCheckpoint`: unchanged and unreachable for
  `await_agent` (mutually exclusive wait domains).

### 7. Close/delete of a previously wedged parent (probe 3)

No close-path code changes. The defect made close/delete impossible because
the cascade's `runLifecycleChildOperation` needs the parent's Harness session
attachable, and attachment was refused by `hosted_turn_recovery_required`
forever. Once §4–§5 make the takeover load attachable and the parked Turn
drivable to a terminal record, the close cascade's journal debt becomes
payable through the same routes. The probe asserts `CLOSING → CLOSED →
DELETED` end-to-end after a wedge at interruption point 1.

## Design decisions and rationale

- **New phase instead of folding agent runs into `tools.items` with
  `outcomeSource: 'orchestration'`:** the Runtime recovery chain
  (`originalRuntimeBroker`, acquire/release discipline, per-execution
  `runtimeSessionId` reporting, `settleParkedTurnCancelled`) assumes every
  in-flight item has a Runtime identity. Teaching all of those about an
  orchestration item scatters the special case across four call sites; a
  parallel group concentrates it in one phase branch, mirroring how
  `await_action` already models a non-Runtime wait.
- **`resolveAwaitAgent` advances the phase while carrying the group:**
  dropping the group at fold time would be fine until a second crash —
  the recovery classifier would meet a bare `model_output_committed` and
  decline `model_start` over settled work. Advancing to
  `model_output_committed` with the all-consumed group kept lets §4's
  branch classify exactly that shape (phase-shape invariant: a carried
  group is always fully consumed), so the worst case of a second crash is
  an idempotent no-op re-entry and a re-driven model round.
- **Waiting runs report `executing`, never `unknown`:** the coordinator fails
  a Turn on any `unknown` outcome. A waiting child is fully observed through
  the ledger-relay pair, so `known`/`executing` is the honest encoding and
  needs no new wire vocabulary.
- **Crashes between `admit` and `commitAwaitAgent` stay bounded and honest:**
  pre-wait crashes keep the `model_start` verdict outright; crashes past a
  consumed wait leave the carried group, and the resume's ledger-honest fill
  folds the admitted child's own outcome rather than fabricating an answer.
  Widening the window to a checkpoint-atomic admission is a larger contract
  change; the Runtime batch family accepts the same shape of gap.

## Constraints

- Checkpoint schema stays at version 1. An older daemon reading an
  `await_agent` checkpoint answers `checkpoint_blocked` (unknown phase is not
  in its vocabulary) — a bounded, loud refusal, never a wrong settlement.
- The Hosted daemon is the single writer of its session log; the new phase
  and group are produced and consumed only inside the daemon + the
  coordinator's wire validation.
- The `await_agent` wait is exclusive with `await_action` and `await_runtime`
  at commit time; the exclusivity rests on a guard H4b already shipped: a
  foreground agent call in a **mixed batch** (one carrying any non-agent
  tool call) is refused at admission as a batch-level refusal
  (`hosted-workspace-tool-turn.ts` — "cannot share a batch with a non-agent
  tool"), so an `await_agent` checkpoint and a live `await_runtime` batch
  can never coexist in ordinary production. Agent-only batches take no
  mount and their foreground waits serialize one at a time (the
  all-consumed carried group is replaced, not stacked).

## Risks

- **Wire-validation drift:** if any other Java consumer pattern-matches the
  recovery phase set, `await_agent` must not silently default to a failure
  branch. Mitigation: `grep` audit of the phase strings across
  `packages/sdk-java` (done: `HostedHarnessClient`,
  `HarnessRuntimeRecovery`, `HarnessCoordinator`, `ToolPublicationStore` —
  dispositions above) plus the predicate-level tests pinning the new
  behavior (`HostedHarnessClientTest`'s `await_agent` wire round-trip and
  its unknown-outcome negative) — `HarnessCoordinatorTest` stubs the
  recovery report at every site, so the guarantee lives with the
  predicates, not the coordinator suite.
- **Duplicate fold:** the re-fold must survive a crash after committing
  `tool_result` but before `resolveAwaitAgent`. Mitigation: the journaled-set
  dedupe is the same mechanism `settleParkedTurnCancelled` already relies on,
  and the acceptance/consumption records are themselves idempotent.
- **Resume-mode ToolTurn drift:** the reconstruction must not re-execute any
  tool other than the agent wait. Mitigation: the resume entry takes the run
  list from the checkpoint and touches nothing else; suite asserts exactly
  the fold commits happen.

## Validation plan

- **Core (unit):** checkpoint parser round-trip for `await_agent` +
  `agentWait`, unknown-phase and unknown-field refusals; constructor guard
  (durable-wait exclusivity); `commitAwaitAgent` replay-safety, turn-binding
  rules and boundary validation (duplicate ids, already-consumed runs, empty
  batch); `resolveAwaitAgent` marking plus takeover-activation adoption on
  the advancing fold. The encode's mixed-version shape is pinned too:
  `agentWait` is absent whenever no group rides the checkpoint and the parse
  still reads `null`.
- **Recovery (unit, real local authority):** classification only, matching
  §4's own charter — the `await_agent` branch reports point-1 runs
  `executing`, the carried all-consumed group reports `settled`, both load
  shapes classify identically, and each execution entry's
  `runtimeSessionId` is `hostedRuntimeSessionId(promptId)`. No fold coverage
  belongs here: §4 bars this layer from folding.
- **Turn arm (unit):** admission commits the wait (ordering: admit then
  checkpoint), every terminal fold resolves, and the resume/consumption
  marks run outside the journaled gate.
- **Routes (integration, real daemon):** the wedge is minted through the
  production admission (execute → admit → `commitAwaitAgent`); the continue
  route admits the parked wait (the gate's reversion answers 409), and the
  cancel route settles the takeover with the abandoned fold journaled and
  the checkpoint advanced past the wait exactly once.
- **Dedicated end-to-end suite** (new, `hosted-child-wait-recovery`-style,
  real local authority + restarted authority over the same store):
  1. Wedge at interruption point 1 → restart → takeover load attaches →
     continue re-enters the wait → child settles → parent Turn completes.
  2. Wedge at interruption point 2 (acceptance committed, tool result not)
     → restart → takeover folds the committed answer into the original tool
     call exactly once (journal counted) → parent Turn completes.
  3. Wedge at point 1 → close parent → (previously stuck `CLOSING`) reaches
     `CLOSED`, then `DELETE` succeeds. _Rig-facing:_ no suite drives a real
     close/delete today; this and acceptance criterion 3 are the post-merge
     real-stack rig's probes, not shipped evidence.
  4. Cancellation takeover of the wedged Turn settles it cancelled and the
     child keeps its ledger line (covered at the route level above and at
     the library level here).
  5. Second-death and orphan shapes: a crash past the last fold classifies
     the carried group, the gap fill answers never-reached sibling calls
     (never-admitted wording by family), an admitted orphan folds its own
     outcome (completed, failed/cancelled, background receipt, oversized
     with the truncation marker), and the interrupted-turn funnel settles
     the same way the takeover cancel does.
- **Java:** `HostedHarnessClientTest` accepts the new phase — the wire
  round-trip plus the predicate-level negatives (`await_agent` with empty
  executions or any `unknown` outcome is neither continuation- nor
  cancellation-ready; the wire parser independently floors executions at
  1–1024). The coordinator's recovery-admission mechanism is phase-generic
  by its existing mock-driven suites (`HarnessCoordinatorTest` mocks the
  predicates); the phase-specific behavior lives in the predicates, which
  the wire tests pin.
- **Mutation witnesses:** each new mechanism gets a witness proven RED
  against the unmutated expectation (e.g. drop the `commitAwaitAgent` call →
  point-1 probe stays wedged; drop the journaled dedupe → point-2 probe
  double-folds), then restored byte-identical before commit.
- **Reproduction pins filled in `.qwen/issues/issue-13708.md`:** the red
  state of the new suite against pre-fix code serves as the executable
  reproduction report; the green state as the verification report.

## Acceptance criteria

1. Probe 1 of #13708 passes: parent wedged at interruption point 1 re-enters
   the wait and its later Turns complete.
2. Probe 2 passes: parent recovered after interruption point 2 folds the
   committed child answer into the original tool call exactly once.
3. Probe 3 (rig-facing): close/delete of a parent wedged at point 1 reaches
   `CLOSED` / `DELETED` — a post-merge real-stack probe; this PR's shipped
   evidence is the companion section above, and the criterion is met when
   the rig reports green.
4. The rig's two TypeScript foreground-recovery expectations turn green.
5. No regression in the existing recovery, coordinator, publication, and
   wire-validation suites.

## Open questions

- Mixed-model Turns carry H4b's existing admission refusal (the
  Constraints section) — this change relies on it rather than introducing
  it. Whether such batches should instead interleave — one foreground
  agent call waiting beside an in-flight Runtime batch — is a product
  decision deferred past this fix; refusal keeps the semantics honest
  without inventing an interleaving, and the model can always split the
  calls.
