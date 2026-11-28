# SDK Java per-host lock: a FIFO ticket queue

[English](2026-10-20-sdk-java-fair-lock-queue.md) | [简体中文](2026-10-20-sdk-java-fair-lock-queue.zh-CN.md)

## Current PR scope

The suite/write-back lock split described below already landed on main through
#15128 and #15254. PR #15274 introduced the remaining
hardening: preserving failed-suite status through cache write-back, excluding
mutable resolver metadata, and observable cache seeding. Follow-up #18065 makes
safe job-local repository reconstruction part of that contract. The host cache
copy remains optional and observable, but required job-local de-aliasing,
mount-boundary inspection, permission repair, and resolver/coordinate pruning
fail closed before Maven. The reconstruction is centralized in
`.github/scripts/maven-cache-seed.sh`. The reference workflow always builds
its own workflow checkout and sources that helper directly. The four SDK call
sites check for a local helper and, when an older immutable source checkout
predates it, obtain the same helper version as the running workflow,
identified by `GITHUB_SHA`.
A fetch failure or missing helper stops Maven; it never silently degrades to
the host cache. Each fallback download uses an atomically created `mktemp` file,
not a fixed output path that could be an existing symlink or hardlink. An
exit-scoped trap attempts to remove only the downloaded copy, including when
fetch or seed fails. It never targets the workspace helper, and a removal
failure preserves the original step status and, when the output channel is
writable, emits a `::warning::` annotation with the helper's residual path in
a subshell. A closed log pipe can terminate that diagnostic subshell without
terminating the step shell before it restores the original status. Other
source, seed, mount, and prune failures remain fail-closed. Before
copying, the helper checks the host source for mounts; a mounted or uninspectable
host source skips that optional copy and uses a clean job-local repository. The
tooling lookup does not change the immutable source revision being validated.
The historical lock design below is context, not a new
relocation delivered by this PR.

