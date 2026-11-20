# JSONL tail diagnostics: bounded recovery, eviction policy, and lifecycle witnesses

[English](./jsonl-tail-diagnostics-17852.md) | [简体中文](./jsonl-tail-diagnostics-17852.zh-CN.md)

**Status: implemented in this change, pending review.** This is the follow-up to
the merged append-integrity fix #17771 and resolves items 1–3 of tracker #17852.
Item 4 (native Windows and current-head macOS validation) is **not** resolved
here; see [Scope boundaries](#scope-boundaries).

## Problem statement

`writeLine` / `writeLineSync` in `packages/core/src/utils/jsonl-utils.ts` append
safely when a regular file's tail cannot be inspected, and report that fallback
through a rate-limited debug warning. The correctness fix landed in #17771. Three
diagnostic and coverage gaps remained, and were deferred to #17852:

1. **A repaired sink stays silent.** `reportUninspectableTail` gives each
   `(filePath, debugLogPath)` key three delivery attempts. Once the third attempt
   fails, the key is suppressed for as long as it stays cached. Repairing the
   debug sink cannot produce another attempt, so the operator loses the
   diagnostic exactly when it would start working again.
2. **Cache churn re-warns without a policy.** The diagnostic map holds at most
   `MAX_DIAGNOSED_TAIL_READ_FAILURES = 128` keys and evicts the oldest key to
   admit a new one. Evicting a key whose warning was already delivered discards
   its suppression, so a long sequence of distinct paths warns again on every
   pass. Separately, a fatal tail-inspection error raised from a descriptor-based
   operation (`FileHandle.read`, `FileHandle.stat`, `fstatSync`) carries no file
   path, because Node only attaches `path` to pathname-based syscalls.
3. **Lifecycle and delivery witnesses are incomplete.** The explicit writer
   `sync()` / `close()` path, the stale-completion guard, the FIFO writer-handle
   target, and a failed debug append combined with a throwing delivery observer
   have no focused assertion.

### Confirmed baseline

Both behavioral gaps were reproduced against unmodified `main` at
`1176e39bbc036d60c6754ae5976bf2703001b43c` (the #17853 ledger commit), on Linux
x86-64 with Node `v26.12.1`, using a source-level probe
(`.qwen/scripts/17852/repro-baseline.ts`, local working artifact) that denies the
`O_RDONLY | O_NONBLOCK` tail probe with `EACCES`:

| Scenario             | Trigger                                                                                                                                    | Observed before this change                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Cache churn          | 140 distinct torn paths, 2 append rounds, healthy sink                                                                                     | **280 appends → 280 warnings**                                                                                                        |
| Outage then recovery | one path, runtime dir replaced by a regular file, 6 appends, then the dir is restored and a marker proves the sink healthy, then 4 appends | **0 warnings during outage, 0 after recovery**; `isDebugLoggingDegraded()` true; all 10 records appended with conservative separators |

The churn result independently confirms the example quoted in #17852, which the
tracker explicitly listed as an unconfirmed lead. The recovery result confirms
that sink repair alone does not re-enable delivery. Neither scenario lost or
rewrote existing bytes: the append path stayed correct throughout.

## Goals

- Let a repaired sink deliver the tail diagnostic again, without a warning flood
  and without new side effects when logging is disabled.
- Give the 128-key bound a coherent, documented interaction with per-target
  suppression, so churn cannot turn into an unbounded warning stream.
- Make a fatal tail-inspection error name the file it failed on, without changing
  the error's identity, code, or append outcome.
- Add focused witnesses for the writer lifecycle and delivery separation, each
  paired with a control or mutation that shows what the guard buys.

## Non-goals

See [Scope boundaries](#scope-boundaries).

## Proposed changes

### 1. Bounded retry cooldown after the delivery budget is exhausted

`TailDiagnosticEntry` gains one field, `retryAfter: number` (epoch milliseconds,
`0` while the initial budget is still being spent).

- Attempts 1–3 behave exactly as today: one attempt per append until a delivery
  succeeds (`retained`) or the budget is spent.
- When an attempt brings `attempts` to `MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS`,
  the entry arms `retryAfter = Date.now() + TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS`.
- A later call for an exhausted key is suppressed while `Date.now() < retryAfter`.
  Once the window has elapsed, **exactly one** probe attempt is admitted: the
  entry keeps `attempts` at the cap, re-arms `retryAfter` for a full window, and
  marks itself `pending`. A successful delivery sets `retained` and ends all
  further attempts for that key; a failure leaves the key suppressed for another
  full window.

`TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS = 60_000` matches the existing
`TOKEN_USAGE_FAILURE_LOG_COOLDOWN_MS` precedent in
`packages/core/src/services/tokenUsageService.ts`, so the codebase keeps one
cooldown magnitude for best-effort local write diagnostics.

The attempt counter is never cleared. This is the design constraint recorded in
the #17853 ledger: a bare reset after the cap would re-open an unbounded retry
loop against a permanently broken sink.

### 2. Eviction reclaims only failed-delivery slots

Admission when the map is full changes from "delete the oldest key" to:

- delete the oldest key whose delivery has **settled and failed** (neither
  `retained` nor `pending`), then admit the new key;
- if no such slot exists, **do not evict and do not admit**. The append still
  proceeds with its conservative separator; only the diagnostic is skipped.

A `retained` slot owns a delivered suppression and a `pending` slot owns an
in-flight one. Protecting both makes the bound independent of delivery timing: a
burst that admits 129 distinct paths before any delivery settles still produces
at most 128 warnings. Protecting only `retained` was measured to be insufficient —
a synchronous burst evicted in-flight entries and still produced 129 warnings for
129 paths.

Resulting invariant: at most 128 keys hold a suppression at once, and a slot is
reclaimed only after its delivery failed, so no warning that landed — or is about
to land — loses its suppression. Under the confirmed churn scenario the warning
count drops from 280 to 128, and a second pass over the same paths adds none.

A reclaimed slot loses its cooldown state too: if the same key is admitted again
later it starts a fresh three-attempt budget. That is deliberate — the slot was
reclaimed precisely because its delivery failed, and a broken sink under churn
still lands no warnings. It is unchanged from the pre-existing eviction behavior.

Because an in-flight entry is no longer evictable, the stale-completion guard is
now defense in depth rather than a reachable production race. Its witness drives
`_resetEnsuredDirsCacheForTest()`, the remaining way an entry can be replaced while
its delivery is in flight.

Measured caveat: deleting that guard line alone does **not** change observable
behavior. The delivery callback closes over its own `entry` object, so a stale
completion mutates an orphaned object that the map no longer holds. The witness
therefore pins the isolation property, and its sharp mutation replaces the
closed-over write with a write to whatever the map holds now — that variant fails
the witness. The guard is kept as an explicit statement of the invariant, not as
the mechanism that enforces it.

### 3. File context on a fatal tail-inspection error

When `canAppendWithoutTailInspection` returns false, the catch block rethrows the
original error after appending ` (file: <filePath>)` to its message, and only when
the message does not already contain that path. Pathname-based Node errors already
name the file and are left untouched.

The annotation also covers the `ENOENT` recovery branch. Its own `open` and
descriptor `stat` run _inside_ the catch, so a failure there would otherwise
escape unannotated — unlike the non-regular branch, whose `stat` runs in the try
and therefore lands in the catch. Both appenders wrap the recovery block and
rethrow through the same helper.

The error object is annotated in place rather than wrapped: callers match on the
original object and its `code` (for example `chatRecordingService` stores the
error as its sticky write failure, and `tokenUsageService` logs `error.message`
and rate-limits by `code`). Wrapping would change identity and could drop the
`code` those consumers read. The substantive message stays a verbatim prefix, the
stack is untouched, and the append outcome is unchanged — the error still
propagates and no fallback append happens.

### 4. Lifecycle and delivery witnesses

New focused tests, collocated with the existing suites:

- **Explicit writer lifecycle.** For an `ENOENT`-created file and for a
  non-regular path, the async append receives the opened `FileHandle` (not the
  pathname), calls `sync()` on it, and closes it. A rejected `sync()` propagates
  and still closes the handle; a healthy readable regular file keeps
  `openAppender === undefined`, so no extra `sync()`/`close()` runs. The sync
  variant asserts the same through its descriptor.
- **Stale completion.** A pending entry is orphaned by the test-only cache reset,
  the key is re-admitted, and the orphaned delivery then fails. The newer entry
  must stay `pending` and must not be marked retained; its own delivery produces
  exactly one warning.
- **FIFO writer target.** The append argument is the handle opened with `'a'`,
  and that handle is closed after a failed append. Probe absence stays pinned by
  the existing `does not open a FIFO just to inspect its tail` witness, not by
  this one.
- **Failed append plus throwing observer.** `fs.appendFile` rejects and the
  delivery observer throws: `isDebugLoggingDegraded()` stays true, delivery is
  reported `false` exactly once, and the observer's exception does not escape.
  The existing converse control (successful append, throwing observer, degraded
  stays false) is kept.
- **Cooldown and eviction policy.** Outage → recovery at the same path delivers
  exactly one warning after the window elapses; an unrecovered sink admits at
  most one attempt per window; a full cache of delivered entries admits no new
  key; a cache of failed entries still evicts to admit one.

## Design decisions and rationale

| Decision                                                                    | Rationale                                                                                                                              | Alternative rejected                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One probe attempt per cooldown window after exhaustion, counter never reset | Bounds a broken sink to one attempt per minute per key while still letting a repaired sink speak                                       | Clearing `attempts` after the cap (unbounded retry loop); a permanent suppression (the confirmed item-1 gap)                                                                                                                                             |
| `60_000` ms cooldown                                                        | Same magnitude as the existing token-usage write-failure cooldown; one precedent, no new tuning surface                                | A new arbitrary interval                                                                                                                                                                                                                                 |
| Reclaim only settled-failed slots; skip admission when none exists          | Keeps the memory bound and every suppression — delivered or in flight — with no new state and no timer, independent of delivery timing | Protecting only `retained` (measured insufficient: a synchronous burst still re-warned); a second per-sink aggregate budget (two mechanisms, another bound to tune); never evicting at all (a broken sink would permanently block all later diagnostics) |
| Annotate the original error message in place                                | Preserves identity, `code`, and stack for consumers that match on them; pathname errors already carry the path                         | Wrapping with `cause` (changes identity, risks losing `code`); adding only a `path` property (consumers print `message`, so the context would stay invisible)                                                                                            |
| Keep the legacy-logger fallback at-most-once                                | A logger without `warnWithDelivery` cannot report delivery, so a cooldown would have no signal to act on                               | Applying the cooldown to legacy loggers                                                                                                                                                                                                                  |

## Files affected

| File                                                        | Change                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/utils/jsonl-utils.ts`                    | `retryAfter` field and cooldown constant; eviction rule; fatal-error file context                                                                                        |
| `packages/core/src/utils/jsonl-utils.test.ts`               | Cooldown, eviction-policy, stale-completion, writer-lifecycle, FIFO-target, and error-context witnesses; the previous eviction expectation is replaced by the new policy |
| `packages/core/src/utils/debugLogger.test.ts`               | Failed append plus throwing observer witness                                                                                                                             |
| `docs/design/jsonl-tail-diagnostics-17852.md` / `.zh-CN.md` | This design                                                                                                                                                              |

No public API, config key, CLI flag, or on-disk record format changes.

## Constraints

- Logging-disabled and session-suppressed paths must not resolve a debug session.
  The existing gate in `canAppendWithoutTailInspection` stays ahead of
  `getActiveDebugSessionLogPath()`, and the cooldown adds no lookup.
- Ordinary new, empty, newline-terminated, and torn regular files keep their
  expected bytes. Genuine append, `fsync`, and close failures keep propagating.
- The diagnostic map stays bounded at 128 keys; the cooldown adds one number per
  entry and no new collection.
- A throwing delivery observer is never treated as a filesystem append failure,
  and a failed append is never reported as delivered.

## Risks

- **Behavior change to an asserted contract.** The existing test
  `warns again for an evicted path after exceeding the cache bound` encodes the
  old re-warn behavior. It is replaced, not weakened: the new test asserts exact
  warning counts under the new policy, and a separate test keeps eviction
  observable for undelivered entries.
- **Diagnostics stop for late paths.** Once 128 keys hold suppressions, a
  genuinely new uninspectable path is not diagnosed until a slot's delivery
  fails. This is only reachable when at least 128 distinct files have unreadable
  tails, which is already pathological; the append itself is unaffected. The
  trade-off is deliberate and documented above.
- **A defensive guard.** The stale-completion guard is no longer reachable
  through eviction. It is kept, and pinned by a witness, because dropping it
  would silently reintroduce the race if eviction ever reclaims an in-flight slot
  again.
- **Clock dependence.** The cooldown reads `Date.now()`. Tests drive it with
  fake timers instead of sleeping, so they stay deterministic.

## Validation plan

- Focused suites from `packages/core`:
  `npx vitest run src/utils/jsonl-utils.test.ts src/utils/debugLogger.test.ts`.
- Root `npm run build`, `npm run typecheck`, `npm run bundle`.
- Mutation witnesses, each restored afterwards: remove the cooldown gate, restore
  unconditional oldest-key eviction, remove the stale-completion guard, remove
  the error-context annotation, and reset the attempt counter after the cap. Each
  must fail a named test.
- Re-run the baseline probe against the changed source: churn must report 128
  warnings for 280 appends, and outage-then-recovery must report one warning
  after the cooldown window.
- Native Linux re-check of the writer lifecycle at the final head (FIFO target
  and descriptor cleanup), reporting the actual OS, Node version, appender mode,
  payload bytes, and native append outcome.

## Acceptance criteria

- A repaired sink delivers exactly one tail warning for a previously exhausted
  key after the cooldown window; an unrecovered sink admits at most one attempt
  per window; the attempt counter is never reset.
- 140 distinct paths over 280 appends produce at most 128 warnings, and a second
  pass produces none. The bound holds for a burst with no delivery settled in
  between, not only for a paced one. Eviction of failed-delivery slots remains
  observable.
- A fatal descriptor-based tail error names its file, keeps its original code and
  identity, and still propagates without a fallback append.
- Every new witness checks bytes, descriptor lifecycle, or delivery outcome — not
  merely resolve/reject — and each guard has a mutation or control that fails
  without it.
- Logging-disabled and healthy-sink controls acquire no new side effects.

## Scope boundaries

Item 4 of #17852 is **not** delivered here. Native Windows sharing-violation
behavior and current-head macOS behavior require hosts this change was not run
on. The earlier macOS evidence at `14893f6f10` predates the #17771 writer-handle
lifecycle and is not reused as validation. Skipped CI jobs are not presented as
native-platform certification. Linux native results in this change are labeled
with their actual OS and Node version and are not generalized to other platforms.

Also out of scope, as in #17852: a universal cross-process append lock, arbitrary
pathname-replacement atomicity, generic FIFO transcript support, reconstruction
of missing historical JSON bytes, daemon upgrade/restart, and reader-side salvage
of already-damaged history (#17756). Merging the tail probe and the append onto a
single handle remains an independent performance change.

## Open questions

- Whether the 128-key delivered-suppression budget should ever expire in a
  long-lived daemon. This change keeps it for the process lifetime because the
  condition is pathological and the append path is unaffected; revisiting it
  needs evidence of a real workload that hits the bound.

## References

- Tracker: [#17852](https://github.com/QwenLM/qwen-code/issues/17852).
- Merged parent: [#17771](https://github.com/QwenLM/qwen-code/pull/17771), squash
  `f8fa7c476f2244d5c6832fb2bb9a551882c425b3`.
- Post-merge ledger: [#17853](https://github.com/QwenLM/qwen-code/pull/17853),
  [jsonl-append-verification-17771.md](./jsonl-append-verification-17771.md).
- Independent read-side work: [#17756](https://github.com/QwenLM/qwen-code/issues/17756).
