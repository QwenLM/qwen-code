# ACP Child Peak Old-Generation Measurement

Part 3b of #8091, first half. Closes the measurement prerequisite that #8182
and `child-heap-policy.ts` both name as the blocker for enforcement.

## Context

The observation stack is complete and non-enforcing:

- #8245 resolved the budget denominator (`configuredBudgetMb`,
  `effectiveBudgetMb`, `childPoolMb`, `legacyChildCeilingMb`).
- #8423 and #8462 added root pressure and an explicitly partial aggregate of
  active ACP child RSS.
- #8508 added the fixed partition under `--child-heap-mode off | observe`,
  publishing `maxConcurrentChildren` and `perChildCeilingMb` without applying
  either.

`limits.memory.enforced` remains the required literal `false`. Every ACP child
still receives `min(50% of host, 16 GB)` from `getAcpMemoryArgs()`, which is
what #8182 reports.

The remaining blocker is not admission arithmetic. `child-heap-policy.ts`
states the gap on `refusals`: a count of 0 says spawn _count_ stayed inside
`maxConcurrentChildren`, not that any workload would survive
`perChildCeilingMb`. Children run on the far larger host-derived ceiling while
observing, so the partition has never been tested against a real workload.
Enforcing on that signal switches a healthy daemon into an OOM loop.

This document designs the measurement that answers the question `refusals`
cannot, and nothing else. It changes no spawn argument, refuses no work, and
does not widen `enforced`.

## What the measurement must answer

One question: **would this child have survived `perChildCeilingMb`?**

Three candidate figures already exist and none of them answers it.

`children.rssBytes` is the wrong quantity. RSS covers Buffers, external and
native allocations, the young generation, and mapped pages;
`--max-old-space-size` bounds the old generation specifically. The two move
independently.

`heapUsed` includes the new generation, so it charges scavenger-managed
garbage against a limit that never sees it.

`refusals` counts admission pressure, as above.

## Evidence

Measured on Node v24.12.0, 48 GB host. The probe scripts live under
git-ignored `.qwen/scripts/`, so each result below states the method it came
from and is reproducible from that description alone.

### 1. `old_space` alone is not the bound, and reporting it would be dangerous

Method: allocate 2M-element arrays (~16 MiB each) in a loop under
`--max-old-space-size=256`, sampling `getHeapSpaceStatistics()` each iteration,
until the process dies.

