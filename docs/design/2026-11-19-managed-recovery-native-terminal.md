# Managed Recovery From Durable Native Terminals

[English](2026-11-19-managed-recovery-native-terminal.md) | [简体中文](2026-11-19-managed-recovery-native-terminal.zh-CN.md)

Status: proposal, implemented for #17538 and #17543 in the same PR; #17542 is analysed here and deferred to a follow-up. Date: 2026-11-19. It extends the [suspension recovery view](2026-11-18-managed-suspension-recovery-view.md) from sealed heads to live heads. No schema change, no new Harness verb, no OpenAPI change.

## 1. Problem

`SessionRecoveryService` decides whether a Session may accept its next Turn. Outside the sealed-head proof, the only evidence it reads about the latest Turn's input is live Harness evidence, through `HarnessConnector.inspectRecovery`. That evidence exists only on one control-plane replica. The Hosted Harness answers `GET /session/:id/status` only for the client that loaded the Session (`X-Qwen-Client-Id` must equal `session.clientId`). Every other replica has no attachment, so the connector returns `null`. Three reported failures share this root cause:

- **#17538: the read path flaps across replicas.** On a replica without the attachment, a terminal Turn with `null` evidence falls into `operator_required` / `recovery_evidence_unavailable` / `nextTurnAllowed=false`. Behind round-robin load balancing, most reads land on such a replica. `ManagedAgentService.getPublicSession` and `getWebShellSession` project the same view onto every Session read, so the send gate flips per request. The Web Shell mitigation (#17557) accepts a miss only after two consecutive misses for the same Turn, so with 4 replicas a completed Turn still locks about 9 reads in 16.
- **#17543: recheck cannot settle from durable state.** `recheck` re-reads the same view. For a cold terminal Turn it then calls `recheckRecoveryCleanup`, which needs a Harness that can open the Session. When none can, the call either throws an uncoded failure or returns `409 recovery_recheck_unavailable`, and that answer never changes, even when durable state already shows that the Harness settled the Turn.
- **#17542: an externally terminated runtime never settles its Turn.** A Workspace Turn's `fail()` first needs Harness proof that the input settled (`inputSettlementConfirmed`) or a reconciled cancellation. Once the runtime is gone, that proof never arrives. The result is a loop: `recoverParkedRuntime` calls `fail`, the cancellation stays unreconciled, `parkRuntimeRecovery` parks the Turn, and the next recheck starts over.

## 2. Durable facts that already prove settlement

The Harness projects public terminal events only from its journal. `turn_complete` and `turn_error` exist only as projections of a committed `turn.settled` event (`hosted-harness-session.ts`). The control plane writes them through `completeHarnessTurn` plus `appendEvents`, in one transaction, with the source key `bootId:eventEpoch:sourceId`.

The terminal events that the control plane writes itself carry no source key: the SQL `turn.failed` of `settleFailedTurn` and `failWorktreeInitialTurns`, and the SQL `turn.cancelled` of `cancelUnadmittedTurn`. Only Turn terminal events set `is_terminal = 1`.

Therefore:

> A Turn has a **durable native terminal** iff `ma_public_event` holds a `SESSION`-stream row for it with `is_terminal = 1` and a non-null `source_key`. Then the Harness journal contains `turn.settled` for that Turn's prompt.

This is the "durable native terminal" the recheck contract already requires before any cleanup. A historical SQL failure does not count, and the contract forbids treating one as native settlement. The fact is readable on every replica through `idx_ma_event_turn`, and no Harness has to be reachable.

## 3. View contract change (#17538)

`inspect()` keeps every existing arm and order. After it reads live evidence, one arm is added. It applies **only when this replica has no live evidence** (`evidence == null`):

- the latest Turn is not active;
- the head is `ACTIVE`, meaning a live journal; sealed heads keep the suspension proof and its documented residuals;
- the Turn has a durable native terminal (§2);
- `hasUnsettledWork` is false: no active Turn, no live Runtime execution, no `REFERENCED` `HOSTED_CLEANUP` debt.

Then the view is `ready` with `nextTurnAllowed = true`, and no recheck or cancel is offered. Earlier arms already returned for an inactive Session, a missing head on a bound Session, and a non-`READY` head recovery block, so a durable Harness block still wins.

Decisions:

- **Fallback, not override.** The owner replica still reports its live evidence, for example `cleanup_pending` / `file_history_pending` right after a Turn. Only the absence of evidence is replaced, and durable state now proves exactly what that absence used to block. Overriding live evidence would hide real post-Turn obligations from the one replica that can see them.
- **Only native terminals.** The latest Turn proves settlement only of its own prompt. Earlier inputs are covered in the normal paths: the Harness runs one Turn at a time (`hosted_turn_active`), and a load that finds an unsettled earlier input refuses in `open()`. A newer native terminal therefore does not appear while an older input stays pending (see §9 for the unproven remainder). A never-submitted SQL failure (`is_submission_attempted = false`) is **not** accepted as proof. It says nothing about an earlier Turn whose input may still be unsettled in the journal.
- **Live heads only.** A sealed head that failed the suspension proof, such as one whose wake proof is absent, keeps its conservative answer. A late wake input there has no owner to process it.

