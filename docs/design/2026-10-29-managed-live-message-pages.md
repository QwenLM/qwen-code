# Managed live message pages

[English](2026-10-29-managed-live-message-pages.md) | [简体中文](2026-10-29-managed-live-message-pages.zh-CN.md)

## Problem and scope

The merged bounded query API reads published snapshots. It can lag message projection and the Java WebShell Provider still bootstraps through the full-snapshot transcript path. The requested behavior is direct SQL reads for the latest 100 Items, older pages on scroll, and live updates through the existing event stream. Export reads live message pages and does not promise frozen bodies. Only public Managed H2/MySQL WebShell reads change; daemon Legacy, execution recovery, private CSI, canonical journals and schema remain unchanged. Existing snapshot APIs and their authenticated cursors retain their default semantics; removing their other dependencies is separate work.

## SQL read and pagination

Add explicit `view: messages` selection to the existing transcript and export requests. Omitted selection preserves existing clients. The Java Provider sets it on both operations. A read-only REPEATABLE_READ transaction captures the Session message projection's covered sequence S and projection version, selects at most limit+1 message descriptors using the existing tenant/Session/first-sequence index and the full `(first_sequence,item_id)` ordering, and reads only selected bodies. Limit is 1..100 and selected metadata, parts/resources and control events share an 8 MiB byte budget; oversized single Items fail explicitly. Projection resources keep their existing scope/digest checks.

UI reads move backward; exports move forward. Both return chronological Items per page. A versioned, scoped opaque cursor carries direction, projection version, the first request's sequence upper bound and the full last-seen ordering tuple. It is a position, not an authorization credential, following the existing task cursor convention. Every request rechecks actor/tenant/Session authorization, rejects wrong direction/scope/shape/bounds and rejects projection rebuilds rather than silently skipping moved rows. Snapshot cursor formats are never reinterpreted. Bodies and statuses can change between pages; only membership is bounded by the initial sequence upper bound. Export remains finite during continued conversation.

Each response reads projection progress and message content from the same database view, including a non-locking private-CSI guard. A projection can lag the event head H; return S as transcript `lastSequence`, so SSE resumes after S and includes every unprojected event. If S is below the existing replay floor, return retryable503 `message_projection_pending` rather than handing off across unavailable events. Do not advertise H as already included, drain the complete event tail, require the writer to stop, or certify an empty projection as an empty Session. Read only the latest relevant lifecycle/control events for the selected Turns, bounded by the Item count and byte budget. Tasks, approvals, recovery and resource state continue using their existing APIs. No persistent snapshot, cross-instance cache or writer mutation is introduced by a read.

## WebShell and export

Reuse the existing `getTranscript`/`loadOlder` path, MessageList scroll trigger, in-flight exclusion and prepend anchor. Java marks its returned transcript as Item-page history. When a page supersedes an Item, replace its assembled/raw content through the page's covered sequence and retain newer stream frames, avoiding duplicate streamed text. Track coverage for each loaded Item so delayed SSE content already included by a page is also suppressed, without skipping unreturned Items or non-content side effects. Ties use the same UTF-8 binary Item-ID ordering as SQL. A gap resync replaces the current Item window and resets older-page state together; the existing raw-provider retention rules remain unchanged. Session changes and aborts discard stale responses.

Java selects live export explicitly. Reuse existing cancellation, scope/identity validation, count/byte limits, cursor-repeat rejection and rendering. Live export does not wait for snapshot publication or reject an Item merely because its body was updated after the initial membership bound. If projection has not caught up to committed events at the initial export read, return retryable503 message_projection_pending instead of silently exporting missing messages; chat still resumes SSE from S without waiting for an active writer to stop. The range bound must remain unchanged and Items must belong to it; forward pages already preserve chronological order. Other providers retain fixed-snapshot validation. Live exports must be labelled as such in their output metadata.

## Validation and acceptance

Server regression coverage: no snapshot, snapshot behind projection, lagging projection/SSE handoff, sequence ties, both directions, finite export under new inserts, updated bodies, cursor scope/version/rebuild failures, authorization, oversized bodies, resource integrity and bounded control reads. Run the same cases on H2 and real MySQL in CI. HTTP/API and surface tests cover the explicit selection and unchanged defaults.

Frontend coverage: latest-page request, exactly one older page, no automatic full drain, live append without duplicate aggregate text, gap/page races, session switch/abort, terminal Turn state, live export without snapshot readiness and retained safety guards, unchanged raw-provider behavior and scroll anchoring. Run affected package tests, build/typecheck/bundle and two clean audits; document any runtime E2E gap.

The original local Java verification budget remains CLOSED564.787/600 with35.213 forbidden. The separate preview compile/start allowance is also CLOSED315.129/600 and authorized no tests. No local Java preparation or execution is allowed; final-head CI owns new Java/H2/MySQL acceptance. Preserve the existing ce2 preview on5196 and its data. Do not claim that preview, old tests or merged status qualify this new implementation.

## Decisions and deferred work

No open product decision is needed: direct mutable message reads and live export are user-approved. Fixed historical export, snapshot-table removal, projection redesign, authority/cache windows, derived indexes, full-history recovery, and Legacy optimization are outside this change. Projection lag remains visible through the existing stream handoff; it is not solved by an unbounded query or local catch-up loop.
