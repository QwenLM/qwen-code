# Managed tool publication asynchronous verification

[English](2026-10-07-managed-tool-publication-async-verification.md) | [简体中文](2026-10-07-managed-tool-publication-async-verification.zh-CN.md)

Status: implementation for issue [#13242](https://github.com/QwenLM/qwen-code/issues/13242).

## Problem and scope

Publication uploads read their stored bytes back on the HTTP thread. Seal,
prefix, and finish scan captured streams on that same thread. The existing
operation journal has leases and idempotency receipts, but cannot reconstruct a
seal request or an inline terminal after a process restart. The worker HTTP
adapter already polls operations; its callers must continue awaiting verified
receipts before declaring a stream sealed or an execution settled.

Move producer publish, resource publish, seal, prefix, and finish verification
into a durable, bounded verifier. Keep writer finished/admission preparation,
receipt validation, ACK verification, and actual content-read integrity checks.
Do not add a general job system or change Shell execution/recovery semantics.

## Contract and compatibility

New clients send `X-Qwen-Tool-Publication-Async: 1`. The server admits new
asynchronous operations only with that header and
`qwen.managed-agent.tool-publication.async-verification-enabled=true` (default
false). The mode is saved when an operation is created. Replays and recovery
use that saved mode even after the admission flag is disabled. Legacy callers
retain synchronous responses. The header changes neither request digests nor
binding, grant, or installation schemas.

The server returns HTTP 202 with `state: PENDING` only after all inputs and the
verification-ready record are committed. Completed responses use HTTP 200.

| State     | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| PENDING   | Waiting, running, or retrying accepted verification; poll only.     |
| SUCCEEDED | Verified historical receipt, in `receipt`.                          |
| FAILED    | Permanent result, in `error: {status, code}`.                       |
| RETRYABLE | Incomplete upload or legacy claim needs the identical request.      |
| EXPIRED   | Original effective deadline elapsed; explicit recovery is required. |

Success and failure take precedence over elapsed deadlines. FAILED cannot be
reclaimed or recovered. The adapter decodes FAILED outside transport retry
handling, including quota status 507 and storage denial. It keeps its serial
queue, 250ms polls, 30-minute observation deadline, and three explicit
recoveries. Prefix remains unrecoverable after expiry.

An asynchronous exact success replay returns its historical receipt without
object I/O. It still validates identity, request digest, and known quarantine.
SUCCEEDED proves verification at completion, not that storage was never changed
later. Finish, reads, receipt verification, and ACK keep checking current bytes.
An already verified identical slot may return success directly without creating
an operation for a new idempotency ID.

## Persistence and execution

An additive migration extends the existing operation table with execution mode,
verification inputs, readiness, next-attempt time, and safe failure information,
plus a due-work index. Existing rows default to synchronous mode. Seal stores its
count, byte length, and digest; terminal and inline resource bytes are saved
before verification. Object PUT and readiness commit must complete before 202.
Unknown PUT results remain retryable and keep quota charged.

A separate executor defaults to two verifier threads, controlled by
`verification-concurrency`. Commit wakes it immediately; it drains work and a
one-second database scan recovers missed wakeups and restarts. It must not occupy
the GC/retention scheduler. Workers select a bounded unlocked candidate page,
then claim each operation using the existing parent/publication/operation lock
order. Object reads and hashing happen outside SQL transactions.

Workers use an internal accepted-operation authorization entry point and never
persist plaintext tokens. Claim, heartbeat, and completion retain binding,
writer, activation, runtime, and CSI checks using journal-head authorization.
The async admission flag requires journal-head authorization to be enabled.
Status remains a read-only scope/token query that neither starts nor renews work.

Reuse claim epochs, leases, and byte-aware deadlines. Queue time counts toward
the original deadline. A ready operation with no current lease is PENDING, not
RETRYABLE. Temporary I/O failure clears only its lease and schedules a one-second
retry; it retains active_operation_id throughout the live attempt. This also
keeps prefix input stable. Expired work stops running; recovery schedules the
same input with a new bounded recovery deadline and epoch, without changing the
original deadline, resource identity, or charged quota.

Verification keeps existing segment and aggregate SHA-256, ordinal/count,
manifest closure, and terminal checks. Only a short fenced transaction installs
VERIFIED objects, seal rows, FINISHED, and success receipts. Pending resources
cannot enter admission or settlement. Finish preserves its frozen predecessor;
a permanently failed predecessor fails finish rather than looping indefinitely.

Permanent validation/storage-denial/fencing failures persist safe status/code
without raw storage messages or credentials.
Accepted tasks whose original CSI binding was released or whose CSI authority
was fenced fail permanently and leave the queue. Replica credential-key and SQL
failures remain retryable, rather than being mistaken for lost runtime identity.
Candidate-local input or authorization errors are isolated: an unclaimed task is
failed, deferred for one second, or expired under its unchanged epoch before the
scan continues to later candidates. A failed SQL transition aborts that scan.
Before the deadline, an expired attempt may only defer under the same epoch; it
cannot publish failure or quarantine. Retry times are capped at the deadline.
Integrity quarantine and all
success/failure writes require the current live epoch. A stale worker cannot
overwrite a successor's outcome. Read leases, retirement, unresolved PUTs,
candidate/quarantined object protection, and GC quota accounting remain intact.
Permanent FAILED operations do not block collection of an accepted complete,
referenced publication. Pending operations (including expired ones), unresolved
PUTs, candidate or quarantined objects, and all other retention protections still
block collection; collection does not revive a failed operation.

## Rollout and observability

1. Apply the additive migration and upgrade every server with async admission
   disabled.
2. Upgrade clients; they continue accepting old direct receipts.
3. Enable journal-head authorization after all writers maintain its head columns,
   then enable async admission. Long-lived older clients remain synchronous.
4. For rollback, disable new async admission while workers continue draining
   existing operations. Drain or resolve those operations before downgrading
   server binaries; keep journal-head authorization enabled during drainage.

Record queue wait, verification duration, retries, failures, and expiration in
safe structured logs. Queue wait uses database timestamps; verification duration
uses the monotonic process clock. Retry logs identify the scope and operation
with the exception class only. Treat the configured throughput budget and
concurrency as operational limits, not a promise that all requests finish faster end to end.

## Validation and acceptance

Block object reads and prove async HTTP responses arrive before verification;
block PUT and prove acceptance waits for persistence. Restart the verifier
without reposting inputs, including seal and both inline/object terminal forms.
Exercise two-worker competition, lease takeover, stale success/failure,
predecessor failures, stable prefix retries, and expiry/recovery identity/quota.

Cover missing/extra segments, digest changes, invalid manifests, temporary I/O,
fenced owners, retirement, FAILED stability and error classification. Test all
new/old client and server combinations, disabling admission while work drains,
historical success replay followed by corruption detection on actual reads, and
no journal-body reads during healthy-head heartbeat/status polls. Run focused
Java/CLI tests, real MySQL recovery/competition tests, build, typecheck, bundle,
and full-diff self-audit. E2E plan/results live under `.qwen/e2e-tests/`.

## Affected components and decisions

The Java publication catalog, producer controller, authorization store,
configuration and migration change together with the CLI publication HTTP
adapter and focused tests. No unresolved product decisions remain. Persisted
work, bounded execution, strict success fences, rolling compatibility, and
historical replay are the chosen defaults.
