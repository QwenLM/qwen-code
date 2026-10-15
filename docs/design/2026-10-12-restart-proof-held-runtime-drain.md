# Restart-proof the held-Runtime drain (#13930 R1-2)

Status: design. English and [中文](2026-10-12-restart-proof-held-runtime-drain.zh-CN.md).

## 1. The problem

A background run outlives its turn by design: the turn's routine release is
refused `runtime_session_held`, and the turn settles clean while the run keeps
its Runtime. The Session's close owes that Runtime a drain — and it tracks the
obligation only in the process-local `heldRuntimeTurns` set.

Now restart the Harness (or take the Session over on a replacement). The
reloaded Session constructs `heldRuntimeTurns: new Set()` and nothing
repopulates it: its `DELETE` walks an empty set, answers 204, and the run is
still alive on the worker. The Runtime and its workspace mount stay pinned —
silently, because nothing records the strand — until the workspace-level
`drainHarnessSession` cascade runs, possibly much later.

What a user faces without this: a background task they asked to keep running
is fine, but a _Session they closed_ still pins a Runtime and a mount, and
nothing anywhere says so.

The constraint that shapes the fix: the obligation must be **restored** at
load, never **discharged** there. An eager drain-release on load would stop a
run the live Session still wants.

## 2. The design decision and the fault it dodges

**Restore the held set from the Broker's durable hold rows, at Session load.**

The Broker is the source of truth for what is actually held: it keeps a
non-terminal hold row per live background run, and each row already carries
the `harnessSessionId` and the `runtimeSessionId`. So instead of persisting a
new marker or widening the record contract, a reload asks the Broker which of
this Session's Runtime Sessions are still held, and seeds `heldRuntimeTurns`
from the answer. The close drains them exactly as today.

This dodges three specific faults:

- **The silent pin (R1-2).** Without it, a restarted Harness's close answers
  204 over a live run and nothing records the strand.
- **The over-eager stop.** Restoring (not discharging) at load means a live
  Session that re-opens keeps its run; only the close drains.
- **The record-contract surgery.** The `child_run`/`monitor_run` bodies carry
  no runtime-session linkage, and they are closed-key (exact-key-count)
  validators shared by the TS and Java sides. Adding a field there would touch
  both validators plus the fixtures; the read-only Broker query touches
  neither.

## 3. Mechanism (reference)

### Broker (Java, `runtime-broker`)

- A read-only service method `listActiveHoldRuntimeSessionIds(harnessSessionId)`:
  the runtime Session ids of this Harness Session still owed the close's
  drain. The hold rows are execution records with a `background_v3_*`
  dispatch mode; a row counts while its Runtime Session's release is not
  durably recorded — a terminal hold row (the run exited, the watch
  stopped) discharges nothing on its own (#13986 review).
- One repository query `findHoldRowsByHarnessSession` on
  `ToolExecutionRepository` (InMemory + Jdbc + a `JdbcRepositoryContract`
  parity pin), since the rows carry `harnessSessionId` directly; the
  release-state filter lives in the service, over `RuntimeSessionRecord`,
  and the exact Harness identity is re-checked in Java because the
  column's collation may compare case-insensitively (#13986 review).
- One read-only route. It answers from durable rows, so it works after a
  Broker restart too.

### Harness (CLI, `hosted-harness-session.ts`)

- One client method that calls the route for this Session's harness id.
- At Session load (reopen of an existing Session), call it and seed
  `heldRuntimeTurns` with the returned ids — restore, never discharge. A fresh
  create has no hold rows, so the set stays empty. A load whose query fails
  logs and loads without the obligation (no worse than today).

### Close

The close drains `heldRuntimeTurns` with `release({ drain: true })`,
tolerating the precise 404 and parking honestly on anything unproven. One
tolerance widened on review (#13986 R2-1): a Broker that restarted beside the
Harness cannot prove the release and answers its declared-retryable 503
`runtime_reconciliation_required`, leaving the Runtime to the Workspace-level
cascade. The close tolerates that answer too — otherwise the Session could
never be retired — while the unproven drain keeps the monitor loops on a
`runtime_lost` settle, never `stop_requested`.

## 4. Acceptance

A takeover case beside `drains a turn-held Runtime at close through the drain
arm (#13856)` in `hosted-harness-session.test.ts`: a Session prewritten and
closed without ever draining (the dead process), its held Runtime Session
still listed by the Broker, is loaded by a fresh process and DELETEd there;
the replacement's `release` must go out with `[{ drain: true }]` for the held
Runtime Session id. Without the load-time restore, that assertion is red.

The test prewrites the journal instead of running the held turn on a live
original first: the writer lease refuses a second in-process open of a live
Session, so a two-process shape cannot run in one test process — and it need
not, because the restore trusts the Broker's durable hold rows, not the
journal's turn records. The routine-refusal → hold → close-drain half is the
#13856 cases' coverage, beside this one.

## 5. Boundaries

- The direct Harness API path only. The control-plane Session close has its
  own `drainHarnessSession` backstop and is out of scope.
- A lifecycle-v2 Session's direct close never runs the drain block, so its
  load skips the restore entirely — the set's only reader sits in the v1-only
  close block (#13986 review).
- The 28 deferred Suggestions from the review wave are a separate hygiene
  batch (#13930 tracks them); this slice is R1-2 alone.
