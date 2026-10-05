# Managed Agent Durable Lifecycle (Stage D4)

[English](2026-09-28-managed-agent-durable-lifecycle.md) | [简体中文](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md)

Status: implemented in this change
Date: 2026-09-28
Issue: [#12867](https://github.com/QwenLM/qwen-code/issues/12867), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [API contract (D1)](2026-09-27-managed-agent-api-contract.md), [Session query (D2)](2026-09-27-managed-agent-session-query.md) and [Event replay (D3)](2026-09-27-managed-agent-event-replay.md)

## 1. Problem

Section 10 of the [public API contract][contract] defines close, archive and
delete as separate durable operations. Each answers `202` with a command
operation that a client can read back through the operations route, archive
accepts only a closed Session, delete keeps the shared Workspace and leaves a
tombstone, and close and delete still pass the Hooks and resource settlement,
so a `202` never claims that tools stopped. After D3 the server did not match
that:

- `archive` and `DELETE` ran their cleanup inside the request. They closed the
  Hosted Harness Session, drained the Runtime and answered `200` with the
  Session or a `DeletedSession`. When the Harness or the Runtime failed, the
  request answered `503` and left the Session `archiving` or `deleting` with a
  pending command that only a retry of the same key could finish.
- Archive closed the Harness itself, so it accepted an active Session. There
  was no close route, no operation route, and `DeletedSession` had no schema.
- The contract test listed these three differences as its last known gaps.

The exit check in #12867 is that the three gap lines go away, that the
lifecycle routes move to `implemented`, that a replayed key returns the
original operation, and that a different payload under the same key conflicts.

## 2. Goals

- Serve close, archive and delete on both surfaces as durable operations that
  answer `202` with `PublicCommandOperation` or `WebShellCommandOperation`.
- Serve the operation query on both surfaces, including for a deleted Session.
- Deliver close and delete in the background until their Harness close and
  Runtime drain succeed, surviving failing Harness calls, failed attempts and a
  lost worker.
- Keep the idempotency domain of the contract: tenant, Session, operation kind,
  actor and key.
- Finish archives and deletes that were waiting for a retry when the server is
  upgraded.

## 3. Non-goals

- Durable admission for input and cancellation (`java_durable`, D7), Actions
  (D6) and Turns (D5). The operations table and route are written so that D7 can
  add kinds to them.
- The reader, operator and owner roles of section 10, whose source is still an
  open question in #12867 (Q4), and lifecycle operations on Workspace-bound
  Sessions, which wait for it (4.9).
- `archived_at` and the list's `include_archived`, which stay `planned`.
- Erasing a deleted Session's content and purging tombstones and operations
  after the retry window. Both belong to the retention work.
- The `failed`, `cancelled` and `recovery_blocked` outcomes. D4 operations retry
  until they complete (4.5).

## 4. Decisions

### 4.1 Contract v1.18

- `closeSession`, `archiveSession`, `deleteSession`, `getSessionCwdOperation`
  and the WebShell `closeWebShellSession`, `archiveWebShellSession`,
  `deleteWebShellSession` and `webShellQueryCwdOperation` move to
  `implemented`. The operation routes keep their `operationId`s although they
  serve every operation kind, so that no published name changes.
- `DeletedSession` goes away: delete answers with the command operation.
- The schemas those routes use lose their `planned` marker:
  `PublicCommandOperation`, `WebShellCommandOperation`, `PublicOperation`,
  `WebShellOperation`, `WebShellLifecycleRequest` and
  `WebShellOperationRequest`. Besides `task_id`, which only a task cancel
  carries, three parts stay `planned`: the cwd member of the two operation
  unions (W2), `action_resolution` (D6) and `failure_code`, which no lifecycle
  operation sets. The generated WebShell types therefore read
  `WebShellOperation` as `WebShellCommandOperation`.
- `SessionCapabilities.session_lifecycle` is implemented. It is `true` for a
  Session without a Workspace binding and `false` for a bound one (4.9). The
  WebShell capability object stays `planned` in this change; the Stage H0c work
  is making it implemented.
- The descriptions of close, archive, delete, unarchive and the operation
  route state the behavior below. The known-gap file keeps no lines, and its
  header now points at #12867.

### 4.2 Session states

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `active`    | Accepts input.                                                       |
| `closing`   | A close was admitted; input is sealed and the close is delivered.    |
| `closed`    | No Harness holds the Session and its Runtime binding drained.        |
| `archived`  | Closed and archived.                                                 |
| `deleting`  | A delete was admitted; input is sealed and the delete delivered.     |
| `deleted`   | Tombstone: Session reads return `404`, its operations stay readable. |
| `archiving` | Only for an archive admitted before this change (4.10).              |

Close moves `active` through `closing` to `closed`. Archive moves `closed` to
`archived` and unarchive moves it back. Delete accepts `active`, `closed` and
`archived` and moves through `deleting` to the tombstone.

A new operation answers:

- `404 session_not_found` for an unknown Session, another tenant's Session, a
  bound Session that the actor cannot read, and a deleted Session;
- `409 session_state_conflict` when the Session is not in a status the
  operation accepts;
- `409 turn_active` when an active Session has an accepted, running or
  cancelling Turn, as archive and delete did before;
- `409 session_operation_active` while another operation is open or a rename
  or unarchive command is pending;
- `409 workspace_unavailable` for a bound Session the actor can read.

### 4.3 Operations and their idempotency domain

Flyway V17 adds `managed_agent_operation`. A row holds the operation's Session,
id (`op_` and 32 hex digits), kind, actor digest, key and request digest, its
status, admission stage and delivery state, the Session status it was admitted
on, its receipt, and the lease, claim generation, attempt count and
`available_at` time of its delivery.

The table is unique on tenant, Session, kind, actor digest and key, which is
the domain that section 3 of the contract names. The actor digest is a SHA-256
digest of the trusted actor ID, or empty for a request without a trusted actor,
so another actor's use of a key is another request and never returns the first
actor's operation. The request digest covers the Session and the kind under
the command names that archive and delete used before (`ARCHIVE_SESSION`,
`DELETE_SESSION`, and `CLOSE_SESSION`), so a retry of a migrated command
matches (4.10).

A lifecycle request carries nothing beyond its Session and kind, and both are
part of the domain. A different payload under the same key therefore cannot
occur: the same key replays, and the same key on another Session, for another
kind or from another actor is a separate request. The stored digest is still
compared, and a mismatch answers `409 idempotency_conflict`; only a store test
can present one.

A replay answers `202` with the operation's latest durable status and
`replayed: true`, also after the Session was deleted.

### 4.4 Admission

One transaction locks the Session row and then looks up the key, turns a new
key on a tombstone away, checks for an open operation, checks the status and
Turns, inserts the operation, seals the Session to `closing` or `deleting` and
appends `session.close.requested` or `session.delete.requested`. Events of an
operation carry its `operationId`.

Java is the only authority an archive needs, so an archive completes in the
same transaction: the Session becomes `archived`, the operation is completed
with a receipt, and `session.archived` is appended. Archive no longer appends a
`requested` event.

After the transaction commits, the service hands a close or a delete to the
worker at once. The worker's scan finds it anyway, so a crash between the two
loses nothing.

### 4.5 Delivery

`SessionLifecycleCoordinator` delivers a close or a delete:

1. It claims the operation with a lease of `dispatch.lease-duration` (60 s) and
   a new claim generation. Its scan runs every `dispatch.scan-delay` and claims
   pending operations whose `available_at` has passed and leased ones whose
   lease expired.
2. If the operation was admitted on an active Session, it closes the Session in
   the Hosted Harness. This is the settlement archive and delete used before:
   the Harness seals the Session's journal writer and stops its streams. The
   Hosted profile runs no Session Hooks today, and D4 adds none. The Harness
   answers `404` for a Session it does not hold. A server without a
   configured Harness skips the close of a Session that no Harness held and
   fails the attempt for one that a Harness held. Then no writer may hold the
   Session's journal under a lease that database time has not passed: the
   Harness that holds a Session renews that lease and seals the writer when it
   closes the Session. So a `404` from another server's Harness does not
   complete the close; the attempt fails until the server whose Harness holds
   the Session claims the operation, or until that lease expires.
3. It drains the Session's Runtime binding. The embedded Runtime Broker only
   stops warming the Session again; it has no Harness-level teardown yet.
4. In one transaction that locks the Session row, it checks that its claim is
   still current, completes the operation, sets the Session to `closed` or to
   the tombstone, and appends `session.closed` or the terminal
   `session.deleted`.

A failed attempt returns the operation to pending with the dispatch backoff,
from `dispatch.retry-initial-delay` doubling to `dispatch.retry-max-delay`, and
counts it. There is no last attempt: an operation completes only after its
steps succeed, so the `202` never claims that tools stopped, and an operation
whose Harness keeps failing stays `running`. After the Hosted Harness
restarts, the Java connector keeps the previous boot, so its calls fail with a
generation error until Java restarts too, as Turn dispatch does; the operation
waits meanwhile, and then until the old process's writer lease expires.

A Harness that stopped writing the Session's journal cannot close it either.
After any failed journal commit, for example one made while Java or its
database was unavailable, the Harness refuses every further commit for that
Session, and its close first records that its activation ended, so it answers
every attempt with `503`. Its writer lease can stay live, because the writer's
own renewal keeps running, so no other server can complete the close; the
operation stays `running` until that Harness restarts, and Java with it as
above. Only when that lease lapses too can another server's Harness complete it
(step 2). D4 does not complete such a close without the Harness: section 10 of
the [contract][contract] keeps close and delete behind the existing Hooks and
resource settlement, and only the Harness can report that its Session settled.

Both steps are idempotent, so a repeated attempt is safe. Leases use each
server's clock, as Turn leases do, rather than the database time that section 1
of the [contract closure][closure] asks for, and they are not renewed. With the
default lease (60 s) and Harness request timeout (30 s), attempts on one server
overlap only after a worker is lost, but clock skew, a shorter lease or a slow
first connection can also let them overlap. The claim generation keeps a stale
attempt from completing, and a repeated close is harmless.

A delete leaves the shared Workspace alone: the worker only closes the
Session and drains its own Runtime binding.

### 4.6 Operation fields

| Field             | Values                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `status`          | `pending` when admitted, `running` from the first claim, `completed` at the end.                               |
| `admission_stage` | `java_durable`; at completion `harness_confirmed` if the Harness that held the Session acknowledged its close. |
| `delivery_state`  | `pending` between attempts, `leased` during one, `confirmed` when completed.                                   |
| `receipt_id`      | An opaque `rcpt_` receipt that Java issues when the operation completes.                                       |

The Harness that held the Session is the one whose boot ID the Session
recorded: Turn dispatch records the boot it attaches to, and a rename records
one only when none is recorded yet, so after a rename alone the record can be
older and the close is reported `java_durable` although it was sealed. A new
archive, a delete of a closed or archived Session, and a close or delete of a
Session that no Harness held stay `java_durable`: no Harness confirmed
anything about the Session. So does one whose Harness was replaced by a
restart: the new Harness answers that it does not hold the Session, and the
operation completes once the old process's writer lease has expired instead of
being sealed. An archive migrated from before V17 was admitted on an active
Session, so it closes the Session first and can complete as
`harness_confirmed` (4.10). `failure_code`, `blocked` and the `failed`,
`cancelled` and `recovery_blocked` statuses are not produced.

### 4.7 Reading operations

`GET operations/{operationId}` and WebShell `operations/query` check the tenant
and the Workspace read grant like the other reads, but they also find a
deleted Session, so a tombstone's operations stay readable. An unknown
operation is `404 operation_not_found`. Reading is not a replay, so it answers
`replayed: false`. Nothing purges operations or tombstones yet, so they stay
readable for at least the contract's retry window (24 hours).

### 4.8 Unarchive and rename

Unarchive stays a synchronous mutation answering `200` with the Session and
stays `partial`. It restores `closed`, because an archived Session was closed
first; the contract has no operation that reopens a closed Session. It no
longer lifts the Runtime drain, so `RuntimeWarmer.resume` goes away. Rename is
unchanged and accepts only an active Session. A pending rename or unarchive
command and an open operation block each other.

### 4.9 Roles and Workspace-bound Sessions

The role matrix waits for the answer to #12867's Q4. This change keeps the
existing checks and adds the actor to the idempotency domain:

- A Session without a Workspace binding is scoped by its tenant, as its other
  routes are.
- A bound Session needs the actor's read grant, or it answers `404`. Its
  lifecycle operations answer `409 workspace_unavailable`, as its rename and
  input do, until the role source decides who may close or delete it. Its
  `session_lifecycle` is `false`.
- The only `403` is the tenant filter's `actor_scope_mismatch`.

### 4.10 Upgrade

V17 turns every pending `ARCHIVE_SESSION` and `DELETE_SESSION` command into a
pending operation under its key and digest, with an empty actor digest and the
Session status the command recorded, and marks the command `MIGRATED`. The
worker finishes them. An archive admitted on an active Session first closes it,
as archive used to, and then leaves it `archived`. The migrated operation has
no actor, so a retry of the original key replays it only without a trusted
actor. With one, the retry is a new request and meets the open operation
(`409 session_operation_active`) or, once that completed, the new status.

Completed commands are not converted. A retry of one gets a new admission: a
repeated archive answers `409 session_state_conflict` and a repeated delete
`404`. A Session archived before the upgrade counts as closed.

Mixed-version rolling upgrades are not supported: stop every server of the
previous version before V17 runs. An archive or delete that an old server
leaves pending after the upgrade is never converted, and its pending command
blocks every later lifecycle change on that Session with
`409 session_operation_active`; an old server's unarchive would also reopen a
Session that D4 closed.

W0e (#12839) took V16 first, so this migration is V17, the next free version
on `main`. The O2 publication migrations follow as V18 and V19. An open pull
request that takes V17 or a later version must renumber past it; a gap left
instead would make Flyway refuse to start a database that already applied the
later version. Upgrade tests apply the ordered sequence before service
startup. Uniqueness across both migration locations is enforced without a
database by `scripts/check-flyway-migrations.js`, which runs in the SDK Java
workflow on every pull request and push (#12940).

## 5. Tests

- **Contract test.** The scenario archives an active Session (`409`), closes
  one while the Harness fails every close and reads it `closing` and `running`, probes
  delete during that close (`409`), lets the close complete, replays the key
  (same operation, `replayed: true`, `harness_confirmed`), archives, unarchives
  to `closed` and deletes. The WebShell side closes, queries, archives and
  deletes another Session. Every route gets its `400`, `403` and `404`, both
  operation reads reject an overlong operation id with `400`, the deleted
  Sessions' operations are read, and a new key on a tombstone answers `404`. The scenario exercises every operation that is not `planned`.
- **Lifecycle test.** Eleven scenarios: a close that waits while the Harness
  fails every close; a failed Harness close and repeated drain failures that
  must be retried before completion, with input rejected meanwhile; a Session
  that no Harness held, closed with and without a configured Harness; a
  Harness replaced by a restart, whose answer confirms nothing; a close that
  waits while another server's Harness holds the journal writer and completes
  as `java_durable` once that writer is sealed, and one that waits until an
  abandoned writer lease expires; a lost worker
  whose lease expires, after which another worker completes the operation;
  replay across the two surfaces and separate operations for another Session,
  kind or actor; one lifecycle change at a time against pending renames; a
  delete that drains only its own Session, after which another Session runs its
  first Turn; and bound Sessions.
- **Store test.** With a clock the test moves and no worker scanning, an
  operation is claimable only when due or when its lease expired, a worker's
  older claim can neither complete nor retry once the same worker claimed
  again, and a retry waits for its `available_at`. A key reused with another
  digest conflicts.
- **Migration test.** Pending archive and delete commands written at V15 become
  operations on H2, a retry of the archive key replays, and the worker finishes
  both.
- **MySQL test.** The same upgrade runs inside the existing upgrade test, and a
  new test admits, replays, claims, fences and completes operations on the real
  database and reads a journal writer as live until it is sealed or its lease
  expires by database time.
- **Hosted process test.** A second test in `HostedHarnessMySqlIT` runs Spring
  with the packaged Hosted Harness and MySQL. A Session's first Turn completes
  through the public API; the close completes as `harness_confirmed` only after
  the Harness sealed the Session's journal writer, and the delete then completes
  and leaves a tombstone.
- The integration test's lifecycle tests now close before archiving, and the
  WebShell types are regenerated.

## 6. Compatibility

- Archive and delete answer `202` with a command operation instead of `200`
  with the Session or `DeletedSession`, and they no longer send
  `X-Qwen-Idempotent-Replay`; the body's `replayed` replaces it.
- Archive requires a closed Session, so a client closes first. Unarchive
  restores `closed` instead of `active`.
- A key reused on another Session is a new request instead of
  `409 idempotency_conflict`, and a key reused by another actor is a new request
  instead of a replay of the first actor's result.
- New routes: close and the operation query on both surfaces, and archive and
  delete on the WebShell surface.
- New events: `session.close.requested` and `session.closed`. Archive no longer
  appends `session.archive.requested`, and the events of close, archive and
  delete carry their `operationId`.
- Public Sessions gain `capabilities.session_lifecycle`.
- The generated WebShell types add the lifecycle requests and operations.
- Flyway V17 adds a table and converts pending commands; no other row changes.

## 7. Validation

- The Managed Agent server's `mvn test` (151 tests) and Checkstyle pass.
- `ManagedAgentMySqlIT` passes against `mariadb:10.11.18`, the image CI uses,
  and against `mysql:8.4`, including the V17 upgrade. `HostedHarnessMySqlIT`
  passes against `mysql:8.4` with the bundled CLI.
- On this branch, focused H2 migration and publication tests pass 24/24. On a
  fresh MySQL 8.4 schema, `ManagedAgentMySqlIT` passes 11/11 with V16–V19
  applied in order. MariaDB verification of the combined sequence awaits CI.
- The Web Shell managed component tests (73), including the generated-types
  freshness test, and its typecheck pass.
- Each of 27 mutations fails a test: not sealing the Session at admission;
  skipping the Harness close or the Runtime drain; skipping the close of a held
  Session on a server without a Harness, or of a delete on an active Session;
  completing while a journal writer still holds the Session, or treating an
  expired writer lease as live;
  completing without checking the claim generation; keeping the lease after a
  failed attempt; a scan that ignores expired leases; replaying across actors or
  kinds; archiving an active Session; closing with an active Turn; admitting on
  a tombstone; hiding a tombstone's operations; accepting an overlong operation
  id on the public route; ignoring pending commands or
  open operations; advertising lifecycle on a bound Session; confirming every
  completion, any answer, or the answer of a replaced Harness; unarchive
  reopening the Session; V17 leaving commands pending or converting finished
  ones; and new digest names. Skipping the Harness close also fails the Hosted
  process test.

## 8. Follow-up

- Roles (Q4) and, with them, lifecycle operations on Workspace-bound Sessions
  and the `403` for a reader that may not operate.
- `archived_at` and `include_archived`.
- Purging tombstones and operations after the retry window, erasing a deleted
  Session's content, and a `recovery_blocked` outcome for an operation that
  cannot proceed.
- D7 adding its input and cancel operations to the same table and route.
- Reconnecting to a restarted Hosted Harness without restarting Java, which
  Turn dispatch needs as well.
- Letting a Harness whose journal writes stopped after a failure still seal its
  writer and release the Session, so that a close can settle it (4.5).
- Leases on database time with renewal, as section 1 of the contract closure
  asks for durable delivery.
- The WebShell `sessionLifecycle` capability once the WebShell capability
  object is implemented.

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[closure]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.md
