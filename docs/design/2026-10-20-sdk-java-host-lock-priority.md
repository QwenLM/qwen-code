# SDK Java host lock: serve the fast tier first

[English](2026-10-20-sdk-java-host-lock-priority.md) | [简体中文](2026-10-20-sdk-java-host-lock-priority.zh-CN.md)

## Problem

`.github/workflows/sdk-java.yml` serializes every self-hosted Maven step on one
file, `~/.cache/qwen-code-ci/sdk-java-tests.lock`, via `flock --wait`.
`flock(2)` does not order its wakeups, so under continuous arrivals one waiter
can lose every release and starve to its budget. A fast-tier pull-request job
is the smallest participant: on 2026-10-20 run 39431579628's
`SDK Java (fast) / ubuntu-latest / Java 21` job waited the full 5400 s behind
full-tier holds and failed before Maven started, so no test result was
reported (#14962). Raising the budget 2400 → 3600 → 5400 s only moved the
cliff.

## Goals and non-goals

- Goal: a fast-tier PR job waits at most the hold already running, not a queue
  of full-tier holds.
- Goal: keep the release semantics (the lock stays on fd 9 for the step and
  releases at the step boundary), the pinned `lock not acquired within`
  signature, and the 5400 s budget.
- Non-goal: moving the lane off the ECS pool. The fast tier stays self-hosted;
  the hosted-runner direction was withdrawn (#14935).
- Non-goal: reducing total occupancy. Sharding the lock, capping registrations
  per host, and adding hosts are orthogonal follow-ups.

## Design

A sourced helper, `.github/scripts/sdk-java-lock.sh`, replaces the inline
`exec 9>lock; flock --wait` block at both self-hosted acquisition sites.

- Each acquirer takes a sequence number from a counter protected by a
  counter-lock directory, then writes `rank.sequence.pid.ticket` into
  `<lock>.queue/`.
- Only the oldest live ticket tries the lock. The head blocks in the kernel
  wake race in five-second slices, so the budget stays sharp and the head
  competes on even terms with any legacy inline `flock --wait` waiter still
  running from an older branch.
- `fast` tickets sort before `normal` tickets. The test job passes its `TIER`,
  so a `pull_request` run enters the fast class while approval and main
  full-tier work stays normal.
- A normal ticket that waits past `SDK_JAVA_LOCK_PROMOTE_AFTER` (default
  1200 s) is renamed into the fast class, so continuous PR traffic cannot
  starve the full tier.
- Tickets carry their owner's PID. A dead owner's ticket is reaped by the next
  head-of-line check once it is older than ten seconds; live waiters touch
  their ticket every loop.
- On success the traps drop the ticket and the lock stays held on fd 9. On
  timeout the helper removes its ticket, prints the pinned
  `sdk-java host lock not acquired within N minutes as queue ticket S`
  line, and returns 1.

## Validation plan

- `scripts/tests/sdk-java-lock.test.js` pins FIFO ordering, fast before an
  older normal ticket, aging promotion, stale-owner reaping, and the timeout
  signature with ticket cleanup. `flock` is stubbed on `PATH`; the shell runs
  with `-eo pipefail` like a workflow step.
- `scripts/tests/sdk-java-workflow.test.js` pins the sourced helper at both
  self-hosted sites, the 5400 s budget, and the fast tier's `TIER` argument.
- The workflow-size ratchet covers the workflow file; the helper keeps the
  inline blocks out of the workflow.

## Acceptance criteria

- Both self-hosted lock sites source the helper and acquire at 5400 s.
- The test job passes `TIER`; the MariaDB lane defaults to the normal class.
- The focused Vitest files above pass.

## Risks and open questions

- Mixed fleet: legacy inline waiters still race the head, so ordering is
  guaranteed only among runs that use the helper. Once this merges, new runs
  do, and the residual is the pre-existing #14743 condition.
- A continuous stream of fast tickets delays normal work by at most one
  promotion interval; the aging boundary is the knob if that proves too long.
- A dead waiter whose PID is recycled by a long-lived process keeps its ticket
  until that process exits. This is the same worst case as today.