## 4. Recheck change (#17543)

- `recheck` resolves its target through the same view. A Turn with a durable native terminal and no owed work is therefore `ready`, and `recheck` returns it before contacting any Harness. This answers the issue's main expectation: recheck settles from durable state when durable state proves the Turn terminal.
- A cold cleanup recheck that no Hosted Harness can serve now fails with `503 recovery_runtime_unavailable`. This covers every non-`ManagedAgentException` failure of `recheckRecoveryCleanup`, which used to surface as an uncoded error. Coded refusals pass through unchanged, including the pool's `503 harness_pool_unavailable`. `409 recovery_recheck_unavailable` keeps its contract meaning: the recheck ran, and the work is ineligible.
- Cleanup-debt rechecks stay Harness-bound, as the issue allows.

## 5. #17542 analysis and follow-up

The loop in §1 is real, but the control plane cannot simply break it by writing `FAILED`. The journal input would stay unsettled, and the next Harness load would refuse the Session in its unsettled-input arm. Settlement must reach the journal, which takes a Harness writer.

What blocks the Harness is cancellation readiness. `HarnessRuntimeRecovery.isCancellationReady` refuses a `results_ready` park whose Runtime execution outcome is `unknown`. When the runtime was terminated externally, that outcome can only become known if the Runtime Broker treats the terminated generation as authoritative evidence that its executions stopped.

The Broker already has `LOST` generations and bounded drain passes (`RuntimeBindingProvisioning`, `RuntimeDrainCoordinator`). The follow-up must first reproduce the failure on a real stack and find which layer keeps the outcome `unknown`, then propose one of these:

1. a drained `LOST` or `RELEASED` generation reports its executions as stopped, which lets the existing cancellation path settle the Turn in the journal; or
2. a dedicated termination reason, carried through Harness recovery, that settles the Turn once.

Either option must keep the duplicate-execution guard: never settle while the old generation can still run. After the journal settles, §3 makes the Session `ready` on every replica.

## 6. Implementation shape

- `SessionRecoveryRepository.hasNativeTerminal(tenantId, sessionId, turnId)`, implemented in `JdbcSessionRecoveryRepository` as one `EXISTS` over `ma_public_event`.
- `SessionRecoveryService.inspect()`: the fallback arm of §3.
- `SessionRecoveryService.recheck()`: both cleanup calls go through `recheckCleanup`, which applies the `503` mapping of §4 and logs the original failure, because the API maps a `ManagedAgentException` without logging its cause.
- Cost: on a replica without live evidence, a Session read whose inactive latest Turn sits on a live head now also runs the indexed `EXISTS`. When that holds, the read also runs the existing `hasUnsettledWork` statement.

## 7. Validation

H2 unit cases in `SessionRecoveryServiceTest`:

- `COMPLETED`, `CANCELLED` and Harness-`FAILED` Turns with a native terminal are `ready` without an attachment, and the summary projection equals the recovery read;
- a SQL-authored terminal (null source key) keeps `operator_required`;
- a native terminal with an active Turn, a live Runtime execution or a cleanup debt is not `ready`;
- live owner evidence (`cleanup_pending`) still wins over a native terminal;
- a sealed head without its wake proof stays not-ready even with a native terminal;
- recheck of a native terminal returns `ready` without calling `recheckRecoveryCleanup`;
- an unreachable Harness yields `503 recovery_runtime_unavailable`, and a coded pool refusal passes through.

Still owed: a real-MySQL check of the `ma_public_event` query plan through `idx_ma_event_turn`, and a two-replica stack showing stable reads.

## 8. Acceptance

- On a live head, a Turn the Harness settled reports `ready` / `nextTurnAllowed = true` from every replica when no durable work is owed. The summary and the recovery endpoint agree.
- A SQL-authored terminal is never treated as native settlement.
- The owner replica's live evidence and every sealed-head arm are unchanged.
- Recheck of a durably settled Turn returns `ready` without loading the Session, and an unreachable Harness yields a coded `503`.

## 9. Residuals

- A live head that owes durable work, such as a background Runtime execution still running after the Turn, keeps the old conservative view on non-owner replicas. Closing that gap needs a durable form of the owner's verdict on such work.
- A journal-only pending input without its own `ma_turn` row is invisible to the durable arm. If the Harness has to process it first, the next submit meets the Harness's normal admission, exactly as if the owner had answered `ready` a moment earlier.
- The arm does not replay the journal, so the claim that no earlier input remains pending behind a newer native terminal rests on the Harness's admission and load guards in §3, not on a proof over the journal. If that assumption fails, a non-owner replica answers `ready` while the owner answers `inputs_unsettled`. The view only gates sending and never admits work itself: the next submit still goes through the coordinator and the Harness's own admission guards.
- Some non-ready verdicts are computed inside the owning Harness, and the durable arm reads none of them: post-Turn file-history work (`cleanup_pending` / `file_history_pending`), a pending file-history undo, an unready continuation, extension recovery, and stopped writes. While one of them holds, the owner reports it from live evidence, but a non-owner replica answers `ready`. As above, the view only gates sending: the next submit still goes through the coordinator and the Harness's own admission.
- #17542 remains open (§5).
