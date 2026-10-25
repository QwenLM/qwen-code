# SDK Java per-host lock: a FIFO ticket queue

[English](2026-10-20-sdk-java-fair-lock-queue.md) | [简体中文](2026-10-20-sdk-java-fair-lock-queue.zh-CN.md)

## Problem

`.github/workflows/sdk-java.yml` serializes every self-hosted Maven step on one
file, `~/.cache/qwen-code-ci/sdk-java-tests.lock`, via `flock --wait`. On
2026-10-18/19 and 2026-10-20 the shared ECS pool starved repeatedly: jobs
waited the full 2400 s, then 3600 s, then 5400 s budget and failed before
executing a test, on at least three physical hosts at once (#14566, #14743).

`flock(2)` makes no promise about the order in which blocked waiters are
granted the lock, and the order measured on Linux is insertion order: a
waiter keeps its place only while it stays blocked in one call. Re-entering
the queue — a second acquisition in a later step, a poll, or a wait cut into
slices — puts it behind every waiter that stayed resident, and under
continuous arrivals that can repeat without bound. A wait budget bounds one
attempt, not the wait: raising 2400 → 3600 → 5400 s only lowers the failure
probability. At least three hosts each run several runner registrations
against the same lock, so demand scales with arrival while capacity is one
hold at a time — no constant budget bounds the queue.

## Goals and non-goals

- Goal: make the wait deterministic. A waiter's worst-case wait is the work
  ahead of it in line, not how often it has re-entered the queue.
- Goal: preserve the current semantics elsewhere. The lock still releases
  automatically at the step boundary; the pinned infrastructure-signature
  error text (`lock not acquired within`) stays so the rerun classifier in
  `qwen-autofix.yml` is untouched.
- Goal: keep the test-lane wait budget at 5400 s. With both lanes' suites
  off the lock, the longest hold this workflow takes is the write-back's
  300 s backstop, so 5400 s covers eighteen of them. The budget still bounds
  one hold, not the queue; no constant budget bounds the queue itself
  (qwen-code#15243).
- Non-goal: reducing total occupancy. Sharding the lock by suite, capping
  registrations per host, or adding hosts are orthogonal and can follow;
  fairness makes their remaining work measurable instead of urgent.
- Non-goal: changing the MariaDB write-back's 5400 s budget or its
  310-minute ceiling; its hold is the short copy.

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
  PID is dead and whose mtime is older than 10 seconds. A waiter that is
  still waiting its turn re-touches its ticket every two seconds, and a head
  blocked in `flock` re-touches from a background keepalive at the same
  cadence, so a second arm can reap any ticket older than 1800 seconds —
  which is what keeps a ticket whose PID was recycled from wedging an idle
  lock. The keepalive closes the lock fd, so it can never hold the lock, and
  uses `touch -c`, so it cannot recreate a ticket that was already removed.
- On success the ticket is removed immediately: a holder needs no place in
  line once the kernel holds the lock, and a trap cannot see the helper's
  local after `return`. The lock stays on fd 9 in the step shell, so it
  still releases automatically at the step boundary — the helper changes
  acquisition order, not release semantics.
- On timeout the helper prints
  `::error::sdk-java host lock not acquired within N minutes as queue ticket S (CLASS); head of queue is H`
  and returns 1. `CLASS` is `fast` or `normal`, as the ticket stood when it
  gave up; `H` is the head of the queue at that moment, or
  `(no other ticket queued)` when this ticket was the last one. The
  `lock not acquired within` substring is the contract the rerun classifiers
  match.
- Wait observability: a non-blocking probe runs first, and only a waiter
  that actually has to wait prints its ticket number and the remaining
  budget — before it blocks, and at most once a minute after. A blocked head
  cannot print while it is blocked, but the line it printed before blocking
  names it, so a hang is attributable from the step's first lines.
- Failing closed is worse than falling back here: `release-sdk-java.yml`
  resumes an existing tag by checking out that immutable commit, which may
  predate the helper. Both sites therefore fall back to the lock they
  replaced when the helper file is absent (`flock --wait 5400 9` at the test
  site, `5400` at the write-back), rather than dying before Maven and
  wedging the release permanently.

### Hold scope: the write-back, not the suite

A fair queue still cannot bound a wait that outlasts its budget. The MariaDB
lane held the lock across its install and its full MySQL `clean verify`; under
pool contention that verify ran for about three hours (run 39628985638 held it
15:54-18:57) while the fast tier owns the same lock with a shorter wait. Run
39627609266's fast-tier job arrived at 17:38, stayed head of the queue, and
failed at 19:15 without starting Maven — the hold, not the queue order, was
the bound.

Both Maven runs already resolve from a job-local repository. The seed copies
the host cache as hardlinks, so Maven's resolver could rewrite its
bookkeeping in place through those links; the seed therefore unlinks
`_remote.repositories`, `maven-metadata-local.xml`,
`resolver-status.properties`, and `*.lastUpdated` across the whole job-local
copy and lets Maven create fresh ones. Only the cache write-back may mutate
`~/.m2`, so only the write-back takes the lock: it drops the in-house
coordinates the host cache must never carry and never publishes the same
resolver bookkeeping, then publishes this job's artifact delta. A later
step in the job resolves from the job-local copy without unlinking, because
no bookkeeping inode there is shared with the host cache. The seed is
best-effort and runs before the acquisition; the Maven
runs run unlocked; the write-back holds one acquisition, and its `rm`,
`mkdir`, and bounded `find`/`cp` children drop fd 9 so a survivor cannot
retain the lock. A hold now measures the copy instead of the suite.

The push-time test job was the remaining whole-suite hold. On 2026-10-22 run
39805834871's fast-tier Java 21 leg entered the queue as a fast ticket, became
head, and burned the full 5400 s budget while sibling suite holds ran ahead of
it (issue #15281). It now seeds and resolves from the same job-local
repository, runs its three Maven invocations unlocked, and takes one
acquisition for its own write-back under the same 300-second backstop. Both
lanes therefore keep the lock only for the cache copy, and the fast tier's
90-minute budget is far above one hold.

The 925 s suite figure that sizes the 150-minute ceiling was measured while
the lock admitted one suite per host. With both lanes locking only the copy,
different jobs can now run their suites concurrently on one host; the
ceiling's ~1700 s of slack is the buffer for that contention, and the first
pool runs after merge are its soak. A sustained overrun surfaces as the
job's own timeout, not as a lock wait.

### Fast-tier priority

The FIFO queue bounds a waiter by its position, but it still puts a fast-tier
job behind every full-tier ticket already waiting. On 2026-10-21 run
39562109470's `SDK Java (fast)` job spent its first 38 minutes as a non-head
waiter behind other tickets before it became head (qwen-code#14566). That
part of the wait is what this section removes. Two classes now share the one
physical lock:

- Tickets are named `rank-sequence-pid`. `fast` is rank 0 and `normal` is
  rank 1; the head is the smallest live name, so every fast ticket precedes
  every full-tier ticket that has not yet been promoted.
- The test job passes its tier to the helper, so a fast-tier run enters the
  fast class while approval, release, and MariaDB work stays normal.
- A full-tier head already blocked in `flock(2)` keeps its kernel wait
  position, and the smallest fast ticket that arrives behind it becomes the
  new minimum and parks too. The Linux wake order measured for this queue is
  insertion order (kernel 6.6, util-linux `flock` 2.38.1, six real waiters,
  3/3 runs; the run is recorded in qwen-code#15035), so the parked head
  still wins the next release. Later fast tickets are never the minimum
  while that parked fast ticket stands, so they loop and are served in
  ticket order.
- A fast job therefore waits for the hold already running, at most one
  parked full-tier head, and the fast-class tickets ahead of it — older fast
  tickets and promoted ones, parked or not — never for the full-tier queue
  still waiting in userspace. Only one full-tier head can be parked at a
  time: a normal ticket parks only as the minimum, so only while no
  fast-class ticket is queued, and while it is parked its keepalive keeps its
  ticket ahead of every later normal ticket. More than two tickets can still
  be parked at once — a full-tier head, the fast ticket that arrived behind
  it, and an older normal ticket promoted after that — and the kernel serves
  them in the order they parked.
- A normal ticket that waits past `SDK_JAVA_LOCK_PROMOTE_AFTER` (default
  1200 s) is renamed into the fast class. It keeps its sequence, so it
  precedes fast tickets that arrived after it, and continuous fast traffic
  cannot starve the full tier. Promotion protects waiting full-tier tickets,
  not parked ones: a parked head never loops back to the promotion check, and
  it does not need to, because it is already next.
- The promotion window bounds the overtake, not a hold. A fast ticket that
  arrived before the promotion and already parked in `flock` keeps its
  earlier kernel position, so the promoted ticket waits one more hold behind
  it; the cost is bounded by tickets already parked, not starvation. Under a
  single hold longer than the window every waiting normal ticket crosses the
  threshold together, the queue is plain sequence order, and a fast ticket
  arriving afterwards has nothing left to overtake.

The release semantics and the `lock not acquired within` substring the
rerun classifiers match are unchanged; the timeout line now also names the
ticket's class.

Priority does not bound a single hold. The same 2026-10-21 job then waited
its last 52 minutes as head behind one hold and timed out. Before the
MariaDB lane's suite moved off the lock, its holds of 7426 s and 8685 s were
measured here, and a chain of holds could outlast a budget too: on
2026-10-22 run 39754359013's Java 11 and Java 21 lanes each burned the full
5400 s while the MariaDB lane still held the lock for its verify
(qwen-code#15243) — pre-#15128 history, like those longer holds. At this
commit both lanes lock only the write-back, whose hold is bounded by the
300 s backstop, so the test lane's 5400 s acquisition budget covers eighteen
holds; no constant budget bounds the queue itself (#14566, #15031). Its
150-minute ceiling covers one full wait, the 925 s suite, one write-back, and
~11 minutes of setup. The MariaDB write-back keeps 5400 s and its 310-minute
ceiling:
its own hold is the short copy, and its wait sits after the ~3-hour verify,
so a larger budget would not fit a legal job ceiling. Naming the holder (a
long ticketed hold, or a process that never took a ticket) is the diagnostic
in qwen-code#15031, and bounding hold length stays with #14566.

The head keepalive matters more with two classes. Without it, a head blocked
past 1800 s loses its ticket to another waiter's reaper, and the next ticket
in line — whatever its class — becomes head and parks in the kernel as well.
Over a hold of two hours that lets several normal tickets take kernel
positions ahead of fast tickets that arrive later, which is exactly the
order this section exists to prevent.

### Why fairness over the alternatives

- Shard the lock by suite: reduces queue frequency but each shard is still a
  bare flock and keeps the same lost-place race per host; it also would not
  bound the suite concurrency this change now accepts deliberately (see
  "Hold scope").
- Cap registrations per host: needs pool topology changes outside the repo
  and leaves the same lost-place race per host.
- Second host: at least three hosts starved simultaneously; host count is
  proven not to be the binding constraint.

### Residual failure modes, accepted deliberately

- A dead waiter whose PID is recycled by a long-lived process keeps its
  ticket until the 1800 s mtime arm reaps it, so an idle lock is
  unreachable for at most that long and a waiter behind it still has the
  rest of its budget. If a host is wedged anyway, the operator recovery is
  `rm -rf ~/.cache/qwen-code-ci/sdk-java-tests.lock.queue/`; nothing in the
  repo performs it.
- A head killed with SIGKILL leaves its keepalive running until the
  keepalive's next two-second check finds the owner gone; the ticket is then
  reaped by the dead-owner arm as before, and `touch -c` cannot bring it
  back.
- The counter is serialised by `flock` on the append-only `.seq` file, and
  the kernel releases that lock when the holder dies, so there is no aging
  path to clear; a kill inside the read-increment-write costs at most one
  retry.
- Suites from different jobs can now run concurrently on one host, and no
  bound covers their aggregate memory. This repository records neither the
  pool hosts' RAM nor their registrations per host; the only heap caps in
  `packages/managed-agent-server/pom.xml` (`-Xmx256m`, `forkCount 1`) sit on
  failsafe profiles, while the unlocked `mvn clean test` runs Surefire with
  no `argLine` and inherits the JVM's ergonomic maximum heap (25% of host
  RAM; about 30 GiB on a 247 GB development host, not a pool measurement).
  If the host runs out of memory, the kernel picks the victim among the
  Surefire forks, MySQL, and the runner listener, so a job that did nothing
  wrong can fail as a mid-suite JVM crash rather than the job timeout named
  above. The first pool runs after merge are the soak: it collects each
  leg's wall clock and any mid-suite JVM crash and posts them on issue
  #15281, so the accepted risk stays attributable.

## Validation plan

- Unit behavior of the helper is pinned by
  `scripts/tests/sdk-java-lock.test.js` (POSIX-only): FIFO ordering across
  two waiters, a fast ticket overtaking a waiting normal ticket behind a
  parked head, promotion of a waiting normal ticket ahead of a later fast
  ticket, a promoted ticket reporting the fast class when it times out, a
  parked head's ticket surviving another waiter's reaper, a timed-out parked
  head naming the ticket that displaced it, the keepalive stopping at
  acquisition and after its owner dies, the keepalive holding no fd on the
  lock (read from `/proc`, so Linux only), stale-owner reaping, timeout
  signature and ticket cleanup, with `flock` stubbed on `PATH`. The
  ordering stubs park `flock --wait` until release, as the kernel does, so a
  head cannot loop and be overtaken.
- The workflow pins move with the mechanism:
  `scripts/tests/sdk-java-workflow.test.js` pins the sourced helper and the
  `sdk_java_lock_acquire 5400` budget at each acquisition site, each locked
  lane's Maven runs above its acquisition and its write-back children's fd 9
  close, the write-back's host-cache in-house prune and resolver-bookkeeping
  exclusion, the seed's resolver bookkeeping unlink across `sdk-java.yml` and
  `release-managed-agent-reference.yml`, the test job's suite-status
  preservation, the Checkstyle step's Java-21 producer ordering, and the
  `.size-baseline` records the workflow's new size.
- Real-host soak is CI itself: the first pool runs after merge either
  acquire in ticket order or time out with an attributable ticket number.

## Acceptance criteria

- The test site in `sdk-java.yml` acquires through the helper at 5400 s
  with a 150-minute ceiling; the MariaDB write-back site keeps 5400 s under
  its 310-minute ceiling. The test job passes its tier and the MariaDB site
  defaults to normal.
- `npx vitest run scripts/tests/sdk-java-lock.test.js
scripts/tests/sdk-java-workflow.test.js scripts/tests/workflow-size.test.js`
  passes.
- The error text still contains the substring `lock not acquired within`,
  so `qwen-autofix.yml`'s `INFRA_FAILURE_SIGNATURES` keeps matching.

## Open questions

- Whether queue depth should be published as a metric; the minute-capped wait
  line is the minimal observability landed here.
