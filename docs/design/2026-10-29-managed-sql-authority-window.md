# Managed SQL history and authority residency

[English](2026-10-29-managed-sql-authority-window.md) | [简体中文](2026-10-29-managed-sql-authority-window.zh-CN.md)

## Status and delivery boundary

Extracted from Draft [#15696](https://github.com/QwenLM/qwen-code/pull/15696) onto main. This delivery adjusts Managed execution backed by H2 in managed-local and MySQL in Hosted. Final integration acceptance is pending. Implementation, focused tests, CI qualification and publication are separate evidence states.

Daemon Legacy persistence, recovery, replay, rewind, notification deduplication, Goal recovery and tool execution retain their existing behavior. Shared interfaces may adapt where Managed needs asynchronous history, but Legacy keeps its original execution branches. Execution engine and storage backend are independent: JSONL can also hold Managed sessions.

Standalone activation/inbox snapshot streaming, file-scheduler terminal residency optimization and their additional parser dependency remain outside this PR. Keep existing local Managed adapters compatible with shared interfaces, and retain file scratch needed by Hosted verification; neither implies standalone JSONL memory qualification.

## Problem and goal

Managed Session authority and its consumers retain completed events, identifiers, receipts, commands, checkpoints and domain revisions. Loading complete journal and checkpoint arrays during recovery shifts that growth into transient memory. A bounded live tail alone cannot preserve old retry answers or bound recovery.

Keep authority memory proportional to active state, fixed caches and bounded I/O. Preserve complete canonical history, exact old-key replay/conflict answers and original receipts. Cold recovery can scan history; fixed recovery time, bounded disk growth and complete process RSS are separate qualifications.

## Canonical storage and derived queries

Java/JDBC owns the H2/MySQL canonical journal. Core uses authenticated HTTP contracts and acquires no SQL credentials. History routes remain persisted-Workspace/Session scoped with tenant credentials, writer generation and read-grant checks.

Versioned history facts retain identity, source revision/sequence, locator and digest. Canonical commits and new facts share a transaction. Existing rows backfill in bounded batches, advancing only continuous coverage. A complete captured prefix can prove absence; unavailable, incomplete or corrupt views fail closed.

Generation-qualified history state and facts include bucket counts. Verify selected facts against canonical transactions, event/marker digests, scope, sequence and physical parent. Compare-and-swap repair rebuilds derived state without modifying canonical history or resetting a newer generation. Cleanup is bounded and scoped; derived tables cannot become CSI authority carriers or drive cross-tenant scans.

Update the unreleased V1 schema baseline and its initialization, projection, inventory and verification contracts together. There is no V2 migration, automatic catalog deletion or Flyway repair. The combined inventory has 41 managed tables and 844 columns, including main's compact-renewal metadata.

## Fixed views and streaming recovery

Capture tenant, Workspace, Session, journal revision, committed sequence and digest before asynchronous reads. Stream verified transactions and selected snapshot pages without concatenating a complete logical journal. Preserve marker chains, torn-tail handling, resource validation and final ownership fencing.

Compact activation renewal changes lease metadata on the existing activation transaction without advancing journal revision or committed sequence. Complete current HTTP scans and snapshot inspections overlay only validated metadata for the same active identity. Explicit byte-prefix reads retain their original activation state. Authority recovery adopts the validated scan summary even when a recovered authority was constructed during streaming.

Unknown append outcomes remain unreadable until the existing settlement protocol establishes landed or absent. A history miss cannot settle an uncertain write. A committed transaction whose derived view fails retains a bounded overlay and its receipt while further writes wait for repair.

## Resident authority and Managed consumers

Keep the recent event tail within 1,024 events/8 MiB and history caches within 2,048 entries/4 MiB. Retain active inputs, Actions, activation/checkpoint and lifecycle references. Completed identities remain queryable through immutable historical views rather than unbounded resident maps.

Managed recovery, approvals, model/Plan selection, tools, Hook once/occurrence/ordinal/definition pins, child/team continuation, notifications and cleanup use asynchronous point queries or bounded iteration. Message/branch projection and complete terminal/domain history are distinct views; terminal records must not become message parents. Model material remains the selected branch and current context without silently truncating canonical history.

Shared recorder, ACP and Goal adapters select these paths for Managed execution. Legacy notification admission keeps its original in-memory identity set and strict persistence path, without depending on Managed cold-history queries. Legacy Goal rebasing and cancellation recovery keep the original transcript reader and algorithms. Directed regression tests verify those boundaries; they do not establish every Legacy platform path.

## Checkpoint and CSI proof

Retain the existing paged checkpoint wire format and its byte/page qualification limits. Authorization exposes compact current state and lazy, immutable historical tool/binding queries with validated identities, ordinals, receipts and pins. A newer head cannot alter an older captured view.

Private disk facts bound checkpoint and CSI proof indexes while preserving source validation, exact terminal mirrors, continuous history coverage and cleanup ownership. Scratch loss can rebuild from a captured canonical root; canonical corruption refuses recovery. Main's compact activation lease metadata is validated in both JDBC and saved application replay. No authorization, row-count, byte or resource limit is weakened.

Managed-local H2 keeps its existing synchronous persistence and JVM temporary-buffer cache limit. Heap, direct-buffer, external-memory, RSS, context/checkpoint and network-buffer results must retain their own measured scopes.

## Compatibility and exclusions

Preserve journal formats, canonical transactions/resources, replay floors, Node requirements and local writer-lease ownership. Do not automatically publish snapshots, compact preview databases, lower retention or close the whole #13184 tracker. No daemon Legacy feature or storage optimization is included.

File scratch is derived state, not a replacement canonical authority. Its disk use, rebuild cost, cleanup time and write amplification remain explicit costs. Additional standalone JSONL optimization and file activation/inbox terminal-state work remain in the original Draft for later extraction.

## Validation and acceptance

Run affected TypeScript build/typecheck and directed Managed/Legacy regressions, preserving exact test identities, source inputs, failures and skips. Reuse unchanged evidence only with its original source boundary. The imported streamed compact-lease restore mismatch has a recorded failing regression; verify its corrected behavior on this branch.

The shared local Java verification allocation remains closed at 564.787/600 seconds; the unused 35.213 seconds cannot be spent or reset by this split. No local Maven, javac, Checkstyle, SpotBugs or related preparation is permitted. Final-head CI owns full Java profiles, MySQL/MariaDB, real HTTP recovery, fixed-heap 10k/100k H2/MySQL histories, checkpoint/context qualification, Hosted/CSI/Automation/Monitor faults and supported platforms.

Old-head fast, unit, smoke and empty-context scale successes do not establish this branch's full acceptance. Preserve old code failures, setup failures, skipped/unrun assertions and unresolved gates, including report ownership, Workflow terminal mirrors and timing failures, until qualifying evidence resolves each exact scope.
