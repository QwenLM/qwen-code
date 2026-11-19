# Managed Suspension Recovery View

[English](2026-11-18-managed-suspension-recovery-view.md) | [简体中文](2026-11-18-managed-suspension-recovery-view.zh-CN.md)

Status: addendum to phase 1 of the [stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md), implemented in the phase-1 PR (#17690). Date: 2026-11-18. This addendum specifies the recovery/status view contract the parent design requires ("恢复/状态响应不能因为缓存条目缺失就报告成功，也不能把缺失直接当成需要运维处理的失败") and the persistent-state proof behind it. It adds no receipt, no schema change, and no new Harness verb.

## 1. Problem

`SessionRecoveryService.inspect()` derives a Session's recovery view from two sources: the persistent head's `recovery_status`, and live evidence read through the Harness connector (`inspectRecovery`). The connector answers `null` when it holds no cached attachment. A cleanly suspended Session has no resident on any Harness: its writer is sealed and its activation released, but the control plane may still hold a stale cache entry or none at all. Cache absence then falls through to `operator_required` / `awaiting_evidence` with `recovery_evidence_unavailable` — treating a healthy suspended Session as a failure that needs an operator, while a stale cache could conversely report live evidence for a Session nobody holds. Neither direction is acceptable: the view must follow persistent state, not cache presence.

This is not only the operator recovery endpoint. `ManagedAgentService.getPublicSession` and `getWebShellSession` project the same view onto **every** ordinary Session read, so a wrong arm here mislabels every suspended Session in the public API and the Web Shell.

## 2. Persistent facts, and why a sealed head is not enough

The `ma_session_head` row (kind `MANAGED_SESSION`) carries:

- `state` — journal lifecycle: `ACTIVE` or `SEALED`.
- `writer_generation`, `writer_id`, `writer_lease_until` — the fencing writer and its lease.
- `activation_phase`, `activation_id`, `activation_expires_at` — the projected activation.
- `activation_head_revision` vs `journal_revision` — projection currency. `JournalCommit` advances it to the new revision when the transaction carries an activation change **or when it was already current**, and never certifies a skewed projection as current. A current projection therefore stays current across ordinary commits; only one that was already behind stays behind until an activation-bearing commit catches it up.
- `is_wake_pending`, `wake_head_revision` — the wake projection. The wake scan clears the hint only after an independent replay of the committed prefix proves no pending wake input at that exact revision.
- `recovery_status`, `recovery_detail_code` — the recovery block, if any.

The suspension teardown runs in a fixed order and seals last, so a crash before any resource step leaves the head `ACTIVE`. **The converse does not hold.** A load that refuses also closes the writer it just acquired: the takeover-decline, unsettled-input, workspace-not-writable, extension-recovery and quiescing arms of `open()` all call `managed.close()`, which releases the activation and seals. They leave exactly the same `SEALED` + `released` + current-projection head as a completed suspension, while the journal still owes work. A bare `writers:seal` reaches a sealed head with an unreleased activation too.

So the sealed head is necessary but not sufficient. `ready` needs positive proof that nothing is owed, from projections that already exist:

- **No unsettled Turn**: no `ma_turn` row of this Session in `ACCEPTED`, `RUNNING` or `CANCELLING`.
- **No live Runtime execution**: no `ma_session_record` DOMAIN row with a non-null `runtime_state`. That column is non-null only while a projected run's execution is live (`unbound`, `provisioning`, `ready`, `draining`, `lost`), so it names unsettled MCP, Hook, extension, child and Monitor work without reading a record body.
- **No owed cleanup**: no `REFERENCED` `ma_resource` behind a `HOSTED_CLEANUP` `ma_resource_ref` — the debt scanner's own predicate.
- **Wake proof at this revision**: `is_wake_pending = 0` and `wake_head_revision = journal_revision`.

## 3. The view contract

`inspect()` keeps its existing arms (session not active; missing head for a bound Session; non-READY recovery status; pristine initial Session; active Turn without recovery intent). Before it falls through to live Harness evidence, it evaluates the persistent suspension state:

1. **Clean suspension → `ready`.** Session `ACTIVE`, head recovery `READY`, `state = SEALED`, `activation_phase = released`, projection current, no active Turn, the wake proof above, and no unsettled work. The view is `ready` with `nextTurnAllowed = true`: the next load acquires writer generation + 1, fenced against the sealed writer, and reinstalls the owners. No Harness evidence is consulted, and cache absence is irrelevant.
2. **Sealed, projection lagging → `awaiting_evidence`.** `activation_head_revision < journal_revision`: the release may not be projected yet. The view waits rather than guessing; it is not an operator failure.
3. **Anything else falls through** to the existing writer-loss and live-evidence arms. A sealed head that cannot prove it owes nothing keeps the conservative answer those arms already give; it is not relabelled as a healthy suspension, and it is not given a new anomaly code either — a bare `writers:seal` and a refused load both reach these shapes legitimately.

Cache absence alone never decides the outcome in either direction, and a stale cache entry cannot make a proven-clean sealed Session report live evidence: arms 1–2 are evaluated before `inspectRecovery` is called.

**Scope of the proof.** The wake scan covers eligible active public Sessions with an uncompacted journal. A suspended Session outside that scope — a child Session, or one whose journal has been compacted — never gets the wake proof, so it keeps the pre-existing conservative view rather than `ready`. Two further residuals are deliberate: a projected run that is non-terminal but has no Runtime execution and no cleanup debt (an extension bootstrap left mid-flight) is not named by these guards, and the wake proof arrives one scan after the suspension, so a read in that window is conservative. In every residual the load itself still refuses and re-establishes the resident view; no work is lost or run twice. Widening the proof is follow-up work, not a licence to drop a guard.

## 4. Interaction with the Harness gate

The Harness suspension gate (`hosted_session_closing` / `hosted_session_teardown_blocked`) is a separate mechanism with its own reconciliation. The recovery view reports the persistent truth independently of it: a Session whose seal committed and whose obligations are proven clear is `ready` here even while a Harness gate is still reconciling, and the control plane's load retry meets the gate's refusal until reconciliation completes. The [bounded recovery addendum](2026-11-18-managed-suspension-bounded-recovery.md) covers the gate's own bound.

## 5. Implementation shape

- Extend `SessionRecoveryRepository.HeadRecovery` with the journal state, activation phase, the two revisions and the two wake columns; extend the JDBC select accordingly. No schema change.
- Add `SessionRecoveryRepository.hasUnsettledWork`, one statement over the three obligation projections above.
- Insert arms 1–2 into `inspect()` ahead of the live-evidence fallback.
- Tests: one H2 case per arm and per guard, including a settled record and a confirmed debt proving the guards do not over-block, and a regression case proving a stale cache cannot override a proven-clean sealed head. The real-MySQL IT for the clean-suspension and lag arms is still owed before enablement.

## 6. Acceptance

- A cleanly suspended Session reports `ready` / `nextTurnAllowed` with no Harness resident and no cache entry.
- A sealed head that still owes a Turn, a live Runtime execution or a cleanup debt is never `ready`.
- A sealed head whose wake proof is absent or covers an older revision is never `ready`.
- A skewed activation projection yields `awaiting_evidence`, not `ready` and not `operator_required`.
- A settled record and a confirmed debt do not block the proof.
- Existing recovery views (writer loss, active Turn, cleanup pending, initial Session) are unchanged.
