# Session-rooted tool output retention (O4)

[English](managed-tool-output-retention.md) | [简体中文](managed-tool-output-retention.zh-CN.md)

## Problem and baseline

O2 creates immutable foreground Shell stdout/stderr, manifests, pages and original outcomes in SQL and private OSS. O3 projects them into public Tool Results and Artifacts. Neither implementation currently proves that writers and readers have stopped before deleting bytes. This implementation is based on main `93efe3558`, including merged O3 `6310dd38d` and publication recovery fixes. Retention uses migration V28 after current main’s V27 hook-record migration; the existing V26 projection migration is unchanged.

## Contract and scope

A Session is the retention root. Outputs stay pinned through close, archive, Runtime draining, ACK and event expiry. Completed deletion permanently retires its private journal and recovery references; the original operation, retirement generation and retirement timestamp cannot be reset. Collection waits another 24 hours and independent proof of read/write closure. Collection removes original payload, not model messages or public previews already copied into history.

Only foreground Shell O2 publications are covered. Background streams, MCP, media adapters, shared outputs and generic history cleanup are outside this change. Incomplete/blocked/quarantined output, pending operations, recovery protection and legacy missing write evidence remain held. Expired predecessor recovery uses the existing explicit O2 recovery path; retirement does not mark unfinished operations as succeeded.

## Protection and retirement

The additive catalog lifecycle is `PINNED → RETIRING → DELETING → COLLECTED`; execution, capture, delivery and producer phase are unchanged. Deletion follows tenant → private journal head → publication → public Session lock order, rechecks the writer in the same transaction as public deletion, and leaves a permanent Session tombstone even if no private head ever existed. New acquisition, recovery, publication mutation and projection are fenced. Backfill skips retired heads and pending projection is suppressed.

A single database read lease covers each Artifact download, including metadata resolution and object segments; nested readers borrow the original lease without renewing it. Their fixed two-minute budget cannot be renewed; guards check database time, lease identity and retirement generation before reads and before returning bytes. Public downloads also retain O3 authorization and total-budget checks. Each lease check reads its identity, retirement and database time in one statement. Integrity quarantine remains monotonic after retirement, so a concurrently detected corrupt object stays held. Private resources and projector scans use the same protection. Expired processes may wake up, but cannot continue producing output.

Every physical PUT first records a distinct durable attempt outside the network call. A returned success closes only that attempt. An exception or process death remains unknown/outstanding and permanently blocks automatic collection until externally resolved. A successful retry cannot close its predecessor. OSS SDK retries are disabled; the existing explicit write retry creates a new tracked attempt. The OSS adapter retries only declared transient object or bucket-metadata GET errors, at most three times with 100/200/400 ms backoff. Every protected read attempt checks its original lease before network I/O; public reads also recheck current authorization; interruption, guard failures, permanent errors and response-body failures are never retried. Inline-only publications carry explicit new-protocol evidence too; old rows default to missing evidence.

## Collection and quota

Observe candidates with automatic deletion disabled. Candidate eligibility is rechecked under locks: permanently retired Session, grace elapsed, complete committed accepted publication, no active reader, no pending/unknown PUT, no candidate object, no unresolved operation, quarantine or recovery protection, and upgraded write evidence. A persistent claim generation and cursor support restart and competing instances. Each instance runs one scheduled collector.

Collection marks `DELETING` in SQL, deletes at most 100 exact catalog keys outside transactions, then confirms the page under the original claim. Idempotent `deleteIfPresent` handles missing objects and lost responses; exceptions leave the page pending. No prefix scans. A stale collector cannot advance a replacement claim or release quota. Successful physical deletion cannot be undone by new readers or PUT attempts because retirement and `DELETING` close admission.

After the last acknowledged page, SQL clears publication inline copies and corresponding Session resource copies, retains identities/digests/lengths/receipt pointers and audit timestamps, marks `COLLECTED`, and zeroes held/used accounting once. Partial success retains the full charge. Original journal and public preview/history content follow their separate existing retention policy.

## Configuration and rollout

Only `qwen.managed-agent.tool-publication.gc-enabled` (default false) and `deletion-grace` (default 24h) are added. Observation runs with publication enabled, independently of `gc-enabled`, which is reserved for the O4-2 physical collector and has no effect in O4-1. It samples at most the first 100 retired publications in fixed catalog order; this is a bounded prefix sample, not fleet totals. Cursor-based collection belongs to O4-2. Upgrade every Java writer before enabling GC; migration defaults legacy evidence to false. Renumber forward migrations against latest main immediately before landing. Do not enable deployment GC until the O4-3 database, process-failure, isolated OSS and large-closure gates pass.

## Affected layers and delivery

O4-1 adds retirement, leases, physical PUT evidence and observation to the Session/publication stores, lifecycle completion and projector/Artifact reads. O4-2 adds object deletion, claim/cursor collection and quota release. O4-3 adds fault and deployment validation and operational instructions. No public endpoint, Web Shell flow, active-Session TTL or new public 410 response is added. Private retired output fails explicitly and never reruns tools.

## Acceptance and unresolved deployment evidence

Test retained output after seal/close/archive; delete vs acquisition/receipt/projection/download; lease expiry and generation mismatch; unknown late PUT after retry; response-loss deletion; mid-page/process crash; SQL confirmation failure and two-worker takeover; conservative accounting; protected partial/quarantined/legacy cases. Real MySQL/MariaDB is required for locking evidence. Real OSS uses a fully isolated test bucket and prefix. Validate 100 MiB and 1 GiB closure accounting and bounded pages. Record exact revision, runtime, database and storage profile in reports, and distinguish executed gates from unavailable gates. The O2/O3 baseline is aligned; isolated OSS credentials remain an external dependency for the optional deployment gate.
