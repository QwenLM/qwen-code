# Managed approval selection and Shell Full Access

[English](managed-approval-selection.md) | [简体中文](managed-approval-selection.zh-CN.md)

## Status and scope

Implemented in this change, based on the Managed WebShell approval selector and model selection work. Linux deployment acceptance remains pending. Built-in, public, Workspace-bound `qwen-code` Sessions may choose `default`, `auto-edit`, or `yolo` at creation and change their next Turn's policy while idle. Stored AgentDefinitions retain their fixed policy. Deployment defaults, Shell admission, tool families, Runtime privileges, and recovery refusal semantics remain unchanged.

Only the recorded Session owner holding current Workspace OPERATOR permission may change the policy. Active Turns, pending Actions, open operations, retained executions, and recovery work prevent a change. Changing policy preserves history, Workspace, and the draft.

## Durable state and execution

The original `ma_session.approval_mode` remains immutable and continues to identify the Harness definition. A nullable `selected_approval_mode` and zero-based `approval_revision` hold the current override. Each newly admitted built-in Turn snapshots its effective mode and revision under the same Session lock used by policy changes. Old Sessions have no override; old Turns without a snapshot use their original definition policy only while the Session has no override. Missing snapshots after a selection refuse execution.

A change verifies ownership, grants, Workspace facts, idle state, and expected revision before atomically saving the override, incrementing its revision, recording an actor-and-Session-scoped idempotent receipt, and emitting `session.approval.changed`. Identical receipt replay does not change policy again. Concurrent Turn admission and changes are ordered by the Session lock.

SDK prompt admission carries positive revisions in optional `approvalSelection: {mode, revision}` under `approval-selection/1`. Java always omits this field for revision zero and legacy Turns: the confirmed immutable definition supplies their initial policy, so a Harness capability upgrade cannot change the same prompt's retry identity. New Turns still freeze mode and revision zero in SQL. The Harness records it in the existing `managed-admission` resource. Live and cold duplicate admission compare the snapshot, and execution, Hooks, and recovery read that same committed input. Neither a mutable Session override nor another Turn may replace it. A changed Session cannot execute through a Harness that lacks this feature. Invalid or incomplete snapshots refuse execution rather than falling back.

`yolo` suppresses ordinary tool approval. Explicit Hook deny/ask decisions retain their semantics and Actions remain available for switchable Sessions. New selectable Full Access definitions persist the configured approval timeout for later asking Turns; legacy definitions without it retain the 10-minute fallback. Shell result capture, durable receipts, cancellation, and uncertain-effect recovery continue through the existing execution chain. Deployment Shell defaults still require `default` or `auto-edit`; an explicit Session choice opens Full Access. Every execution-capable attachment, including passive recovery loads, checks the Harness feature; dedicated cancellation and lifecycle settlement remain available.

## Interfaces and UI

Add owner-scoped WebShell `session-approval/query` and `session-approval/change` operations. Query returns `approvalMode`, `approvalRevision`, `availableApprovalModes`, and change support. Change accepts `sessionId`, `approvalMode`, `expectedRevision`, `idempotencyKey`, and `requestId`, and returns the committed mode/revision and `replayed`. Reused keys with different content, stale revisions, and busy Sessions return 409; existing 403/404 isolation rules apply. No public REST change operation is added.

WebShell summaries expose the current effective `approvalMode`, `approvalRevision`, and immutable `initialApprovalMode`. Pending creation compares the initial policy, not a subsequently changed policy. The existing shared mode menu renders the server's supported modes. While a change is unconfirmed, sending and policy/model/cwd changes are blocked. The browser persists the original intention and idempotency key, retries uncertain results with that intention, and requires a summary readback at least as new as the result before unlocking. Older summaries cannot overwrite a newer revision.

## Schema and rollout

Add shared schema V6 after the prerequisite V4 Workspace creation and V5 model selection migrations, including initialization and structural validation. Existing data defaults to revision zero without rewriting the initial policy. Upgrade the Harness first, then migrate and update every Java/Broker reader and writer during a maintenance window, and publish WebShell last. Rollback binaries must understand existing overrides and Turn snapshots; retain new schema and receipts.

## Verification and acceptance

Verify the three-mode file/Shell matrix and `default → yolo → auto-edit` in one Session with real effects, output, history, refresh, and restart evidence. Test owner/OPERATOR checks, revoked grants, cross-tenant access, custom definitions, busy and recovery refusal, atomic concurrent send/change, duplicate and lost-response requests, stale tabs, old creation replay, and explicit Hook interaction. SDK and Harness tests cover snapshot parsing, feature refusal, live/cold replay identity, and resumed execution retaining its original policy. MySQL 8.4 tests cover migration, transactions, and durable snapshots. Run affected package tests, build/typecheck/bundle, Java verification, API contract gates, two clean self-audit passes, and independent review. Physical recovery and lease-expiry fixes are outside this feature's acceptance.

## Local verification and remaining deployment gates

On macOS with Node 22.22.3, JDK 21.0.8, Maven 3.9.14, and disposable MySQL 8.4.11, the affected TypeScript tests and build/typecheck/bundle, Java SDK/Broker/server verification, schema initialization/validation, and 18 real-MySQL policy transaction tests passed. Independent source review identified and verified the revision-zero replay fix described above. CI results are separate from this local evidence.

The test engineer verified real Java/Broker/Harness/worker processes and Chrome with a deterministic local model: the three modes produced ordinary approval counts 2/0/1 for a write plus Shell command, exact side effects once, unchanged history, owner/permission/busy/receipt checks, a lost response with refresh and original-request confirmation, retained draft, and a complete menu at 390px. A Harness-only restart retained policy and completed another Turn for both a selected Session and a revision-zero control.

The macOS process run used the repository's explicit physical-alias SQL test fixture with real mounts and tools, and disabled native/durable Runtime recovery. Full Java restart read the correct selected policy but timed out warming an old non-durable Runtime binding, for both selected and revision-zero Sessions. The unmodified Hosted MySQL profile also failed its first tool Turn with Broker 409 on this host. These are not passing gates or classified regressions. Linux native storage registration, durable whole-JVM recovery, unknown-effect process fault acceptance, and real upstream-model calls still require deployment-lane evidence before release; no lease or Runtime recovery repair is included here.
