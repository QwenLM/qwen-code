# Managed SQL history queries

[English](2026-10-29-managed-sql-history-queries.md) | [简体中文](2026-10-29-managed-sql-history-queries.zh-CN.md)

## Scope

Provide small, bounded reads for Managed local H2 and Hosted MySQL. Reuse existing SQL tables, published snapshots and authorization. This replaces the broader implementation in PR #15839; the original work remains preserved in Draft PR #15696 and the earlier commit history. No authority window, history cache, derived history tables, backfill, streaming full recovery, checkpoint/CSI redesign or Legacy behavior change is included.

## Recent messages

`POST /api/agent/web-shell/v1/transcript/items/query` accepts the existing `WebShellExportRequest`: `sessionId`, optional `cursor`, and `limit` from 1 to 100. The first request selects the newest published snapshot and reads at most the requested number of Items from its end. Each response is chronological; `nextCursor` moves toward older Items. The existing snapshot page resources bound physical reads without loading the complete snapshot.

Reuse `WebShellExportPage`: `items`, `nextCursor`, `hasMore`, and `snapshotThroughSequence`. Coverage belongs to the captured published snapshot and can lag the current Session head. Empty Items with zero coverage do not certify that the Session is empty: a published snapshot may not be available. This API neither includes the live event tail nor establishes the latest execution state. Existing transcript, stream, task and approval APIs retain those responsibilities. The WebShell client exposes one-page access; the existing UI and transcript reconstruction behavior are unchanged.

The backward cursor uses version 2, authenticated with the existing snapshot secret. Scope, snapshot identity/version, projection and expiry remain pinned. Forward version-1 export cursors and backward cursors are not interchangeable. Every page checks current Session read authorization and existing resource read leases. Publication of a newer snapshot does not change an existing cursor.

## Journal pages and point reads

`GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions:recent` accepts `workspaceId`, optional `throughRevision` and exclusive `beforeRevision`, and `limit` from 1 to 100. The first response captures the committed revision when omitted. Continue with the same returned `throughRevision` and `nextBeforeRevision`. The response contains the newest selected transactions in chronological order, not a count of visible messages. Metadata is read first with `LIMIT limit+1`; selected transaction bodies share the existing 8 MiB page budget. Revision gaps, invalid lengths and body digest mismatches refuse the read.

`GET .../transactions:lookup` accepts `workspaceId`, `operation`, `commandId` and optional `throughRevision`. Reuse the canonical unique command-key index. Verify exact identity, Workspace, byte length and digest before returning the original committed transaction. A command outside the captured prefix is absent from that view. Queries reject future or compacted prefixes and a missing boundary row. They do not independently certify arbitrary corruption of every unselected canonical row.

Both internal routes preserve tenant/Workspace/Session credentials and database-backed read grants, including a final read-grant check under READ_COMMITTED. They acquire no writer, renew no writer lease and do not settle an uncertain append. Existing current-state, approval, task, record/resource and recovery reads are reused. No request requires another instance's cache.

## Compatibility and deferred work

Canonical history, schema baseline, replay floor, journal format, transaction admission, cleanup and all execution consumers remain unchanged. Existing `/transcript/query`, forward export and `/transactions` semantics remain unchanged. Hosted scratch and checkpoint/CSI safety checks remain in the baseline. Full-snapshot UI pagination and replacement of execution-state reconstruction are separate work; this change does not claim bounded UI history, bounded recovery time or bounded total process RSS.

## Verification

Focused tests cover backward ordering across physical pages and sequence ties, cursor direction/tampering, fixed snapshots, byte and revision bounds, exact command reads, authorization and unchanged ownership. MySQL tests exercise the same journal queries and recent snapshot reads. OpenAPI, the surface registry, parity capture and generated WebShell types remain synchronized. The thin client requests one page and propagates opaque cursors and failures without automatically draining history.

The original local Java budget remains CLOSED at 564.787/600 seconds; the unused 35.213 seconds are forbidden, including preparation, compilation, retries and agents. New Java/H2/MySQL/HTTP execution must be verified by CI on the final head. Local TypeScript build/typecheck and affected client tests are separate evidence. Earlier broad recovery/scale results do not qualify this implementation. No runtime publication, deployment or model acceptance is claimed.
