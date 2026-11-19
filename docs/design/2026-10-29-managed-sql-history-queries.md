# Managed SQL history queries

[English](2026-10-29-managed-sql-history-queries.md) | [简体中文](2026-10-29-managed-sql-history-queries.zh-CN.md)

The follow-up [public snapshot removal](2026-10-29-managed-message-snapshot-removal.md) supersedes this design's published-snapshot message reads and signed cursors. The recent-message contract below reflects bounded live message reads; journal queries retain their existing behavior. Follow-up implementation and validation evidence are recorded separately.

## Scope

Provide small, bounded reads for Managed local H2 and Hosted MySQL. Reuse existing SQL tables, live message pages and authorization. This replaces the broader implementation in PR #15839; the original work remains preserved in Draft PR #15696 and the earlier commit history. No authority window, history cache, derived history tables, backfill, streaming full recovery, checkpoint/CSI redesign or Legacy behavior change is included.

## Recent messages

`POST /api/agent/web-shell/v1/transcript/items/query` accepts the existing `WebShellExportRequest`: `sessionId`, optional `cursor`, and `limit` from 1 to 100. The first request fixes a sequence membership upper bound and reads the newest bounded current message rows. Each response is chronological; `nextCursor` moves toward older Items in that initial range. SQL metadata lookahead and the row/byte budgets bound physical reads without creating or loading snapshot resources.

Reuse `WebShellExportPage`: `items`, `nextCursor`, `hasMore`, and `snapshotThroughSequence`. The last field retains its wire name and denotes the fixed membership upper bound; bodies and statuses remain live. Projection coverage below the replay floor returns retryable `503 message_projection_pending`, rather than certifying an empty Session with a zero-coverage page. This API neither includes the live event tail nor establishes the latest execution state. The transcript reports actual projection coverage for SSE continuation; stream, task and approval APIs retain their existing responsibilities. The WebShell client exposes one-page access.

The backward message cursor uses version 1 with scope, direction, projection generation, membership upper bound and the complete `(first_sequence, item_id)` position. It is unsigned and has no snapshot expiry or identity. Forward and backward cursors are not interchangeable. Every page checks current Session read authorization and uses one consistent SQL read view. A projection rebuild returns `409 message_projection_changed`; discard the cursor and restart the read. Later message updates do not freeze or replace the cursor's initial membership range.

## Journal pages and point reads

`GET /internal/managed-session-store/v1/sessions/{sessionId}/transactions:recent` accepts `workspaceId`, optional `throughRevision` and exclusive `beforeRevision`, and `limit` from 1 to 100. The first response captures the committed revision when omitted. Continue with the same returned `throughRevision` and `nextBeforeRevision`. The response contains the newest selected transactions in chronological order, not a count of visible messages. Metadata is read first with `LIMIT limit+1`; selected transaction bodies share the existing 8 MiB page budget. Revision gaps, invalid lengths and body digest mismatches refuse the read.

`GET .../transactions:lookup` accepts `workspaceId`, `operation`, `commandId` and optional `throughRevision`. Reuse the canonical unique command-key index. Verify exact identity, Workspace, byte length and digest before returning the original committed transaction. A command outside the captured prefix is absent from that view. Queries reject future or compacted prefixes and a missing boundary row. They do not independently certify arbitrary corruption of every unselected canonical row.

Both internal routes preserve tenant/Workspace/Session credentials and database-backed read grants, including a final read-grant check under READ_COMMITTED. They acquire no writer, renew no writer lease and do not settle an uncertain append. Existing current-state, approval, task, record/resource and recovery reads are reused. No request requires another instance's cache.

## Compatibility and deferred work

The journal queries preserve canonical history, replay floor, journal format, transaction admission, cleanup and execution consumers. The follow-up removes the public snapshot schema and changes transcript/export to the bounded live message semantics above; `/transactions` remains unchanged. Hosted scratch and native checkpoint/CSI safety checks remain in place. Whole-history UI draining and replacement of execution-state reconstruction are separate work; bounded recent reads do not claim bounded recovery time or bounded total process RSS.

## Verification

Focused tests cover backward ordering across pages and sequence ties, cursor direction/scope, fixed membership with live content, byte and revision bounds, exact command reads, authorization and unchanged ownership. MySQL tests target the same journal queries and recent message reads; qualification requires execution on the recorded final source. OpenAPI, the surface registry, parity capture and generated WebShell types remain synchronized. The thin client requests one page and propagates opaque cursors and failures without automatically draining history.

The original local Java budget remains CLOSED at 564.787/600 seconds; the unused 35.213 seconds are forbidden, including preparation, compilation, retries and agents. New Java/H2/MySQL/HTTP execution must be verified by CI on the final head. Local TypeScript build/typecheck and affected client tests are separate evidence. Earlier broad recovery/scale results do not qualify this implementation. No runtime publication, deployment or model acceptance is claimed.
