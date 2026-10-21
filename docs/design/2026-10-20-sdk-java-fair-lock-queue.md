# SDK Java per-host lock: a FIFO ticket queue

[English](2026-10-20-sdk-java-fair-lock-queue.md) | [简体中文](2026-10-20-sdk-java-fair-lock-queue.zh-CN.md)

## Problem

`.github/workflows/sdk-java.yml` serializes every self-hosted Maven step on one
file, `~/.cache/qwen-code-ci/sdk-java-tests.lock`, via `flock --wait`. On
2026-10-18/19 and 2026-10-20 the shared ECS pool starved repeatedly: jobs
waited the full 2400 s, then 3600 s, then 5400 s budget and failed before
executing a test, on at least three physical hosts at once (#14566, #14743).

`flock(2)` does not queue waiters. A release wakes every sleeping waiter and
the kernel wakes them with no ordering, so under continuous arrivals one
waiter can lose every release and starve without bound. A wait budget bounds
one attempt, not the wait: raising 2400 → 3600 → 5400 s only lowers the
failure probability. At least three hosts each run several runner
registrations against the same lock, so demand scales with arrival while
capacity is one hold at a time — no constant budget bounds the queue.

## Goals and non-goals

- Goal: make the wait deterministic. A waiter's worst-case wait is the work
  ahead of it in line, not a wake-up race.
- Goal: preserve the current semantics elsewhere. The lock still releases
  automatically at the step boundary; the pinned infrastructure-signature
  error text (`lock not acquired within`) stays so the rerun classifier in
  `qwen-autofix.yml` is untouched.
- Non-goal: reducing total occupancy. Sharding the lock by suite, capping
  registrations per host, or adding hosts are orthogonal and can follow;
  fairness makes their remaining work measurable instead of urgent.
- Non-goal: changing the 5400 s budget or the 150/280-minute job ceilings.

## Design

### Ticketed queue around the existing lock

A new sourced helper, `.github/scripts/sdk-java-lock.sh`, replaces the inline
`exec 9>lock; flock --wait` block at both acquisition sites.

- Tickets live in `<lock>.queue/`. Each acquirer takes the next sequence
  number from a counter file whose read-increment-write runs under `flock`
  on fd 8, and publishes its own ticket before that lock is released, so a
  later ticket can never be visible while an earlier one is not.
- Only the holder of the smallest live sequence number tries the lock —
  with a single blocking `flock --wait` for the remaining budget. The fleet
  is mixed: main and older branches still run the raw `flock --wait`, and a
  head that re-enters the kernel wait queue in slices loses every release
  to waiters that stayed blocked. Entering once keeps its arrival position.
- Tickets carry their owner's PID. A cancelled or killed step leaves an
  orphaned ticket; the next head-of-line check reaps a ticket whose owner
  PID is dead and whose mtime is older than 10 seconds, and also one whose
  mtime is older than 1800 seconds even if that PID was recycled to a live
  process. A live waiter touches its ticket every loop, so a stale mtime
  means the owner is gone and an untouched head cannot wedge an idle lock.
- On success the ticket is removed immediately: a holder needs no place in
  line once the kernel holds the lock, and a trap cannot see the helper's
  local after `return`. The lock stays on fd 9 in the step shell, so it
  still releases automatically at the step boundary — the helper changes
  acquisition order, not release semantics.
- On timeout the helper prints
  `::error::sdk-java host lock not acquired within N minutes as queue ticket S`
  and returns 1, keeping the existing error-message contract.
- Wait observability: the helper prints its ticket number and the remaining
  budget on the first wait and at most once a minute after, which makes a
  hang attributable from the log instead of silent.
- Failing closed is worse than falling back here: `release-sdk-java.yml`
  resumes an existing tag by checking out that immutable commit, which may
  predate the helper. Both sites therefore fall back to the bare
  `flock --wait 5400 9` lock they replaced when the helper file is absent,
  rather than dying before Maven and wedging the release permanently.

### Why fairness over the alternatives

- Shard the lock by suite: reduces queue frequency but each shard is still a
  bare flock, and it rides on an untested assumption that concurrent suites
  share the host safely on a pool that just OOMed a build.
- Cap registrations per host: needs pool topology changes outside the repo
  and leaves the same unbounded wake race per host.
- Second host: at least three hosts starved simultaneously; host count is
  proven not to be the binding constraint.

### Residual failure modes, accepted deliberately

- A dead waiter whose PID is recycled by a long-lived process keeps its
  ticket until that process exits; waiters behind it still time out at the
  existing budget. This is the same worst case as today, not a new one.
- The counter-lock aging is a one-minute worst case for a pathological
  kill-inside-critical-section; it costs one lost minute in a fetch-sized
  budget.

## Validation plan

- Unit behavior of the helper is pinned by
  `scripts/tests/sdk-java-lock.test.js` (POSIX-only): FIFO ordering across
  two waiters, stale-owner reaping, timeout signature and ticket cleanup,
  with `flock` stubbed on `PATH`.
- The workflow pins move with the mechanism:
  `scripts/tests/sdk-java-workflow.test.js` now pins the sourced helper and
  the `sdk_java_lock_acquire 5400` budget at each acquisition site, and the
  `.size-baseline` records the workflow's new size.
- Real-host soak is CI itself: the first pool runs after merge either
  acquire in ticket order or time out with an attributable ticket number.

## Acceptance criteria

- All three lock sites in `sdk-java.yml` acquire through the helper at 5400 s.
- `npx vitest run scripts/tests/sdk-java-lock.test.js
scripts/tests/sdk-java-workflow.test.js scripts/tests/workflow-size.test.js`
  passes.
- The error text still contains the substring `lock not acquired within`,
  so `qwen-autofix.yml`'s `INFRA_FAILURE_SIGNATURES` keeps matching.

## Open questions

- Whether queue depth should be published as a metric; the minute-capped wait
  line is the minimal observability landed here.
