# SDK Java host lock: serve the fast tier first

[English](2026-10-20-sdk-java-host-lock-priority.md) | [简体中文](2026-10-20-sdk-java-host-lock-priority.zh-CN.md)

## Problem

`.github/workflows/sdk-java.yml` serializes every self-hosted Maven step on one
per-host file, `~/.cache/qwen-code-ci/sdk-java-tests.lock`. The FIFO ticket
queue added for #14743 (see
[the queue design](2026-10-20-sdk-java-fair-lock-queue.md)) bounds each waiter
by its position, but a fast-tier pull-request job still enters at the back: on
2026-10-20 run 39431579628's `SDK Java (fast) / ubuntu-latest / Java 21`
waited the full 5400 s behind full-tier holds and failed before Maven
started, so no test result was reported (#14962).

## Goals and non-goals

- Goal: a fast-tier PR ticket is served before every waiting normal ticket,
  so it waits at most the hold already running plus the one normal head
  already blocked in the kernel, not the full-tier queue behind it.
- Goal: keep the FIFO queue's release semantics (the lock stays on fd 9 for
  the step and releases at the step boundary), the pinned
  `lock not acquired within` signature, and the 5400 s budget.
- Non-goal: preempting a normal ticket already blocked in `flock(2)`. The
  kernel wake order is not ours to control, which is why the fast bound is
  two holds rather than one.
- Non-goal: sharding the lock by tier. The FIFO design records it as the
  alternative; it would allow two concurrent Maven runs per host.

## Design

The fast class is layered on the FIFO helper in
`.github/scripts/sdk-java-lock.sh`; the queue, counter, head probe, release
and reaping mechanics stay those of the FIFO design.

- Tickets are named `rank-sequence-pid`. `fast` is rank 0 and `normal` is
  rank 1; the head is the smallest live name, so every fast ticket precedes
  every normal ticket taken before or after it. The test job passes its
  `TIER`, so a `pull_request` run enters the fast class while approval and
  main full-tier work stays normal.
- A normal ticket that waits past `SDK_JAVA_LOCK_PROMOTE_AFTER` (default
  1200 s) is renamed into the fast class. It keeps its sequence, so it
  precedes fast tickets that arrived after it, and continuous PR traffic
  cannot starve the full tier.
- The head blocks in one `flock --wait` for its remaining budget, as in the
  FIFO design. A fast ticket that arrives while a normal ticket is already
  blocked therefore cannot take that ticket's place in the kernel wait; it
  is served after the running hold and that head's hold.
- Tickets carry their owner's PID and the owner's `/proc/<pid>/stat` start
  time (field 22). The next head-of-line check reaps a ticket whose owner is
  dead after a ten-second mtime grace, and also one whose PID is alive but
  whose start time differs — a recycled PID. A ticket with no recorded start
  time (a pre-upgrade file, or a host without `/proc`) falls back to the
  FIFO design's 1800-second mtime backstop.
- On success the ticket is removed and the lock stays held on fd 9. On
  timeout the helper removes its ticket, prints the pinned
  `sdk-java host lock not acquired within N minutes as queue ticket S`
  line, and returns 1.

## Validation plan

- `scripts/tests/sdk-java-lock.test.js` pins FIFO ordering, fast before an
  older normal ticket, aging promotion, dead-owner reaping (including a
  recycled PID), the timeout signature with ticket cleanup, and the
  blocking-head diagnostic. `flock` is stubbed on `PATH`; the shell runs
  with `-eo pipefail` like a workflow step.
- `scripts/tests/sdk-java-workflow.test.js` pins the sourced helper at both
  self-hosted sites, the 5400 s budget, the bare-lock fallback for resumed
  release tags, and the fast tier's `TIER` argument.
- The workflow-size ratchet covers the workflow file; the helper keeps the
  inline blocks out of the workflow.

## Acceptance criteria

- Both self-hosted lock sites source the helper and acquire at 5400 s.
- The test job passes `TIER`; the MariaDB lane defaults to the normal class.
- The focused Vitest files above pass.

## Risks and open questions

- Fast priority is two holds, not one: a normal head already blocked in the
  kernel wins the release ahead of a newly arrived fast ticket. The measured
  bound is about 2 × 925 s, well inside the 5400 s budget.
- Mixed fleet: legacy inline waiters are not in the queue, so a fast ticket
  can still lose a release to one. The bound applies among runs that use the
  helper; after the fleet is uniform the residual is the pre-existing
  #14743 condition.
- A continuous stream of fast tickets delays normal work by at most one
  promotion interval; the aging boundary is the knob if that proves too long.
- A SIGKILLed waiter leaves its ticket until the next head-of-line check
  reaps it: within the ten-second grace when the start time identifies a
  recycled PID, or the 1800-second backstop otherwise.
