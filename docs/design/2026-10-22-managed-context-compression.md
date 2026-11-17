# Managed manual context compression

[English](2026-10-22-managed-context-compression.md) | [中文](2026-10-22-managed-context-compression.zh-CN.md)

## Problem and boundary

Issue #15080 requests explicit control over when Managed Session history is summarized. This slice provides an idle-only durable Operation and an action in the existing context usage popover. It reuses Core compression without creating a user Turn, changing approval policy, rewriting the audit transcript or changing the Workspace installation revision.

The current Hosted model path rebuilds history from a message-only projection. Compression checkpoints must participate in that model projection, including after reopening or writer takeover. Large snapshots use the existing chunked message-body format rather than exceeding the 64 KiB inline resource limit.

## Admission and API

PUBLIC Sessions bound to a Workspace admit OPERATOR and OWNER callers. Active or queued Turns, approvals, unresolved Hooks, recovery and conflicting mutations return session_context_busy. Ordinary user input is refused during maintenance; autonomous input remains in its existing durable queue and executes afterward.

POST /v1/agents/sessions/{sessionId}/compress accepts expected_compaction_revision and Idempotency-Key. The WebShell twin is POST /api/agent/web-shell/v1/sessions/compress with camelCase fields. HTTP 202 returns a context_compression Operation, read through the existing operation queries. States are pending, running, recovery_blocked, completed and failed; a completed outcome is compressed or noop. Read authorization precedes actor-scoped replay, which precedes mutable role, capability, revision and busy checks. Conflicting key reuse is idempotency_conflict.

The latest context.compacted event sequence is compactionRevision, initially zero. It is independent of context_revision. Session summaries publish it and any active compression operation. WebShell's contextCompression capability reflects the caller's grants. Public API capabilities retain their existing deployment/support meaning; the compression POST always rechecks authorization. The private Harness adds context-compression/1 and dedicated submit/status routes; older Harness versions fail closed.

Older Sessions without a compaction projection lazily recover it from the verified committed journal prefix. Unavailable evidence hides the capability and omits the revision. Backfill and new commits advance the projection monotonically and retain any newer main-model usage observation.

## Execution and persistence

The Java ma_operation records CONTEXT_COMPRESSION; the reserved history_maintenance domain records the native execution. Source history cut, model/provider identity and parameters are immutable. PreCompact and PostCompact use separate stable operation-scoped occurrences, originTurnId=null. A candidate containing new history, summary and compression information commits before PostCompact. Hosted compression never reads recent-file bytes from the Harness host.

A narrow authority commit atomically appends context.compacted and the final maintenance outcome. NOOP and known failure also retain outcomes without changing history or revision. SQL projects the compaction and invalidates the previous usage/resource reference in the journal commit transaction. Replaying an outcome cannot clear a newer observation. The complete original transcript remains available.

The initiating actor's execution authority is revalidated before submission and in the final SQL transaction. Revocation after native acceptance retains the candidate and recovery barrier; restoring authority allows the original operation to continue.

Core exposes an awaited compression observer at the existing recording payload boundary, preserving pendingUserMessage, summaryPrefixLength and completedToolCallIds. Automatic and manual compaction share model-history restoration. Prepared model-request recovery keeps its existing precedence.

Tool-result recovery also retains a compaction recorded after the last tool-call message. Its declared pending-response tail is removed from the restored prefix and sent once through the existing resume path. Failed or cancelled user input is excluded, including when embedded in a previous snapshot's raw tail.

## Recovery

Unknown Harness acceptance is reconciled from the original durable evidence, never blindly redelivered. A known admitted operation resumes after fencing its old writer. A terminal outcome replays; a candidate resumes PostCompact and application without model recomputation. Without a candidate, a started pure summary attempt may be abandoned and replaced using the same source snapshot, provider pin and persisted PreCompact output. Model billing can repeat, but history commits once. Unknown Hook executions are reconciled rather than repeated. A delayed old writer cannot save a candidate or proceed to PostCompact after losing its fence.

The browser persists intent before submitting, reuses its key after uncertain responses, polls after refresh and adopts an operation advertised by another tab. Send and conflicting controls stay disabled until settlement. Context occupancy becomes unknown after success until a new committed main-model observation; summary-query usage is never substituted.

## Validation and rollout

Verify continuation, reopen and Harness takeover against compressed model inputs while preserving transcript and tool pairing. Race compression against Turns, wake inputs, approvals, model/CWD changes and close. Inject faults before/after candidate persistence, PostCompact, final commit and response delivery; a late old summary must not apply. Cover NOOP, API/Hook failures, corrupt chunks and snapshots larger than 64 KiB.

Run focused Core, CLI, WebShell, SDK and Java tests, root build/typecheck/bundle, API contract gates, disposable MySQL concurrency checks and relevant Hosted fault tests. Record unavailable checks explicitly. Add an incremental canonical-schema migration; never rewrite the published baseline. Deploy schema and Java/Broker readers before Harness writers and then WebShell. Stop new admission and settle accepted operations before rollback.

## Defaults

No custom compression instructions, busy-session compression, compression queue or new slash-command dispatch in this slice. No pending product decisions remain; validation results are recorded separately.
