# Managed Suspension Recovery View

[English](2026-11-18-managed-suspension-recovery-view.md) | [简体中文](2026-11-18-managed-suspension-recovery-view.zh-CN.md)

Status: proposed addendum to phase 1 of the [stateless Hosted Harness design](2026-11-16-managed-stateless-harness.md). Date: 2026-11-18. Baseline: `origin/main` `ea860cf139`. This addendum specifies the recovery/status view contract the parent design requires ("恢复/状态响应不能因为缓存条目缺失就报告成功，也不能把缺失直接当成需要运维处理的失败") and the persistent-state proof behind it. It adds no receipt, no schema change, and no new Harness verb.

## 1. Problem

`SessionRecoveryService.inspect()` derives a Session's recovery view from two sources: the persistent head's `recovery_status`, and live evidence read through the Harness connector (`inspectRecovery`). The connector answers `null` when it holds no cached attachment. A cleanly suspended Session has no resident on any Harness: its writer is sealed and its activation released, but the control plane may still hold a stale cache entry or none at all. Today, cache absence falls through to `operator_required` / `awaiting_evidence` with `recovery_evidence_unavailable` — treating a healthy suspended Session as a failure that needs an operator, while a stale cache could conversely report live evidence for a Session nobody holds. Neither direction is acceptable: the view must follow persistent writer/activation state, not cache presence.

## 2. Persistent facts and their ordering

The `ma_session_head` row (kind `MANAGED_SESSION`) already carries everything the proof needs:

- `state` — journal lifecycle: `ACTIVE` or `SEALED`.
- `writer_generation`, `writer_id`, `writer_lease_until` — the fencing writer and its lease.
- `activation_phase`, `activation_id`, `activation_expires_at` — the projected activation.
- `activation_head_revision` vs `journal_revision` — projection currency. The commit path updates the activation projection in the same transaction as the commit and refuses to certify a skewed projection as current; a commit without an activation change leaves `activation_head_revision` behind `journal_revision` until an activation-bearing commit catches it up.
- `recovery_status`, `recovery_detail_code` — the recovery block, if any.

The suspension teardown (parent design, "挂起流程") runs in a fixed order: wake scheduler close, non-terminal Hook/MCP close, runtime lease release and cleanup-debt reconciliation, publisher close, and only then renewal stop, activation release, and seal. The seal is the last step. Therefore a `SEALED` head whose activation projection is current and `released` proves every preceding resource step completed: a crash before any of them would have left the head `ACTIVE`.

## 3. The view contract

`inspect()` keeps its existing arms (session not active; missing head for a bound Session; non-READY recovery status; pristine initial Session; active Turn without recovery intent). Before it falls through to live Harness evidence, it evaluates the persistent suspension state, in this order:

1. **Clean suspension → `ready`.** Session `ACTIVE`, head recovery `READY`, head `state = SEALED`, `activation_phase = released`, and `activation_head_revision = journal_revision` (projection current), and no active Turn. The view is `ready` with `nextTurnAllowed = true`: the next load acquires writer generation + 1, fenced against the sealed writer, and reinstalls the owners. No Harness evidence is consulted, and cache absence is irrelevant.
2. **Sealed, projection lagging → `awaiting_evidence`.** `state = SEALED` but `activation_head_revision < journal_revision`: the release may or may not be projected yet. The view waits for the projection rather than guessing; it is not an operator failure. (In practice the release commit projects synchronously; this arm covers a read racing a concurrent commit and any future async projection.)
3. **Sealed, activation not released, projection current → `operator_required`, reason `teardown_sequence_violation`.** Every path that seals releases the activation first (suspension teardown; terminal close retires the Session entirely). A current projection showing `SEALED` with a non-released activation is an anomaly no healthy path produces; it names operator recovery instead of the generic evidence-unavailable reason.
4. **Otherwise** the existing writer-loss and live-evidence arms apply unchanged: an `ACTIVE` head with an expired lease and no live writer is the existing recovery case; a live attachment's evidence still drives the recovering/cleanup views.

Cache absence alone never decides the outcome in either direction. A stale cache entry cannot make a sealed Session report live evidence: arms 1–3 are evaluated before `inspectRecovery` is called, and a `SEALED` head never reaches the live-evidence arm.

## 4. Interaction with the Harness gate

The Harness suspension gate (`hosted_session_closing` / `hosted_session_teardown_blocked`) is a separate mechanism with its own reconciliation: a blocked gate retries the same seal, and a seal that actually committed answers idempotently, clearing the gate. The recovery view reports the persistent truth independently of the gate: a Session whose seal committed is `ready` here even while a Harness gate is still reconciling, and the control plane's load retry meets the gate's transient refusal until reconciliation completes. The parent design's open question 8 (bounded automatic recovery for a wedged teardown) remains an enablement gate for the suspension mechanism; this addendum neither resolves nor depends on it.

## 5. Implementation shape

- Extend `SessionRecoveryRepository.HeadRecovery` with the journal state, activation phase, and the two revisions; extend the JDBC select accordingly. No schema change.
- Insert arms 1–3 into `inspect()` ahead of the live-evidence fallback.
- Tests: one unit case per arm (H2), including the projection-lag arm constructed by a commit without an activation change after the release; a real-MySQL IT for the clean-suspension and lag arms; a regression case proving a stale cache cannot override a sealed head.

## 6. Acceptance

- A cleanly suspended Session reports `ready` / `nextTurnAllowed` with no Harness resident and no cache entry.
- Cache absence never yields `operator_required` for a sealed, released, current-projection head.
- A skewed projection yields `awaiting_evidence`, not `ready` and not `operator_required`.
- The anomaly arm names `teardown_sequence_violation`.
- Existing recovery views (writer loss, active Turn, cleanup pending, initial Session) are unchanged.
