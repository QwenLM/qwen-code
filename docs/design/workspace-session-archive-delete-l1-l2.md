# Workspace Session archive, unarchive and closed deletion (L1–L2)

[English](workspace-session-archive-delete-l1-l2.md) | [简体中文](workspace-session-archive-delete-l1-l2.zh-CN.md)

## 1. Status and baseline

Implemented and synchronized with main, 2026-10-02, on `codex/workspace-session-l1-l2`. This document
covers L1 and L2 of [#13164](https://github.com/QwenLM/qwen-code/issues/13164).
Verification and remaining environment limits are recorded in section 8.

The integrated baselines are:

- [Reliable Workspace close, #13135](https://github.com/QwenLM/qwen-code/pull/13135),
  merged commit `9478f28731f45ff6df66062e7e05d29e92906f19`.
- [O4-1 Session retirement, #13084](https://github.com/QwenLM/qwen-code/pull/13084),
  merged commit `e1167c1f9ca3d54747c8c0145c1d805259ab0226`.
- The existing [D4 lifecycle design](https://github.com/QwenLM/qwen-code/blob/63e840cedf87fa54cf80c826112b8cc77272cff4/docs/design/2026-09-28-managed-agent-durable-lifecycle.md)
  and [Workspace close design](https://github.com/QwenLM/qwen-code/blob/9478f28731f45ff6df66062e7e05d29e92906f19/docs/design/workspace-session-reliable-close.md).

Both prerequisite PRs are merged into main. This branch retains their final
locking, close recovery and retirement implementations. L1 and L2 target main;
L2 uses actual retirement, not a placeholder. Main's follow-up
[#13223](https://github.com/QwenLM/qwen-code/pull/13223) resolved the close
migration's collision with recovery bundle V31; that fix is retained here.

## 2. Problem and existing behavior

#13135 makes an idle files-profile Workspace Session reliably close: a permanent
Broker fence prevents new warm and execution, original resources settle, and a
completed CLOSE operation proves the transition to `CLOSED`. Archive, unarchive
and delete still reject a Workspace binding.

D4 already supplies most of the required behavior:

- Archive completes its operation, state change and event in the admission
  transaction, while still returning HTTP `202`.
- Delete durably admits `DELETING`, then a coordinator commits a tombstone and
  a completed operation. Session reads hide tombstones; operation reads retain
  them and recheck current Workspace read access.
- Public unarchive is a synchronous `200` mutation returning a Session. It
  restores `CLOSED`, but its command key is tenant/operation/key scoped, without
  actor or Session in the storage key. Admission and completion are separate
  transactions. WebShell has no unarchive route.
- In #13135, the coordinator attempts Workspace close for every bound lifecycle
  operation, including one admitted from `CLOSED`. Merely opening delete
  admission would repeat cleanup and depend on the current Runtime deployment.
- O4-1 can retire private recovery and publication access in the same transaction
  as a tombstone. It performs no physical erasure.

## 3. Decisions and scope

1. **Accept only reliably closed bound Sessions.** L1 archive requires `CLOSED`,
   unarchive requires `ARCHIVED`, and L2 delete requires either. A fresh request
   must also find a completed CLOSE operation for the same tenant and Session,
   with a non-null receipt. This reuses #13135's completion evidence without
   another receipt, profile column or Broker protocol. Missing evidence returns
   `409 workspace_unavailable`; a status value alone does not manufacture proof.
2. **Creator with current read access.** Use the same creator record and read
   grant as #13135. A readable non-creator gets `403 session_operation_forbidden`;
   an unreadable or cross-tenant Session gets `404 session_not_found`. Workspace
   administrator deletion and the broader role matrix stay outside this slice.
3. **Metadata operations survive execution configuration changes.** Once close
   has completed, L1/L2 require neither a configured Harness/RuntimeWarmer nor
   current execution mounts or files enablement. New requests still require
   current read access. An admitted delete finishes even if that access is later
   revoked.
4. **Use the existing stores and coordinator.** Archive/delete retain D4
   operations. Bound unarchive uses an atomic synchronous transaction and the
   existing command table. No new operation kind, background worker or public
   response family is introduced.
5. **Retirement is part of deletion.** L2 uses O4-1's actual retirement barrier
   inside tombstone completion; it does not enqueue retirement after deletion.
6. **Keep the scope reachable from #13135.** That baseline can reliably close
   only `hosted-workspace-files/1`. L1/L2 do not enable Shell/MCP close, delete an
   active Session, run Hooks, change cwd, reopen Sessions, add UI buttons, or
   physically erase history, backups, Workspace files or publications.

The completed-close lookup is used by admission and capability projection. It
must stay tenant/Session scoped and must not infer completion from an expired
writer lease, a missing Runtime, or a Harness `404`. Its CLOSE record and the
permanent Broker fence remain retained through archive, unarchive and deletion.
Future receipt purging must preserve equivalent evidence before removing them.

## 4. HTTP, state and authorization contract

### 4.1 Routes and results

| Operation | Public route                                     | WebShell route                                             | Result                                                        |
| --------- | ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- |
| Archive   | `POST /v1/agents/sessions/{sessionId}/archive`   | `POST /api/agent/web-shell/v1/sessions/archive`            | `202`, completed command operation                            |
| Unarchive | `POST /v1/agents/sessions/{sessionId}/unarchive` | **New:** `POST /api/agent/web-shell/v1/sessions/unarchive` | `200`, public or WebShell Session; `X-Qwen-Idempotent-Replay` |
| Delete    | `DELETE /v1/agents/sessions/{sessionId}`         | `POST /api/agent/web-shell/v1/sessions/delete`             | `202`, durable command operation                              |

Public requests retain the `Idempotency-Key` header. The new WebShell route
reuses `WebShellLifecycleRequest` (`sessionId`, `idempotencyKey`) and projects
the same service result into `WebShellSession`. It must not copy mutation logic
into the adapter. Share the internal Session record and replay marker, then use
each surface's existing projection; do not convert a serialized PublicSession
into a WebShellSession. This route is persisted-workspace scoped: resolve the stored
Session binding and its tenant/actor grants; never select a live or primary
Runtime as a fallback.

| Fresh bound request | Required status                  | Committed state and events                                                            |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| Archive             | `CLOSED`                         | `ARCHIVED`; one `session.archived` carrying `operationId`                             |
| Unarchive           | `ARCHIVED`                       | `CLOSED`; `session.unarchive.requested` and `session.unarchived` in one transaction   |
| Delete admission    | `CLOSED` or `ARCHIVED`           | `DELETING`; one `session.delete.requested`                                            |
| Delete completion   | `DELETING`, valid delivery claim | `DELETED`, O4 retirement, completed operation and terminal `session.deleted` together |

No new `ARCHIVING` state is used. Existing legacy recovery stays intact.
Unarchive never makes a Session `ACTIVE`, releases the close fence, starts warm,
acquires a writer or reinstalls a Runtime.

### 4.2 Admission order and replay

For bound mutations, validate the key, lock the public Session row, and recheck
current read access and creator identity in that transaction. Then:

1. Look up the actor/Session-scoped key and validate its request digest.
2. For a replay, return without another state change or event. Archive/delete
   return the original operation's latest durable status, even on a tombstone.
3. For a new request, a tombstone returns `404 session_not_found`; an invalid
   source state returns `409 session_state_conflict`. In particular, L2 rejects
   `ACTIVE` even with no active Turn; it does not silently perform close.
4. Check for pending mutation commands or unfinished operations, including
   `RECOVERY_BLOCKED`, and return `409 session_operation_active` if present.
5. Require completed-close evidence, then commit the slice's mutation.

Read access and creator checks precede replay; an old key is no authorization
bypass. Another actor's identical key is a separate request and cannot replay
the creator's result; the non-creator is still forbidden. Key spelling is
byte-sensitive, with no trimming or case normalization. Preserve the existing
1–128 visible ASCII (`0x21`–`0x7e`) validation: whitespace, control characters
and oversized keys return `400 invalid_idempotency_key` on the public surface.
WebShell retains its request validation: oversized keys return
`400 invalid_request`; whitespace/control characters return
`400 invalid_idempotency_key`. Neither surface normalizes keys. Digest mismatch remains
`409 idempotency_conflict`. Both surfaces use the same identity domain.

Operation queries keep the D4 read rule, not the mutation rule: any actor with
current read access may read a known operation, including after deletion.
Unknown operation IDs return `404 operation_not_found`. Loss of read access
hides the operation; it does not cancel accepted cleanup.

### 4.3 Capabilities

Add optional `session_archive`, `session_unarchive`, `session_delete`, and the
WebShell equivalents `sessionArchive`, `sessionUnarchive`, `sessionDelete`.
Absent fields mean false. L1 ships the first two; L2 adds delete with the actual
retirement integration. Do not advertise an unimplemented next slice.

For bound Sessions, the new flags require completed-close evidence. They express
support for retaining/managing that settled Session, not creator authorization
or whether the current state accepts that particular action. Thus both archive
and unarchive support may be true on a closed Session, while unarchive still
requires `ARCHIVED`. An active bound Session without close evidence advertises
false. Read capability projection never requires mounting or warming a Runtime.
For unbound Sessions, the flags reflect the existing supported operations.

Keep #13135's `session_close` semantics and bound `session_lifecycle: false`.
L2 still lacks active deletion and other profiles, so flipping the aggregate
would overstate support. Keep WebShell's planned aggregate unchanged. Update
canonical OpenAPI descriptions and regenerate WebShell types in each slice;
existing clients tolerate the optional fields. No UI integration is required.

## 5. L1 implementation design

### 5.1 Archive

Extend the bound admission entry alongside #13135's close admission to select
CLOSE or ARCHIVE explicitly. Keep legacy admission separate and share its
existing insertion/event logic. Retain close's original checks; archive uses
the settled-state rules in section 4 rather than Runtime support checks.

Under the Session lock, an admitted archive atomically inserts a completed
ARCHIVE operation with receipt, updates `CLOSED` to `ARCHIVED` and emits
`session.archived`. It never dispatches the coordinator or calls O4 retirement.
History, Artifacts, publications, backup references and shared files retain
their existing read/retention semantics.

### 5.2 Atomic bound unarchive

Add one bound-only transactional store entry, such as
`unarchiveWorkspaceSession`, reached by both HTTP adapters. Keep the legacy
unbound command namespace and two-stage behavior compatible.

Reuse `managed_agent_command` with operation namespace
`UNARCHIVE_WORKSPACE_SESSION` (fits its 32-character column). Its stored
idempotency key is the existing canonical `RequestDigests.digest` of
`sessionId`, `actorDigest` and the exact client `idempotencyKey`; the tenant is
already in the primary key. The 71-character `sha256:` value fits the
128-character key column. Use the lifecycle request digest for
`UNARCHIVE_SESSION` separately to validate request identity. The distinct
namespace avoids collisions with raw legacy keys and leaves rename unchanged.

After authorization/replay/state/conflict/proof checks, the transaction writes
the completed command (recording `ARCHIVED` as its source status), updates the
Session to `CLOSED`, and appends the two existing unarchive events. Event source
keys include the new namespace and scoped key. There is no committed `PENDING`
interval for a crash to strand. A lost reply replays the committed command; a
pre-commit crash leaves no command, event or state change.

**Clarification to #13164's “original result” acceptance:** unarchive reuses the
original mutation result in the sense of no repeated effect, and returns the
current visible Session, matching the existing public response contract. It
does not store an immutable Session response snapshot. If another key archives
the Session again, replaying the old unarchive key returns that archived view
with the replay header true and does not unarchive again. After deletion it
returns `404`, because this response is a Session read, not an operation read.
Check tombstone visibility before returning an unarchive replay. Archive/delete
continue to replay their operation on a tombstone. Tests and OpenAPI must make
this distinction explicit on both surfaces.

## 6. L2 implementation design

### 6.1 Admission and delivery

Extend the same bound lifecycle entry to DELETE only from `CLOSED` or
`ARCHIVED`. In one admission transaction, persist the original source status,
actor-scoped key and operation, set `DELETING`, and append the requested event.
Keep D4's asynchronous `202`, operation query and recovery scan.

In the coordinator, add a narrow path for a bound DELETE whose persisted
`sessionStatusBefore` is `CLOSED` or `ARCHIVED`. It goes directly to the store's
completion transaction with `harnessConfirmed = false`. It must make zero calls
to Harness close/detach, `requestWorkspaceClose`, `closeWorkspace`, generic
drain, provider release or provisioning. The already completed CLOSE is the
cleanup authority; this also makes completion independent of revoked mounts.
Other operation paths retain their existing behavior.

Use #13135's database-time claim expiry, renewal and generation checks. L2
retries ordinary transaction/retirement failures with the existing backoff.
L2 performs no uncertain remote execution and does not create blocked DELETE
operations. An older coordinator can nevertheless park an admitted DELETE as
`RECOVERY_BLOCKED`. The scanner and claim query reclaim BLOCKED CLOSE and
DELETE admitted from CLOSED or ARCHIVED after their existing backoff; ACTIVE
DELETE stays blocked. The new coordinator completes those admitted closed-session
deletes without Runtime work and retains lease/generation checks.
A residual live writer fails retirement and leaves `DELETING` pending retry;
L2 neither kills that writer nor manufactures completion evidence.

### 6.2 Atomic completion and retained data

Within one database transaction:

1. Acquire the retirement locks in section 6.3, then lock the Session and
   operation. A preliminary lookup may discover immutable operation kind only;
   it cannot authorize retirement.
2. Recheck `LEASED`, owner, claim generation and an unexpired database-time
   lease after waiting for locks. Check `DELETING` and the persisted L2 source
   status. A stale claim returns without retirement or tombstone changes.
3. Invoke O4-1 retirement under those same locks. It rechecks the journal writer
   against database time, records permanent Session retirement, marks the
   private journal `DELETED`, moves `PINNED` publications to `RETIRING`, and
   suppresses unfinished tool-result projection. Keep recovery protection and
   unresolved physical PUT evidence exactly as O4-1 defines them.
   Non-READY private recovery records `recovery_protected = true` rather than
   blocking the tombstone; the protected bytes remain ineligible for collection.
4. Commit the public tombstone and timestamp, completed operation and receipt,
   and terminal `session.deleted` event together with retirement. Event
   notification follows commit. Its `admission_stage` remains `java_durable` because
   this delete did not contact the Harness.

Any failure rolls back every retirement and completion write. Recovery after a
crash either finds no completion and retries, or finds the committed operation
and replays it. Retirement must be keyed to this operation, not silently reused
from another operation.

Following deletion, public Session content reads, including Artifacts, follow
the existing tombstone `404` behavior; operations remain readable under current
read grants. O4-1 blocks new private recovery/publication access and preserves
its bounded in-flight reader and unknown-PUT rules. L2 does not claim immediate
revocation of bytes already delivered to a reader. Rows, backup bytes, permanent
fences and operations are retained; shared Workspace files and other Sessions'
holders are untouched. O4-2 decides later collection eligibility; L2 neither
runs that collector nor promises physical erasure.

### 6.3 Reconcile the prerequisite lock order

Retain main's resolved ordering. Writer acquisition locks the retention tenant,
then the public Session, then its journal head. O4-1 deletion and tool-result
projection completion use:

`retention tenant → journal head → publication rows (sorted for deletion) → public Session → operation/projection claim`.

The shared retention tenant guard serializes writer acquisition against
deletion/projection even though their later public/head lock orders differ.
Retain the writer's non-`ACTIVE` and retired-state refusals before inserting or
updating its head. An absent head is also serialized by the same tenant guard.
Do not move the public lock before that guard or replace main's final writer
ordering with the earlier prerequisite snapshot.

L1/archive/unarchive and delete admission take only the public Session followed
by their command/operation locks; they must not acquire retention or journal
locks afterward. Their close-evidence lookup is a nonlocking read of a terminal
operation. A writer waiting behind admission observes the committed non-ACTIVE
status and refuses. Claim renewal/retry touch the operation only and must not
later acquire a Session/journal lock. Revalidate this order on the integrated
prerequisite heads and prove the races on real MySQL before enabling L2.

## 7. Change map and rollout

Paths below are relative to the repository and describe the implemented changes,
including the prerequisite integration.

| Area                                                                                                      | L1                                                               | L2                                                                        |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.../service/SessionLifecycleService.java`                                                                | Bound archive admission                                          | Bound closed/archived delete admission                                    |
| `.../service/ManagedAgentService.java`                                                                    | Bound unarchive, Session projection and capabilities             | Delete capability                                                         |
| `.../store/AgentStateStore.java`, `ManagedAgentStore.java`                                                | Bound admission and atomic unarchive entry; close-evidence query | Closed-delete gate and integrated claim/retirement completion             |
| `.../api/WebShellAgentController.java`, `ApiModels.java`                                                  | Unarchive adapter and optional capability fields                 | Optional delete fields                                                    |
| `.../service/SessionLifecycleCoordinator.java`                                                            | No archive dispatch                                              | Skip resource cleanup only for the admitted L2 path                       |
| `.../store/ManagedSessionStore.java`, `ToolPublicationRetentionStore.java`, `ManagedToolResultStore.java` | No retention change                                              | Reconcile writer lock order; reuse retirement; verify projection ordering |
| `packages/sdk-java/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json` | Routes, replay semantics, authorization and capabilities         | State restrictions, retirement and tombstone behavior                     |
| `packages/web-shell/client/components/managed/generated/managed-agent-api.ts`                             | Regenerate optional fields and unarchive route types             | Regenerate delete capability                                              |

The `...` Java prefix above is
`packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent`.
Focused tests belong beside the existing lifecycle, operation-store, API,
retention and Hosted/MySQL tests. Audit all new capability read sites and every
adapter/service/store caller; do not leave declared flags or options unpopulated.

L1/L2 add no table or column beyond the prerequisites. Main contains O4-1
retention at Flyway `V30`, recovery bundles at `V31` and close at `V32` after
#13223 resolved their earlier version collision. This branch retains that fix,
including the unchanged close SQL and earlier migrations.
Fresh schemas and upgrade from `V31` are tested. A deployment
that applied close under an earlier branch-only version must reconcile its
migration history explicitly; do not silently rewrite an applied migration.
Integration preserves #13135's database-time expiry check and uses a current
locking read after the operation lock. Review merged behavior, not just merge conflicts.

Deploy compatible binaries and reconciled schemas to all Managed Agent writers
and lifecycle workers before admitting bound L2 operations. An old #13135
coordinator would attempt Runtime cleanup for them and can leave them BLOCKED
when Runtime close support is unavailable. Upgraded coordinators recover those
admitted CLOSED/ARCHIVED deletes without another Runtime call. Use a coordinated rollout
or existing deployment traffic controls, without adding a speculative feature
flag. Preserve older unbound keys, migration recovery and response shapes.

L1 and L2 remain separate review scopes on the main-based branch. Their close
and O4-1 prerequisites are now merged. The separate close→SessionDelete coupling
between #13135 and H2 (#13129) still needs an independently owned fix or release
ordering; these metadata-only operations do not resolve that existing coupling.
Shell publication collection through a real Shell API delete remains L4's exit
check, not a result L2 can demonstrate using the files profile.

## 8. Validation and acceptance

The executable plan and results are recorded under
`.qwen/e2e-tests/workspace-session-archive-delete-l1-l2.md`. The global `qwen`
CLI has no Hosted archive/unarchive/delete commands, so its baseline dry-run
confirmed the need for an actual HTTP/store test-script fallback. This is
Hosted API coverage, not CLI command coverage.

Focused Java API/store/coordinator and OpenAPI contract tests cover the two
surfaces, legacy regression, permissions, close proof, replay, invalid keys and
metadata without execution support. Real MySQL tests cover unarchive concurrency,
rollback at mutation/completion writes, expired claim after a lock wait and
second-instance takeover, recovery protection, ACL/config removal, queued
writer/projection completion with present/absent journal heads, residual-writer
renewal versus retirement, and prerequisite schema upgrade. The actual HTTP probe
passes both surfaces and confirms no extra Runtime execution/cleanup calls.
Build, typecheck, bundle and generated WebShell contract/client tests pass.

The lock-wait test exposed a repeatable-read snapshot bug in the prerequisite
completion lease query. The lease is now read with `FOR UPDATE` after the
operation lock, so expiry during the wait cannot authorize a tombstone.
This applies to close completion as well; its focused regressions pass.

The author's host is macOS and its metadata tests use deterministic close
evidence. Independent reviewer [wenshao's Linux verification](https://github.com/QwenLM/qwen-code/pull/13194#issuecomment-5955445033)
on `2486d3dad` supplies real packaged Hosted Harness, worker-stop, shared-file,
neighbour isolation and crash/takeover evidence on both API surfaces. The pinned
[rig and results](https://github.com/wenshao/qwen-code/tree/ff11be0a23ada2f1bdf955ebafd463779aefb670/pr13194)
use a deterministic model and a test authentication adapter. This evidence is
attributed to that reviewer and commit, not an author rerun of the final head.
Windows, Shell/MCP profiles, real OSS collection and physical erasure remain
outside that report. Warm refusal with an ACTIVE-neighbour positive control,
not input refusal alone, establishes the retained close fence.

| Group                  | Required evidence                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both surfaces          | Close through #13135, archive, unarchive, delete from CLOSED and from ARCHIVED; correct status, headers, operation IDs and camel/snake-case projections                                                                                                                    |
| Authorization          | Creator/read success; unreadable and cross-tenant 404; readable non-creator 403; permission checked again on replay and operation read                                                                                                                                     |
| State and proof        | Reject ACTIVE, CLOSING and DELETING fresh metadata requests as specified; reject manually seeded CLOSED/ARCHIVED without completed-close evidence; unfinished operations conflict                                                                                          |
| Idempotency            | Concurrent same key once; cross-surface same key once; distinct actor/Session/kind domains; case-distinct valid keys; whitespace/control/oversized keys rejected without trimming; no duplicate events; digest mismatch at store level                                     |
| Unarchive replay       | Crash before commit and lost response after commit; replay after rearchive returns current ARCHIVED without changing it; replay after tombstone 404; no orphan PENDING command                                                                                             |
| Permanent closure      | After archive/unarchive, input/new writer/warm remain refused and original close receipt/fence remain; no model, Hook, provider or Runtime calls                                                                                                                           |
| Data retention         | Original history, Artifacts and publications remain readable through L1; L2 denies public/private reads as contracted while retaining bytes, backups and shared files                                                                                                      |
| Delete atomicity       | Faults after each retirement/tombstone/operation/event write roll everything back; no-head/no-publication Sessions still get a permanent barrier; residual live writer prevents completion; non-READY recovery allows the tombstone while preserving collection protection |
| Claims and recovery    | Crash after admission and during completion; second-server takeover; expired/stale claim cannot retire; reply loss replays receipt; accepted delete completes after ACL/mount revocation without Runtime support                                                           |
| Real MySQL races       | Writer acquire vs close/L1/delete admission and delete completion, with existing and absent head; writer renewal vs retirement; projection completion vs deletion; late callbacks and duplicate keys; bounded progress and no post-retirement admission                    |
| Regression and upgrade | Legacy unbound lifecycle/replay unchanged; #13135 close still fences and drains; O4 writer/reader/PUT protection preserved; both prerequisite migrations work from clean and existing schemas                                                                              |

Use focused Java API/store/coordinator tests for behavior and real MySQL for
locking, lease time and transaction races. Add a Hosted test with the packaged
Harness and a real files Session for close→L1→L2, keeping another Session's
shared files/holder intact. Assert no Harness/Runtime interactions on L1 and L2
with failing spies, so a green test cannot conceal unnecessary teardown. Reuse
#13135's worker-stop evidence; new physical Linux crash/stop claims are not
needed for metadata transactions. Build/typecheck and the affected Java/generated
contract tests must pass when implementation is delivered.

Acceptance requires both API surfaces, explicit unarchive replay semantics,
one-transaction L1 mutation and L2 retirement/tombstone completion, retained
close fences, correct authorization, and the real-MySQL races above. H2 Hooks,
active deletion, Shell/MCP settlement and physical collection are not acceptance
substitutes or prerequisites for these two slices.

## 9. Proposed resolutions and remaining coordination

For #13164's questions, this proposal selects: keep Shell/MCP in L4; require
O4-1 before L2; use per-operation capabilities; retain creator plus current read
access as the interim mutation authority. It also selects the new WebShell
unarchive route and current-Session replay semantics instead of response
snapshot storage. These are design recommendations, not claims that the issue's
maintainers have already accepted them.

Implementation must recheck prerequisite heads and actual migration allocation,
and coordinate the independent H2/close release interaction. No additional
product decision is required to make L1/L2 implementable under the choices above.