```
0  {"old_space":3.0,"large_object_space":0.3,"oldGenSumMB":4.6}
5  {"old_space":3.5,"large_object_space":76.6,"oldGenSumMB":81.4}
10 {"old_space":3.5,"large_object_space":122.4,"oldGenSumMB":127.2}
15 {"old_space":3.0,"large_object_space":183.5,"oldGenSumMB":187.8}

[…] 80 ms: Mark-Compact (reduce) 263.1 (391.9) -> 263.1 (264.9) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The process died against a 256 MB ceiling while `old_space` read **3.0 MB**
throughout. Every byte was in `large_object_space`, which is part of the old
generation and counts against the flag.

This matters beyond pedantry. V8's large-object threshold measures at 128 KiB
on this build — an array of 16,000 elements stays in `old_space` while one of
32,000 lands in `large_object_space` — so transcripts, session journals, and
replay rings are all comfortably over it. They are the daemon's most likely
growth and the ones an `old_space`-only figure is blindest to. Such a
measurement would report that every workload fits comfortably in 614 MB, right
up to the instant enforcement killed it — reintroducing the failure #8508
refused to ship, through the field choice instead of through the refusal count.

**The measured quantity is the old-generation total, not `old_space`.**

### 2. Peak _committed_ size is limit-dependent; the post-major-GC live set is not

Method: churn 120,000 small objects per round for six rounds, retaining a slice
of each round so the live set genuinely grows, under two ceilings. These
allocations are all small, so `old_space` is the space that moves and the
figures below are `old_space` rather than the full old-generation sum —
evidence 1 is what says the shipped measurement must sum.

| `--max-old-space-size` | peak committed `old_space` | peak post-major-GC `old_space` used |
| ---------------------- | -------------------------- | ----------------------------------- |
| 16384                  | 125.0 MB                   | 32.2 MB                             |
| 614                    | 65.8 MB                    | 32.2 MB                             |

V8 grows the heap lazily and defers major GC in proportion to the limit it was
given. A child observed under today's 16 GB ceiling therefore commits roughly
twice what the same work needs under the modeled partition. Reading a peak of
800 MB and concluding "does not fit in 614 MB" would be wrong.

The post-major-GC figure is **identical under both ceilings**, to the decimal.
That is the one with a stable meaning: it is what the workload actually
retains, independent of how much rope V8 was given.

So the two answer different halves and both ship:

- **live-set peak > ceiling → the child cannot survive it.** Its retained data
  does not fit, whatever V8 does about the garbage. A sound refusal, with one
  caveat recorded in the implementation: GC entries reach a
  `PerformanceObserver` asynchronously, so the used-size read happens at the
  first opportunity after the collection rather than at the instant it ends,
  and counts anything allocated in between. The figure is therefore an upper
  bound on the live set. The error runs upward, so it risks a false refusal
  rather than a missed one — the safe direction, but a consumer must not treat
  the number as exact.
- **committed peak ≤ ceiling → the child almost certainly survives**, since
  that peak was measured with V8 at its laziest and a tighter limit collects
  earlier. Monotonicity of V8's growing heuristic in the limit is an
  assumption here, not a guarantee — which is why this side is used to admit
  and never to refuse.
- Between them is the honest unknown: it would fit, at the cost of more major
  GCs. Which is why GC cost ships too, below.

### 3. Interval polling misses the peak entirely

Evidence 2's run also carried a 1-second sampler. It recorded a peak of
**0 MB** while the GC-triggered path recorded 125 MB, because that workload
finished inside a single tick. The anecdote does not prove a 1 s cadence always
misses; it proves a peak can be wholly invisible to one, which is enough to
disqualify cadence as the mechanism.

The daemon's existing child poll is worse than 1 s here in two independent
ways. It runs at a 5 s cadence, and per `childRssCoverage` it is **gated on an
active SSE/WS watcher** — with no client attached, `sampled` falls to 0 while
children keep running. A peak sampled by that poll would describe only the
intervals during which somebody happened to be watching. The gating alone
settles it, independent of any cadence argument.

**The high-water mark accumulates inside the child. The poll only reads it.**

### 4. `heap_size_limit` is not the flag value

Method: read `getHeapStatistics().heap_size_limit` from a fresh process at each
`--max-old-space-size` value.

| flag  | `heap_size_limit` | delta |
| ----- | ----------------- | ----- |
| 256   | 448 MB            | +192  |
| 512   | 704 MB            | +192  |
| 614   | 806 MB            | +192  |
| 1024  | 1216 MB           | +192  |
| 4096  | 4288 MB           | +192  |
| 16384 | 16576 MB          | +192  |

`heap_size_limit` adds the new-space allowance. Comparing a peak against it
instead of against `perChildCeilingMb` would build in a fixed false margin.
The offset is a V8 implementation detail, so it is neither hardcoded nor
relied upon; it is recorded here only to justify comparing against the flag
value.

It also means the existing guard in `getAcpMemoryArgs()` compares a
max-old-space target against a `heap_size_limit`, two quantities that differ
by this offset for the same setting. The guard therefore drops the flag in a
narrow band where it would in fact have raised the ceiling. Out of scope here
and not worth a behavioral change on its own; recorded so the enforcement PR,
which must bypass this guard anyway, does not rediscover it.

## Design

### Where it runs

Inside the ACP child, gated on the existing exact-value daemon marker
`QWEN_CODE_SERVE === '1'` (`config/acp-channel-fallback.ts`), which
`spawnChannel.ts:451` already stamps. No new environment variable.

This keeps the interactive CLI, the IDE companion, direct-embed bridges, and
standalone ACP untouched, as #8182 requires — by construction rather than by a
second flag that could disagree with the first. The marker is not settable
from workspace `.env` or `settings.env`, so a workspace cannot switch the
probe on or off.

Channel workers carry the same marker
(`channel-worker-supervisor.ts:386`), but the worker process does not serve the
`qwen/status/workspace/resource` ext method, so installing the probe on the ACP
agent's init path does not reach it. Worker heap stays unobserved, consistent
with what `childRssCoverage` already documents, and Part 2b owns it.

The ACP children a worker spawns _do_ inherit the marker and are probed, which
is correct — they are ACP children. Whether their readings reach the daemon's
aggregate is decided by the `managedRuntimes` enumeration that #8462 already
established; this change neither widens nor narrows that coverage.

### How the peak is captured

A `PerformanceObserver` on `'gc'` entries, plus an `unref()`ed low-frequency
interval as a floor for long GC-free stretches.

They do not feed the same accumulators. The interval and every GC entry update
the committed and total-heap marks; `peakLiveSetBytes` is updated **only** from
major-GC entries, because a used-size read at any other moment includes
uncollected garbage and would destroy the limit-independence that makes it the
refusal figure.

The GC observer is the primary trigger because allocation growth is what
_causes_ GC, so its entries are correlated with the peaks by construction in a
way a fixed cadence is not (evidence 3).

One assumption here is worth naming rather than burying: the observer callback
runs _after_ the collection, so it can only see the committed high-water if V8
releases committed pages lazily rather than at the end of the GC that freed
them. That is V8's documented behavior and matches evidence 2, where the
committed peak survived to be read — but evidence 2 also sampled inline from
the workload, so it does not isolate the observer. The PR pins the callback
wiring with an injected observer: a delivered major-GC entry must move the
live-set and GC figures and a minor entry must not, so a wrong `kind` check
or a callback that never runs cannot stay green. The lazy-release assumption
itself is accepted as V8's documented behavior; forcing a real major GC on
demand needs flags the test runner does not guarantee. If it does not hold,
the interval stops being a floor and becomes the primary trigger, at a
cadence tight enough to matter.

Both sampling paths are best-effort. `getHeapSpaceStatistics()` is wrapped the
way `workspaceResource` already wraps `memoryUsage()` and `cpuUsage()`: a throw
in a restricted container leaves the accumulators at their last good values
rather than failing the handler. A child whose every read throws reports no
`heap` at all — the field stays absent until the first successful sample, so
the absent-not-zeroed rule below holds at the child layer too, and an empty
`unclassifiedSpaceNames` always means coverage was checked, never that nothing
was measured.

### What is accumulated

Three high-water marks and two counters. None is ever reset: they describe the
whole lifetime of the child process, which is the right scope for "did this
child ever need more than the ceiling". A channel swap replaces the child, so
lifetime scope and channel-generation scope coincide.

| field                       | source                                                   | meaning                                               |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `peakOldGenerationBytes`    | Σ old-gen `space_size`                                   | committed high-water; the sound-admission figure      |
| `peakLiveSetBytes`          | Σ old-gen `space_used_size`, sampled after major GC only | limit-independent retention; the sound-refusal figure |
| `peakTotalHeapBytes`        | `getHeapStatistics().total_heap_size`                    | name-free cross-check; see its limits below           |
| `majorGcCount`, `majorGcMs` | `'gc'` entries of major kind                             | the cost of a smaller ceiling, not just its safety    |

`majorGcCount` and `majorGcMs` are not decoration. Lowering a ceiling trades
memory for GC time, and evidence 2 already shows the count rising from 2 to 3
on a trivial workload. Without them the enforcement PR could report that every
child "fits" while making every child materially slower, and no field on the
wire would say so.

### Old-generation space set, and admitting when it is wrong

The child holds **two** known sets, not one.

Summed as old generation (10): `old_space`, `large_object_space`, `code_space`,
`code_large_object_space`, `trusted_space`, `trusted_large_object_space`,
`shared_space`, `shared_large_object_space`, `shared_trusted_space`,
`shared_trusted_large_object_space`.

Knowingly excluded (3): `new_space`, `new_large_object_space`,
`read_only_space`.

Two sets rather than one because a single old-gen set with an "everything else
is unknown" rule would report `new_space` and `read_only_space` as unclassified
on every healthy child, and a field that is never empty carries no signal.

That the taxonomy really does move is not hypothetical. Node 22 reports 11
spaces and Node 24 reports 13; `map_space` was removed and the `trusted_*`
spaces were added. Both are supported here (Node >= 22), so two taxonomies are
live in the field simultaneously. The sets above were checked against
v22.19.0, v22.22.3, and v24.12.0 and leave nothing unclassified on any of
them — which is also why the set must be built by verification rather than
from memory, since an eight-member set omitting the two `shared_trusted_*`
spaces classifies cleanly on Node 22 and silently under-reports on Node 24.

A name-based sum under-reports when a future V8 adds a space neither set knows,
and under-reporting is the dangerous direction: it makes a child look like it
fits.

So the child reports what it could not classify rather than hiding it:

- `unclassifiedSpaceNames: string[]` — names in neither set, empty on both
  taxonomies known today. This is the primary signal, and the only one that
  names the gap. A new V8 space lands here whether or not it belongs to the
  old generation, which is the conservative direction: the enforcement PR
  investigates rather than assuming.
- `peakTotalHeapBytes` from `getHeapStatistics()`, which needs no space name at
  all. Its cross-check is deliberately weak and should not be oversold: it
  includes the new generation, so the gap between it and the old-gen sum is
  never zero and cannot by itself localise a missing space. It bounds how much
  the sum could be missing; `unclassifiedSpaceNames` says whether it is.

The enforcement PR must treat a non-empty `unclassifiedSpaceNames` as
"coverage unknown" and decline to enforce on that child, the same way
`childRssCoverage` and `children.sampled` already state partiality instead of
implying a total.

### Transport

Extend the existing `qwen/status/workspace/resource` response — the child
already answers it with `{ rssBytes, cpuPercent }` and the accumulators are
read synchronously. No new ext method, no new poll, no new cadence.

The parent side (`bridge.ts` `refreshChildResource`) applies the same
trust-boundary validation the existing fields get: `typeof === 'number'`
**and** `Number.isFinite`, since `typeof NaN === 'number'`. Fields absent from
an older child stay absent rather than being defaulted to 0 — a zero peak and
an unreported peak are different claims, and the second must never read as
"this child needs nothing".

### Status surface

Under `runtime.memory.children`, beside the existing `rssBytes` / `sampled` /
`oldestReadingAgeMs`.

Every figure is a **maximum across sampled children, not a sum** — including
the GC counters. The ceiling is per child, and the peaks were reached at
different times, so a sum answers a question nobody asked. For the counters the
argument is the same in a different direction: summed GC counts measure
daemon-wide GC activity. Each field is an independent maximum, not a portrait
of one child — the committed peak and the live peak may come from different
children, and a per-child ceiling is judged against each axis on its own.

`null`, never `0`, when no child reported — matching `oldestReadingAgeMs`,
which already distinguishes these. A daemon with children that predate the
fields, or with the sampler closed because no client is watching, must not
publish a `0` peak that reads as "no child needs any heap". This is the same
distinction the transport section makes for an absent field, carried one layer
up so it cannot be lost in aggregation.

`limits.memory.enforced` stays the required literal `false`. `ChildHeapMode`
stays `off | observe`. Nothing in this change makes `enforce` representable.

## Compatibility

No child spawn argument changes, so child GC and OOM behavior are byte-for-byte
what they are today. This is the property that keeps the change reporting-only
in the sense #8182 demands — the issue is explicit that anything applied to
`--max-old-space-size` is a compatibility change _even without refusals_.

Additive status fields only. Non-daemon spawn paths are untouched.

The one real cost is the probe itself: a GC observer and an unref'ed interval
in every daemon-spawned ACP child. Bounded by the marker gate above, and
measured in the verification plan below rather than assumed negligible.

## Non-goals

- No `enforce` mode, no derived ceiling, no spawn refusal.
- No channel-worker or MCP-descendant heap coverage — Part 2b.
- No change to `MAX_DAEMON_WORKSPACES`, session caps, or the budget resolver.
- No fix to the `getAcpMemoryArgs()` guard offset in evidence 4.

## Exit criteria for the enforcement PR

Stated here because "we will have data" is not a criterion.

1. For representative workloads — a long session with a large transcript, a
   wide repo scan, a multi-MCP configuration — `peakLiveSetBytes` sits below
   `perChildCeilingMb` on both an 8 GB and a 32 GB modeled partition, with
   `unclassifiedSpaceNames` empty on every supported Node major.
2. The major-GC cost delta between the legacy ceiling and the modeled ceiling
   is quantified for those workloads, not merely observed to be non-fatal.
3. Enforcement ships opt-in. The default stays `observe` until an operator can
   read their own daemon's figures and decide, which is the entire purpose of
   this change.

If criterion 1 fails, the answer is a different partition, not a louder
warning.

## Verification plan

Unit, collocated:

- `child-heap-probe.test.ts` — accumulators are monotonic; a throwing
  `getHeapSpaceStatistics` preserves the last good values; an injected unknown
  space name lands in `unclassifiedSpaceNames`; major and minor GC entries are
  distinguished. One case must run against the **real**
  `getHeapSpaceStatistics()` of the Node executing the suite and assert
  `unclassifiedSpaceNames` is empty: a fixture can only contain space names
  somebody already thought of, so only the live call catches a taxonomy this
  repo supports and the sets do not.
- `acpAgent.test.ts` — the `workspaceResource` handler returns the new fields
  under the daemon marker and omits them without it.
- `bridge.test.ts` — `NaN`, `Infinity`, missing, and wrong-typed fields are
  rejected at the boundary; absent stays absent.
- `daemon-status.test.ts` — maximum-not-sum across children; partial coverage
  reported as partial; `enforced` still the literal `false`.

Integration: a real daemon E2E asserting the fields appear for a live ACP
child and that spawn arguments are unchanged — the second assertion is the one
that keeps this PR honest.

Cost: measure daemon-child startup and a scripted prompt turn with the probe
on and off, and record the delta in the PR rather than claiming it is free.