Database integration now runs on MySQL only. References below to the former MariaDB integration site retain historical measurements; its unchanged lock, cache write-back and budget rules apply to the retained MySQL job. See the [current database verification scope](managed-runtime-broker-jdbc.md#database-verification-scope).

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
- Goal: keep the test-lane wait at the 9600 s bound while this PR moves its
  suite off the lock. Before the split the test lane's own suite was the
  longest hold (925 s suite-alone since #14801, and 1031-1205 s as a whole
  step at this head; the ceiling uses 1205 s); with the suite unlocked the
  only hold is the bounded write-back copy, so 9600 s is a conservative
  queue bound rather than a measured need. Shortening it is a separate
  queue-depth trade-off; no constant budget bounds the queue
  (qwen-code#15243).
- Non-goal: reducing total occupancy. Sharding the lock by suite, capping
  registrations per host, or adding hosts are orthogonal and can follow;
  fairness makes their remaining work measurable instead of urgent.
- Non-goal: changing either lane's wait budget or job ceiling in this PR.
  The MariaDB write-back keeps 5400 s and its 310-minute ceiling because its
  hold is the short copy; shortening the test lane's now-conservative
  9600 s/200-minute bound is a queue-depth follow-up.

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
  match; the sdk-java call sites rewrite it on the tolerated path below.
- Wait observability: a non-blocking probe runs first, and only a waiter
  that actually has to wait prints its ticket number and the remaining
  budget — before it blocks, and at most once a minute after. A blocked head
  cannot print while it is blocked, but the line it printed before blocking
  names it, so a hang is attributable from the step's first lines.
- Failing closed is worse than falling back here: `release-sdk-java.yml`
  resumes an existing tag by checking out that immutable commit, which may
  predate the helper. Both sites therefore fall back to the lock they
  replaced when the helper file is absent (`flock --wait 9600 9` at the test
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

Both Maven runs already resolve from a job-local repository, so they touch no
host-shared state. Only the cache write-back mutates `~/.m2`, so only the
write-back takes the lock. The host-cache copy (`cp -aln`) runs before the acquisition; a missing host
cache stays quiet and a cross-device or failed copy falls back to a clean local
repository. Safe reconstruction is not best-effort: it must sever aliases,
reclaim historical quarantine, inspect mount boundaries and repair local
directories before Maven runs. Failure of a required step stops Maven. Failure
to remove only the newly-created quarantine leaves any undeleted content in
quarantine and remains warning-only. It also drops the in-house fixed-release
coordinates from the job-local copy, so the unlocked `mvn install` writes
fresh inodes instead of rewriting the host cache through a hardlink. Maven
can truncate and rewrite its tracking markers (`resolver-status.properties`,
`*.lastUpdated`, `_remote.repositories`), version metadata and checksums
(`maven-metadata-*.xml*`) in place. The seed drops those entries too, along
with `*.tmp`, `*.part` and `*.part.lock` residue, so each job resolves this
state locally; this does not assume every Resolver version writes through an
existing inode. The prune clears inherited mutable state as well:
`RUNNER_TEMP` survives across jobs on the pool, so a previous job's
single-link markers go the same way as the hardlinks this seed created. A
missing host cache stays quiet while a real copy failure warns, so the
warning still means the seed failed. Seed removal and the locked host purge
match `qwencode-sdk` and `qwen-managed-agent-*` at any depth, including the
legacy nested `repository/com/alibaba/` tree. Both write-back prunes retain
every explicit coordinate and also exclude that module glob, so a host-side
unlink cannot make its seeded inode eligible for copy-back. The Maven runs
run unlocked; the write-back holds one acquisition, and its `mkdir` and
bounded `find`/`cp` children drop fd 9 so a survivor cannot retain the lock.
The write-back publishes artifacts only: resolver bookkeeping records this
run's resolution outcomes and is not copied into the shared cache. A hold now
measures the copy instead of the suite, and the fast tier's budget is again
far above one hold.

The test job follows the same rule. Its suite was the other long hold: on
2026-10-22, run 39771949573's fast-tier job failed at its 5400-second budget
twice, on `ecs-qwen-hk4-21` (attempt 1) and `ecs-qwen-hk3-11` (attempt 2).
The full-tier Java 21 leg of run 39754414693 ran 89 minutes on
`ecs-qwen-hk3-30` — a different host, so the per-host lock is not what
coupled them — and was itself a starvation victim: its attempt 1 failed at
exactly 5400 seconds, and its 89-minute attempt 2 was ~81 minutes of its own
lock wait plus ~6 minutes of Maven. The timeline-supported holder candidate
is the pre-#15128 MariaDB `verify` hold (#15128 merged 2026-10-22T13:44:46Z,
after attempt 1 and 17 minutes into attempt 2's wait). Whoever holds it, a
suite hold measures in tens of minutes to hours while the write-back is
bounded at 300 seconds, and that hold class is what the split retires. Its
Maven runs now resolve from the job-local repository seeded from `~/.m2`,
and only its write-back takes the lock.

With the test job's suites unlocked, `sdk-java-tests.lock` no longer
serializes any suite on any host: the only section left under it is the
bounded write-back, and per-host suite concurrency is bounded solely by the
number of runner registrations. #14566's "bounding hold length" therefore no
longer covers that variable — uncapped concurrent JVM suites per host is now
the mechanism's real bound.

A write-back that cannot acquire the lock within its budget warns and skips
the copy instead of failing the step. The Maven gate result above is already
final at that point, and the call sites rewrite the helper's timeout text
case-insensitively before it reaches the log, so nothing on that tolerated
path carries a rerun-classifier signature onto a succeeding step. The same
policy covers a host fault the helper cannot recover from: a missing `flock`
or an unusable cache or queue directory warns and skips before the helper
spins out its budget, and so does an unusable host cache or job-local
repository at the write-back prelude. In the bare-lock fallback, only
`flock`'s timeout status is tolerated; any other status is an unknown setup
failure and stays fatal. Every one of these tolerated paths exits with the
suite status: the suite captures its own result before the write-back, so a
failed suite still publishes the dependencies it downloaded and the step
still reports the failure.

A red suite still reaches the write-back. Both jobs' Maven runs record a
failure in `mvn_status` instead of aborting under errexit, the failure stops
the remaining suites, and that deferred status fails the step after the copy.
The downloads the failed run made are therefore published instead of
re-fetched by the next leg, and a tolerated skip of the copy reports the same
status rather than turning the step green. A red leg queues only as long as
the copy itself may run (300 s) instead of spending the green lane's 9600 s
or 5400 s budget to repeat a failure signal that is already decided. The copy publishes
artifacts only: resolver tracking markers, metadata and its checksum files,
current Resolver `*.tmp` fragments, and older Resolver `*.part` / `*.part.lock`
residue stay out, because a published marker would make every later reader
of the host cache inherit that resolution outcome.
Because the write-back output now sits between the failure and the log tail,
every exit that can end a red step names the failing stage in an annotation;
Maven exits 1 for nearly every failure mode, so the bare exit code cannot tell
the three suites apart.

The green-suite 9600 s test-lane and 5400 s MySQL write-back budgets are unchanged.
Both lanes cap a failed suite's write-back wait at 300 s.
They bound the queue, not the hold; the test lane's 9600 s is carried from
the pre-split topology where its suite could queue behind several holds, and
with the suite unlocked it is a conservative bound (about 32 queued 300 s
copies) rather than a measured need. The 1200 s promotion window stays well
inside both green budgets; a red suite expires before promotion. The wait
guards an optional bounded copy, so an expired budget skips the copy instead
of failing the step.
Shortening the test lane's budget to 1800 s (six queued copies) is a
queue-depth trade-off left to a follow-up.

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
- The promotion window bounds the overtake, not a hold. Promotion is
  per-waiter: each normal ticket renames itself when its own wait crosses
  the window. A fast ticket that arrived before the promotion and already
  parked in `flock` keeps its earlier kernel position, so the promoted
  ticket waits one more hold behind it; the cost is bounded by tickets
  already parked, not starvation. Only under a single hold longer than the
  window does every waiting normal ticket cross the threshold together;
  otherwise they promote one at a time, and a fast ticket arriving before a
  younger normal ticket has aged past the window can still overtake it. The
  queue is plain sequence order only once every waiting normal ticket has
  individually crossed the window.

The release semantics and the `lock not acquired within` substring the
rerun classifiers match are unchanged; the timeout line now also names the
ticket's class.

Priority does not bound a single hold; the hold-scope change above does.
The same 2026-10-21 job then waited its last 52 minutes as head behind one
hold and timed out. Before the MariaDB lane's suite moved off the lock, its
holds of 7426 s and 8685 s were measured here, and a chain of holds could
outlast a budget too: on 2026-10-22 run 39754359013's Java 11 and Java 21
lanes each burned the full 5400 s while the MariaDB lane still held the lock
for its verify (qwen-code#15243) — pre-#15128 history, like those longer
holds. At this commit the longest hold this workflow takes is the bounded
300 s write-back; the test lane's 9600 s acquisition budget is carried as a
conservative bound from the pre-split topology, and its 200-minute ceiling
covers that wait, the worst measured whole-step suite at this head (1205 s;
the 925 s suite-alone figure from #14801 is a lower bound), the write-back
and ~11 minutes of setup. The MariaDB write-back keeps 5400 s and its
310-minute ceiling: its own hold is the short copy, and its wait sits after
the ~3-hour verify, so a larger budget would not fit a legal job ceiling. Naming the holder (a long
ticketed hold, or a process that never took a ticket) is the diagnostic in
qwen-code#15031, and bounding hold length stays with #14566.

The head keepalive matters more with two classes. Without it, a head blocked
past 1800 s loses its ticket to another waiter's reaper, and the next ticket
in line — whatever its class — becomes head and parks in the kernel as well.
Over a hold of two hours that lets several normal tickets take kernel
positions ahead of fast tickets that arrive later, which is exactly the
order this section exists to prevent.

### Why fairness over the alternatives

- Shard the lock by suite: reduces queue frequency but each shard is still a
  bare flock. This change removes suite serialization entirely, so the
  untested assumption behind this bullet — that concurrent suites share the
  host safely on a pool that just OOMed a build — is now load-bearing for
  every suite on the pool.
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
  `scripts/tests/sdk-java-workflow.test.js` keeps the four SDK source sites
  byte-identical, and requires the reference build to source its checked-out
  helper directly without a download fallback. It checks the real
  `maven-cache-seed.sh` including its guarded presence, directory permission
  and mount-boundary checks, retained and dangling quarantine links,
  fallback cleanup, and required prune failures. The call stops before Maven
  when neither a local nor a revision-pinned helper is available, and also on
  source or required seed/guard failures. A helper already in the workspace, or obtained from the workflow's revision, really sources a warm
  hardlinked cache in a private fixture. The immutable validation
  source revision does not change. Downloads use fresh `mktemp` regular files,
  leaving the targets of pre-existing symlinks or hardlinks untouched, and
  attempt to remove only the downloaded copy on exit. If that removal fails,
  cleanup is advisory, preserves the saved step status, and emits a
  `::warning::` annotation with the residual path when the output channel is
  writable. The warning subshell confines `SIGPIPE` from a closed log pipe
  to that diagnostic process, so it cannot abort restoration of the saved step
  status. Other cleanup and warning I/O failures do not replace that status.
  Permission-denial cleanup cases are gated by an actual removal probe rather
  than uid alone, so root CI lanes without DAC bypass still run them. Probe
  setup errors and unexpected unlink errors raise failures instead of silently
  removing coverage. Each `seed_helper` step's sole trap must sit inside the
  unbroken missing-helper guard (`if ... fi`) after `mktemp` and before `curl`,
  pinned to a single-operand `${seed_helper}` removal with the warning
  subshell and saved status restoration — rejecting extra operands and extra
  traps. That trap is the step's only `rm`/`unlink`, so a removal cannot hide
  behind an aliased target, and the only `find -delete` allowed outside it is
  the write-back's host-cache coordinate purge, pinned to that whole command
  verbatim so neither an aliased target nor a broader purge of the shared
  cache can pass. This is a lexical pin: other destructive verbs, and
  obfuscated spellings of the same verbs (escaped or quoted tokens such as
  `r\m` or `-de'lete'`), are outside its reach.
  These cleanup and missing-helper
  probes set both `cwd` and `GITHUB_WORKSPACE` to a private fixture workspace
  so a `$PWD`-based deletion cannot touch the source checkout; the log-pipe
  cleanup probe initializes a fixture workspace helper from the checkout
  helper's bytes and checks that copy stays unchanged. A directory operand
  makes its cleanup fail independently of DAC privileges; the closed-pipe FIFO
  arm checks that `SIGPIPE` does not kill the enclosing shell and that the
  saved status is preserved, while the ordinary pipe arm checks the single
  annotated warning and residual path.
  The reference build directly sources its checked-out helper and never
  requires a fallback fetch. Tests pin the step's YAML attributes (no
  `continue-on-error`, `if`, `env`, or `shell` override), `set -euo pipefail`,
  the exact `self-hosted` helper block, and `mvn`-only follow-up lines with no
  downloaders or extra shell chaining; they also run the full step without
  forcing `-e` externally in a private workspace containing `.github/scripts`
  with only `maven-cache-seed.sh` absent to assert via executed-command
  tracing that failure occurs specifically at `source "${seed_helper}"` before
  Maven, leaving the helper absent and invoking no fetcher. A
  host-source mount or mount-inspection failure skips the optional copy and
  uses a clean repository; required job-local guards still stop Maven. It then
  also pins the sourced helper, the
  test lane's 9600 s budget and 200-minute ceiling, the red leg's 300 s
  clamp, the MariaDB write-back's 5400 s budget and 310-minute ceiling, the
  prelude and write-back tail at both sites — byte-identical apart from the
  wait budget with its red-path clamp and the helper's tier argument, with
  the deferred status and stage reporter normalized on both sides before the
  comparison — both jobs' Maven runs above their acquisition, every `mvn`
  line ending in `|| mvn_status=$?` with a named stage, the tolerated-skip
  arms exercised with both a green and a red status (the red ones assert the
  stage annotation and the 300 s budget), their write-back children's fd 9
  close, the in-house coordinates' and the resolver bookkeeping's —
  `_remote.repositories`, `maven-metadata-*.xml*`,
  `resolver-status.properties`, `*.lastUpdated`, `*.part`, `*.part.lock`, and
  `*.tmp` — the non-directory resolver and transfer-state files filtered from
  every seeded job-local repository and both write-back prunes. A legitimate
  Maven artifact directory is not deleted merely because its name matches
  those globs. Its JAR files are retained; matching resolver and transfer
  files within it are the residue removed before Maven,
  the write-back's host-side, any-depth removal of the
  in-house coordinates, the host-copy attempt staying best-effort while a
  failed mount check, permission repair, resolver-state prune or coordinate
  prune stops Maven before it can use an unsafe local tree, the
  annotation staying clear of `INFRA_FAILURE_SIGNATURES`, the seed and
  host-purge family globs agreeing at every site, and each write-back prune
  retaining every explicit coordinate plus the module glob. The fault arms
  cover a missing `flock`, a broken `mkdir`, a stray queue file, a lock path
  that is a directory, a timed-out `flock`, an unexpected `flock` status, an
  unusable host cache, a missing job-local repository, a historical
  quarantine or required prune that fails, which must stop Maven before it
  writes, and inherited single-link resolver state in a reused job-local
  repository, which the prune must clear. Only deleting the newly-created
  quarantine remains best-effort and warning-only; previous quarantine
  symlinks are reclaimed by the full loop, including dangling links that
  `[ -e ]` cannot see. The `.size-baseline` entry is re-measured to the
  workflow's size after the last edit.
- Real-host soak is CI itself: the first pool runs after merge either
  acquire in ticket order or time out with an attributable ticket number.

## Acceptance criteria

- The test site in `sdk-java.yml` acquires through the helper at 9600 s
  with a 200-minute ceiling; the MariaDB write-back site keeps 5400 s under
  its 310-minute ceiling. The test job passes its tier and the MariaDB site
  defaults to normal. Both sites run their Maven suites from a job-local
  repository before the acquisition. Every job that seeds a job-local
  repository drops the in-house fixed-release coordinates from the copy
  before running Maven. A failed or cross-device host copy may fall back to a
  clean network-backed repository; a mounted or uninspectable host source
  skips the optional copy without preventing a clean Maven run. An uninspectable
  job-local mount boundary,
  unrepairable local directory, historical quarantine that cannot be
  reclaimed, or required resolver/coordinate prune failure must stop before
  Maven. An older SDK checkout without the helper must be able to load the same helper
  version belonging to the workflow revision, still without modifying the
  immutable source under test. Only deleting the quarantine created for this
  run remains warning-only; any undeleted contents remain in quarantine.
- `npx vitest run scripts/tests/sdk-java-lock.test.js
scripts/tests/sdk-java-workflow.test.js scripts/tests/workflow-size.test.js`
  passes.
- The helper's timeout line still contains the substring
  `lock not acquired within`, so `qwen-autofix.yml`'s
  `INFRA_FAILURE_SIGNATURES` keeps matching a failed acquisition elsewhere.
  Both call sites downgrade a failed acquisition or a setup fault to a
  warning, skip the write-back, and rewrite the helper's timeout text
  case-insensitively on the way to the log, so an acquisition this workflow
  now tolerates leaves no classifier signature on the step whether the suite
  succeeds or fails, because every tolerated path exits with the captured
  suite status. Only an unexpected bare-`flock` status remains fatal.

## Open questions

- Whether queue depth should be published as a metric; the minute-capped wait
  line is the minimal observability landed here.
