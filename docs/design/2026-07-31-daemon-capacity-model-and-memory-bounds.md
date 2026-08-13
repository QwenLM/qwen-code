# Daemon Capacity Model and Memory Bounds

## Context

Issue [#8051](https://github.com/QwenLM/qwen-code/issues/8051) observes that the daemon limits registered workspaces and sessions by count, and that count limits are not memory limits. [#8091](https://github.com/QwenLM/qwen-code/issues/8091) proposes delivering the fix as seven PRs, of which [#8093](https://github.com/QwenLM/qwen-code/pull/8093) is the first: a process-wide `ResourceBudget` over the daemon root's JavaScript heap, with fifteen byte categories, composite atomic admission, splittable and transferable leases, three `AsyncLocalStorage`-scoped fair schedulers, and a heap-proxy charging model that prices a JavaScript value at two bytes per string code unit, 96 bytes per object node, and 16 bytes per property.

This document proposes a different decomposition of the same problem. It agrees with #8051's premise and with #8091's instinct to deliver incrementally. It disagrees about which process holds the memory, which mechanism can bound it, and which change should land first.

The three findings below come from reading the daemon as it exists today.

### The daemon is not one process

`ServeMode` is `http-bridge` (`packages/cli/src/serve/types.ts:18-35`): the daemon preheats one `qwen --acp` child per workspace runtime, and multiple sessions in one runtime multiplex onto that child through `connection.newSession()`. The daemon root pipes ACP NDJSON over HTTP and SSE. Per-session RSS of roughly 30–50 MB — the figure `maxSessions` is documented against at `types.ts:58-68` — is spent inside the child, not the root.

Aggregate child RSS is therefore where multi-workspace steady-state memory goes, and a byte budget over the root's heap does not observe it, bound it, or refuse it.

That is an argument against a _universal root-heap ledger as the daemon-wide boundary_, not against root-local protection. The root still owns ACP NDJSON assembly, EventBus replay rings, virtual-subagent snapshots, settings loading, active-session export, HTTP and WebSocket queues, and generation-scoped caches, and each of those can exhaust it independently of any child. Part 3 below is entirely root-side work for exactly that reason.

### The capacity model is decoupled from host memory

Three knobs decide how much memory the daemon may consume. Each is derived independently, and no code reconciles them:

| Knob                  | Derivation                                                  | Location                                                |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Registered workspaces | fixed constant `25`                                         | `packages/acp-bridge/src/channel-control-timeouts.ts:7` |
| Total sessions        | `maxSessionsPerWorkspace × workspaceCount`                  | `packages/cli/src/serve/run-qwen-serve.ts:391`          |
| Per-child V8 heap     | `max(min(50% of cgroup-or-host memory, 16 GB), V8 default)` | `packages/acp-bridge/src/spawnChannel.ts:18-36`         |

The third is the significant one. `getAcpMemoryArgs()` computes one value, caches it in a module-level variable, and applies it to **every** spawned child. It is a fraction of the host, not a share of anything.

The `max(…, V8 default)` term is not obvious from the code and matters twice over. The flag is emitted only when the computed target exceeds the **spawning daemon's own** `heap_size_limit` (`spawnChannel.ts:27-34`), so on hosts where the target is smaller the flag is dropped and the child silently inherits V8's default — which is itself derived from host memory. Measured on a 3.4 GB host: target 1747 MB, daemon limit 1795 MB, flag dropped, child ceiling 1795 MB. On a 32 GB host the default is roughly 4 GB, the target is 16384 MB, and the flag is emitted.

So the permitted total is 25 × 16 GB on a 32 GB host and 25 × ~1.8 GB on a 3.4 GB host — an overcommit of roughly twelve-fold either way, and the guard's only effect today is to raise a ceiling, never to lower one. That last property is why the change below must bypass it explicitly.

No byte accounting in the root process changes any of these numbers, because the root is not the process that allocates them.

### The daemon measures memory but has no denominator

`DaemonMetricsRing` already samples `rssBytes`, `heapUsedBytes`, `cpuPercent`, and `eventLoopLagP99Ms` every five seconds into a 180-bucket ring, giving fifteen minutes of history, and it already polls the primary ACP child's RSS with a single-flight guard and a 30-second staleness cliff (`packages/cli/src/serve/daemon-metrics-ring.ts`, wired at `run-qwen-serve.ts:4231-4377`). `GET /daemon/status` returns all of it.

What the daemon lacks is any figure to divide by. There is no cgroup read, no `heap_size_limit`, no ratio, no pressure level, no memory-derived issue code, no `limits.*` memory field, and no CLI flag anywhere in the daemon process. Core's `MemoryPressureMonitor` computes all of it, but `computeEffectiveMemoryLimit()` is a private method (`packages/core/src/services/memoryPressureMonitor.ts:766`) on a class constructed only by `Config.initialize()`, which the daemon never calls. Secondary-workspace children and every channel worker report no RSS at all.

The daemon can say how many bytes it is using and cannot say whether that is a lot.

## Problem

Stated precisely: **the daemon's capacity model has no relationship to the host's memory, and the daemon cannot observe how close to exhaustion it is.** Separately and independently, a small enumerable set of root-process containers is genuinely unbounded — any one of them can exhaust the root on its own, without a single child being involved. Both are real; neither is a reason to build a general accounting layer over every allocation.

## Goals

- Derive the capacity knobs from one memory figure, so a child's heap ceiling is a share of something rather than a fraction of the host repeated per child.
- Give the daemon a denominator, so pressure is observable before it is fatal.
- Bound the containers that are genuinely unbounded, at the container.
- Bound the _aggregate_ of many individually-bounded containers, where multiplicity makes the sum the real risk.
- Keep each change independently reviewable and independently useful — and keep each honest about which paths it covers.

## Non-Goals

- No process-wide byte ledger over the root heap, and no heap-proxy charging model. See "Rejected alternatives".
- No remediation in the observation work: no forced GC, no LRU eviction, no session closure, no process termination.
- No change to the interactive CLI or IDE companion memory behavior.
- No RSS or process-tree memory _guarantee_. Part 1 bounds V8 old space in ACP children; Buffers, native allocations, channel workers and MCP descendants are outside it.
- No general scheduling layer now. Spawn-time admission is on the path — it is what any enforceable live-child budget requires — but it waits for Part 2's data, and the heavy-I/O and process lanes wait for evidence of concurrency amplification. See "Rejected alternatives".

## Design principle

**Make the bound a property of the container, not a promise from the caller.**

A caller-declared reservation is only as good as the caller. #8093's `runBufferedProcessOperation(scheduler, budget, cwd, operation, maximumBufferedBytes, task)` accepts a byte count the caller asserts and nothing reconciles against the process's actual output; a caller that declares 1 MB and emits 500 MB leaves the ledger reporting health while the heap grows. Generalizing that pattern means every one of several hundred allocation sites must remember to estimate, reserve, and release on every path, forever, with no compiler assistance. Coverage will be partial. Partial coverage is not useless — it is fine, and normal, when status and capabilities name exactly which paths are protected, which is a discipline #8093's own delivery plan already imposes. The failure mode is narrower than "partial": it is advertising a daemon-wide guarantee on top of incomplete accounting, so that the accounted paths begin refusing work with 503 while the unaccounted paths are the ones exhausting the heap.

This principle is already the house style, and this repository's best work follows it:

- `readTextRangeFromHandle` takes two **required** byte budgets — `maxOutputBytes` for what a read returns and `maxScanBytes` for what it costs — because "a caller reaches for a handle precisely when it needs the read bounded" ([`2026-07-29-handle-bound-text-range-reads.md`](./2026-07-29-handle-bound-text-range-reads.md)). It checks the accumulator on every chunk, not every frame, because "a region with no line break would otherwise grow it until the whole file is resident" (`packages/core/src/utils/read-text-range.ts:350-353`).
- `packages/cli/src/serve/fs/policy.ts:33-62` separates soft truncation (`enforceReadSize`) from hard rejection (`enforceWriteSize`, `enforceReadBytesSize`), and sizes `MAX_WRITE_BYTES` deliberately below the Express body limit so a body that survives the parser survives the policy gate.
- The bounded replay window ([`2026-07-07-bounded-replay-snapshot-window.md`](./2026-07-07-bounded-replay-snapshot-window.md)) caps retained replay by serialized bytes, keeps at least one unit when a single unit exceeds the cap, and surfaces the loss as an explicit `history_truncated` marker rather than truncating silently. Its Audit Note round 3 records the lesson directly: "A turn-count cap does not bound memory when one turn contains large tool output."

The work below generalizes those. It does not add a second paradigm beside them.

## Design

### Part 1 — One budget, one denominator, reported before it is applied

Resolve the daemon's memory figures once and report them. Nothing consumes them to size a child yet, and that restraint is the design, not a staging convenience.

```
availableMemoryMb        = cgroup limit, else os.totalmem()          (capped at the host total)
configuredBudgetMb  = --memory-budget-mb ?? floor(availableMemoryMb * 0.5)
effectiveBudgetMb   = min(configuredBudgetMb, availableMemoryMb)
rootReserveMb       = min(clamp(floor(effectiveBudgetMb * 0.1), 256, 1024), effectiveBudgetMb)
childPoolMb         = effectiveBudgetMb - rootReserveMb
legacyChildCeilingMb     = min(floor(availableMemoryMb * 0.5), 16384)     // what a child gets today
insufficientMemory  = effectiveBudgetMb < 1024
```

Configured and effective are separate because they diverge in both directions, and collapsing them produces a denominator the machine cannot back. An explicit budget larger than the host is capped down. A derived budget below the documented minimum is **not** clamped up — an earlier draft did exactly that, and a 768 MB host consequently reported a 1024 MB budget, which would have poisoned every ratio the observation work is meant to compute. Too small a host is an observation (`insufficientMemory`), not a licence to invent capacity.

`recommendedChildShareMb(budget, children)` is exported and reported at both the registered and the live child count. It is never applied. The gap between those two numbers is the point of reporting them.

#### Why the share is not applied

Dividing the pool by a workspace count fails on its own terms, and this document previously proposed it:

- **Registration is not allocation.** A workspace runtime spawns its child lazily and `channelIdleTimeoutMs` defaults to `0` — "kills the channel immediately" (`packages/acp-bridge/src/bridgeOptions.ts:415-422`) — so a dormant secondary has no child. The preheated primary is the exception.
- **A registered-count divisor has a real cost and buys nothing.** On a 32 GB host with 25 registered workspaces and only the preheated primary live, that child would drop from a 16384 MB ceiling to 614 MB — a 26.7× cut driven by 24 registrations holding no memory. Meanwhile the per-child floor means divided shares still sum past the pool: on an 8 GB host, 25 children floored at 512 MB authorise 12800 MB against a 3687 MB pool.
- **Dynamic registration leaves no sound count.** A boot-time count misses later workspaces; recomputing cannot shrink a running child's V8 heap; the current registered count penalises dormant workspaces. Dividing by _live_ children instead still yields ceilings that depend on spawn order, and still no aggregate bound.

The real control is admission at spawn time keyed on concurrently live children, with a stated policy for what happens when the next child would exceed the pool. That needs the data Part 2 produces, so it is deferred rather than guessed.

#### What a child-capacity policy must respect when it arrives

- **`--max-old-space-size` bounds V8's old space, not RSS.** It does not cover Buffers, external and native allocations, the young generation, channel workers, MCP descendants, or any other child process. Any policy here is a _child heap policy_, never a process-tree memory guarantee, and the root reserve is a hedge rather than an accounting of those consumers.
- **Applying a share is a compatibility change even with no refusals**, because it alters child GC and OOM behavior. It cannot be shipped as "reporting only".
- **It must never raise a ceiling.** Clamping to `legacyChildCeilingMb` is what makes the policy safe to apply unconditionally; without it the minimum-budget constant and an over-large explicit flag both inflate the share.
- **The spawn path has a trap.** `getAcpMemoryArgs()` emits `--max-old-space-size` only when its computed target exceeds the _spawning daemon's own_ `heap_size_limit` (`spawnChannel.ts:27-34`). A budget-derived share is normally below that, so a naive change is silently dropped and the overcommit returns. The regression test must assert the flag survives a value below the test process's own limit.

**Modeled, not yet applied, as `--child-heap-mode`.** A first attempt sized each child by the count live at _its_ spawn; review showed that bounds the child count but not the memory, since V8 cannot lower a running child's ceiling and grants accumulate as P x H(n) — 2.6x the pool at seven children on 8 GB. The model is now a fixed partition: one constant ceiling for every child, with admission capped so the total stays inside the pool by construction.

Applying it is deliberately deferred. The compatibility point above is why: enforcing changes child GC and OOM behaviour, and nothing yet tells an operator beforehand whether their workload fits the ceiling. The refusal count cannot — children run on the host-derived ceiling while observing, so it measures admission pressure, not ceiling adequacy. The enforcing mode ships with the measurement that justifies it: peak old-space per child, compared against the modeled ceiling.

### Part 2 — Observe, with a denominator, before enforcing

This part splits by what each piece measures, because the denominators are independent and the cheap one is worth landing first.

**Ships first — the daemon root against its own two limits.** Status gains `runtime.memory.pressure`, carrying `level`, `ratio`, `source`, and the six raw figures the ratios come from, plus one code — `daemon_memory_pressure` — on the closed issue union. `source` names which denominator produced the level: RSS against detected cgroup/host memory, or V8 heap used against `getHeapStatistics().heap_size_limit`. Both are needed, because a container dies by the first and a process on a large host exhausts the second long before RSS is a meaningful fraction of the machine. It reads `process.memoryUsage()` where the status response is built rather than extending the sampler: the reading is wanted per status request, not per five-second tick, and the sampler's ring is a separate consumer that can be fed once there is something to trend.

**Landed second — aggregate child RSS.** The feared second failure mode (a child that exits mid-poll) turned out to need no new mechanism: the per-bridge cache already drops a reading when the channel dies, and the same `isChannelLive()` predicate removes that workspace from both the sum and the count in one synchronous pass, so numerator and denominator stay consistent. `childRssCoverage` now reads `active_children` and `runtime.memory.children` carries the sum with a `sampled` count beside it.

**Still deferred — the rest of the tree.** Channel workers report no RSS at all today, so covering them means building the reporting path first; the children's own MCP descendants are invisible for the same reason, since each child self-reports only its own process. Neither figure is process-tree memory, and the response says so.

An earlier draft of this section also promised a second issue code for a stale observation. It is not in the first change: nothing in it can produce a stale reading, since the figures are sampled synchronously as the response is built. A code with no reachable producer is an unwritable test and a contract clients would handle for nothing. It arrives with the polled measurements that can actually go stale.

The mode flag exposes only `off | observe`, defaulting to `observe`. An earlier draft borrowed the `--mcp-budget-mode` triple and offered `enforce` with a boot-time rejection, which is a dead switch: a value a caller can pass but never use. The enforcing value arrives with the enforcement. Nothing in this part remediates — no forced GC, no eviction, no session closure, no process termination.

This is deliberately promoted ahead of the byte-cap work. It is the only piece whose value does not depend on the rest of the design being correct, and every limit chosen later should be calibrated against its data rather than guessed. #8093's limit table is a weaker argument for this ordering than it first appears, and the weaker form is the honest one: `prompt: 384 MiB` is exactly `normalAdmissionBytes` and therefore redundant, but the 256 MiB categories are _not_ dead — a single category reaching 256 MiB binds well before total normal usage reaches the 384 MiB ceiling. The problem with the table is simply that the constants are uncalibrated, which is what observation fixes.

### Part 3 — Bound the containers that are actually unbounded

Ordered by measured risk, each independently shippable.

**The NDJSON frame reader is the first bounded-container increment.** Before this change, `packages/acp-bridge/src/ndJsonStream.ts` retained every unterminated tail chunk without a count or byte check, then allocated one contiguous copy, a UTF-16 string, and a parsed object — about fivefold amplification over a frame with no upper bound. Its decoded-message `ReadableStream` also ignored `desiredSize`, creating a second unbounded buffer behind a slow consumer. This is the read side of every spawned ACP child's stdout, while `packages/cli/src/serve/large-pipe-frame-observer.ts` only observes frames after parse and enqueue. `createStderrForwarder` (64 KiB with a `[truncated]` marker) and the channel worker's log buffer are the in-repo templates for bounding at the container.

The first Part 3 increment applies that protection only to ACP streams created by `qwen serve`. A complete inbound or outbound frame is limited to 64 MiB including its newline. The decoded inbound queue is limited to 256 messages and 64 MiB of retained wire bytes. `ReadableStream` exposes one scalar queuing cost rather than independent count and byte watermarks, so each message is charged `max(frameBytes, ceil(64 MiB / 256))`. This is deliberately conservative: it proves both queue bounds, although a mixed queue can be rejected before either independent limit is exactly full. Admission is checked against `desiredSize` before decode and parse, so the message that would exceed the queue is never materialized. Because the ACP SDK starts request and notification handlers without awaiting the previous handler, the daemon-owned client wrapper separately limits active handlers to 256 and their conservatively estimated retained payloads to 64 MiB. An inbound request keeps a transport slot until its response is written; once its handler returns, the response's actual conservatively estimated representation also occupies a 256-message/64-MiB prepared-response budget until local pipe delivery. Before any daemon-to-child request or notification enters the SDK, a connection wrapper reserves its arguments against the same count/byte shape; notifications release after local write and requests after response or definitive failure. The stream also correlates admitted outbound request ids with inbound responses. Crossing any of these bounds retires the exact channel generation instead of allowing a slow handler, blocked child stdin, or non-responding child to bypass the stream queue.

Crossing any bound is transport-fatal. The reader cancels the child stdout, reports a typed cause through the transport lifecycle hook, and closes its decoded readable; it does not error that readable because the ACP SDK's internal receive loop does not catch `reader.read()` rejection. Complete frames admitted before the failing frame remain deliverable in wire order, but no bytes from the failing frame are delivered. The spawn channel marks that exact tracked child unavailable, closes both child pipes, and starts termination, so a concurrent create, resume, attach, prompt, or status operation cannot continue on it during the termination grace period; the bridge's channel-exit path later tears down only the sessions multiplexed on that workspace generation. Guard-triggered exits remain unexpected in lifecycle metrics and include only the bounded typed cause code. Unterminated EOF and clean child-stdout EOF are both fatal on this daemon-owned path: a child that closes its protocol output but remains alive must not leave a reusable dead connection or process slot. Parse errors and structurally invalid JSON-RPC envelopes on the bounded path log only an error code, byte length, and SHA-256 digest, then retire the exact channel generation so the ACP SDK cannot retain a pending request for a response that was silently discarded. Bounded messages also stop at depth 64, 10,000 JSON nodes, and 4,096 array elements. Known child-to-client methods are prevalidated against the same ACP schemas before SDK dispatch, preventing schema-error expansion and independent SDK logging from bypassing the handler and response budgets. The daemon subset accepts numeric, null, and at most 256-byte string request ids; a response id must match an admitted outbound request tracked by the same bounded stream, preventing the SDK's unknown-response path from separately logging child-controlled ids. A matching response is itself proof that the child received the request and may race the parent's local write-completion callback. Method and error-message scalars are capped at 1 KiB. Admitted messages install a non-enumerable Node inspection redaction so the ACP SDK's own handler-error logging omits their payload; the daemon-bounded client wrapper also redacts the independently logged response-error object and emits only bounded error text and structured filesystem discriminators. The public `ndJsonStream` default, unguarded in-memory channels, direct embeds, interactive CLI, and IDE companion do not opt in, so they retain the existing eager queue, error wire shape, parse logging, and unterminated-EOF behavior.

The outbound check happens after `JSON.stringify` and UTF-8 encoding. It prevents an oversized frame from entering the child pipe, but it is not a pre-allocation encoder budget; bounded/canonical JSON encoding remains a separate container change rather than being hidden inside this transport PR.

**The EventBus replay ring bounds by frame count only.** `packages/acp-bridge/src/eventBus.ts:473` evicts on `ring.length > ringSize`, default 8000 frames, per session, tunable to a million. This is conspicuous because everything around the ring is already byte-bounded: per-subscriber queues at 2 MiB, replay burst at 8 MiB, journal at 8 MiB, compacted replay at 4 MiB. The ring is the gap, and it multiplies the unbounded frames above by 8000. The serialized size is **already computed and in scope** at `:459`, where it is handed to the compaction engine; applying it to the ring is a running total, an eviction loop over both bounds, and the retain-at-least-one guarantee the compaction engine already implements.

**Virtual subagent transcripts are read whole.** `packages/cli/src/serve/virtual-subagent-sessions.ts:331,385` call `Buffer.alloc(size - this.offset)` with `this.offset === 0` on first read, materializing the entire `.jsonl` transcript and, separately, the entire `.stream` sidecar, then `.toString('utf8')`, then `.split('\n')`, then a parse per line. `createSnapshotOnce` (`:593-620`) constructs a second target and re-reads the whole transcript, leaving two to three live copies. The paging reader and the byte-cursor pattern already in flight are the replacement.

**Session load and export are capped asymmetrically.** `packages/cli/src/serve/server/session-export.ts:83-108` passes a byte cap on the archived branch and calls `loadSession()` with none on the active branch — the same uncapped path used by daemon load and resume. The archived cap is 256 MB of JSONL, which parses to one to two gigabytes of objects, so neither branch is a real bound. `session-transcript-reader.ts` is the correct model and is already present.

**Workspace-supplied config files are read without a size gate.** `fs.readFileSync(path, 'utf-8')` on workspace `.qwen/settings.json` (`packages/cli/src/config/settings.ts:557,733`), trusted folders, the serve fast path (synchronous, so it also blocks the event loop), and every discovered `QWEN.md`, twenty concurrently (`packages/core/src/utils/memoryDiscovery.ts:225,245`). Registering a workspace containing a two-gigabyte `settings.json` exhausts the daemon with no session, no prompt, and no agent — the cheapest attack in the set, and the one furthest from anything a heap ledger would notice.

**ACP HTTP pre-attach buffers are the next bounded-container increment.** Connection and session replies are serialized once at production time and retained only as UTF-8 `Buffer`s. Each stream owns at most 256 buffered frames, each logical connection owns at most 1,024 frames and 64 MiB, and one process-global budget shared by primary and dynamic workspace registries owns at most 4,096 frames and 256 MiB. Attach transfers a lease to pending delivery; it is released only after the SSE write chain or WebSocket send callback settles. Count or byte overflow does not evict an older frame: it retires the exact session, or the whole logical connection when the queue is connection-scoped or shares a WebSocket. Fresh and newly attached session ownership remains provisional until the granting response is locally delivered, so teardown or overflow can roll back every definitively undelivered grant without exposing a session the client never learned it owned. If SSE accepts a complete ownership-granting frame but closes before its final write callback, the outcome is unknown and the daemon preserves the session rather than deleting it: a live logical connection conservatively commits ownership, while connection teardown detaches the client but leaves persisted state available for resume. Server response serialization failures are contained to the offending frame instead of being classified as resource exhaustion for the whole connection. Existing live SSE and WebSocket frames, and transient single-frame serialization amplification, remain separate container work.

Recorded and deferred with evidence: live SSE and WebSocket write chains respect backpressure but do not bound queued bytes (`acp-http/sse-stream.ts`, `ws-stream.ts`); the organized session list materializes 50,000 summaries; several per-workspace caches outlive their workspace.

### Part 4 — Small aggregate quotas where multiplicity matters

Bounding a container bounds one container. It does not bound _N_ of them, and the daemon's shape is many small bounded things: 32 sessions per workspace, 25 workspaces, an 8 MiB journal and a 4 MiB compacted replay each. Every one of those can sit inside its documented limit while the total reaches several gigabytes. Part 3 alone therefore does not produce an aggregate bound, and saying otherwise would repeat the mistake this document criticises #8093 for.

What is needed is narrow: per-workspace and process-wide counters over retained rings, queues, caches, and concurrent large operations, updated at the actual insertion and removal points. Two properties keep this from turning back into #8093's ledger — it counts the bytes a container **actually retains** rather than an estimated V8 object cost, and it is maintained where the data structure already mutates rather than at a separate reservation call every caller must remember. `EventBus`'s existing per-subscriber `maxQueuedBytes` is the shape to copy; it is already correct, just not aggregated.

Scope and constants for this belong after Part 2, for the same reason its constants do.

### Shared helpers, extracted on the second consumer

`truncateUtf8` exists in two private copies. A container bounded by count, bytes, and TTL is implemented correctly once (`session-transcript-reader.ts:148-150`) and approximated elsewhere. REST and ACP maintain two hand-written mappings over one shared error-class set, of which `FsError` (`fs/errors.ts:101`) is the only member carrying its own HTTP status. Each is worth unifying when a second consumer appears in this work, and not before.

## Rejected alternatives

**A process-wide byte ledger over the root heap (#8093's `ResourceBudget`).** It budgets the root, where the memory is not; its heap-proxy constants have no stable relationship to V8, which represents strings as ropes, slices, or external data and prices objects by hidden-class sharing, so the error is a factor of two to five in either direction; and its categories are global rather than per-workspace, so they do not deliver the tenancy isolation #8051 asks for. Its own defaults show the difficulty of choosing numbers without measurement, as noted above.

Two implementation properties confirmed by running the branch are worth recording so they are not re-derived later. `ResourceBudget.release()` and `ResourceBudgetLease.commitGrow()` are public and unvalidated, so a single stray call drives `usedBytes` negative and every subsequent cap silently stops binding; and `grow()` accepts a lease belonging to a different budget, which corrupts both. Separately, `emergencyPoolBytes` becomes `0` whenever `capBytes` is supplied (`resource-budget.ts:199-201`), so the reserve that exists to keep shutdown and overload responses possible disappears precisely when an operator configures a budget — which is what `--memory-budget-mb` would do.

**A new fair scheduling layer, as written (`FairDaemonBulkScheduler` and its spawn and process lanes).** Every hot spot enumerated above is a size problem; none is fixed by admitting fewer concurrent operations. The concurrency primitives already exist and are in use: `createFifoTaskQueue(limit)` (`extension-operation-scheduler.ts:31`) with FIFO admission, `AbortSignal` de-queueing, and `runUntilReleased` for early slot release; `PathMutexRegistry` for keyed locks; and `createTotalSessionAdmissionController` (`total-session-admission.ts:40-121`) for count admission with idempotent release and typed errors, which is what provides per-workspace isolation today.

The proposed lanes also carry defects that argue against adopting them as a foundation: the `AbortSignal` is accepted but never forwarded to the task, so cancelling a request de-queues it only while queued and leaves a running child process holding its slot; nested and cross-lane acquisition are hard 503s propagated through `AsyncLocalStorage` to all inherited asynchronous work, which fails the first time a bulk operation legitimately needs to spawn; and the spawn and process lanes set the per-workspace active limit equal to the global limit, so one workspace can occupy every slot. This is a case for deferring and narrowing the scheduler, not for ruling it out, and the earlier draft of this document overstated it. The existing primitives are not complete substitutes: `createFifoTaskQueue` has no waiting bound and no timeout, `PathMutexRegistry` can accumulate an unbounded promise chain, and `createTotalSessionAdmissionController` limits session counts but not child spawn, filesystem decoding, or external processes. More decisively, **any enforceable live-child budget requires admission at spawn time** — which is precisely a scheduling lane. So spawn admission is on the path; the heavy-I/O and process lanes should wait for measurements showing concurrency amplification or cross-workspace starvation, and if per-workspace fairness is needed, keyed round-robin on the existing queue is roughly forty lines against a tested primitive.

**`AsyncLocalStorage` on the daemon request path.** There is none today in `packages/cli/src/serve` or `packages/acp-bridge`. Workspace attribution already flows explicitly as `WorkspaceRequestContext.workspaceCwd` (`workspace-service/types.ts:68-77`) and as `AuditContext` through the filesystem boundary. Adding implicit propagation to carry data that is already carried explicitly adds a mechanism without adding information.

## Compatibility

The interactive CLI, IDE companion, and direct-embed bridge paths are unchanged: they spawn one child and keep the host-derived ceiling.

Part 1 changes no child spawn arguments, so there is no change to how any child is sized, on any host. The only new boot-time behavior is rejecting an out-of-range `--memory-budget-mb`, and a stderr breadcrumb when a budget is explicitly set or the host is below the documented minimum.

The compatibility discussion that belongs here is for the child-capacity policy that follows, and it is deferred with it. What can be said now: that policy will lower ceilings and must never raise them, it will be a compatibility change even without refusals, and it needs an admission rule for the case where an already-running child cannot be shrunk.

Workspace registration, persisted restoration, and `POST /workspaces` are unchanged. The daemon-owned ACP transport now refuses a complete frame above 64 MiB; a decoded queue, active-handler set, pre-SDK outbound operation set, outstanding request set, or prepared-response set above its 256-message/64-MiB charge; an incomplete or clean protocol EOF while the child is still owned; string request ids above 256 bytes; response ids that do not match an admitted outstanding request; method or error-message scalars above 1 KiB; and JSON structures above the documented depth/node/array limits. Parse, envelope, and known-method schema violations are also transport-fatal after metadata-only logging, so every refusal retires only that workspace channel generation instead of leaving an SDK request pending or an SDK write queue growing. Standalone and public `ndJsonStream`/bridge callers remain opt-in and keep their previous transport and error-wire behavior when no limits or transport guard are supplied.

ACP HTTP pre-attach queues no longer silently evict their oldest frame. The 257th frame on one stream, or a connection/global count or byte refusal, closes the exact owner; a shared WebSocket closes with code 1013. Buffered frames are serialized at production time, so later mutation of the source object no longer changes the wire result. `session/new`, `session/load`, `session/resume`, and `session/fork` notifications no longer mutate state, and request-form ownership is usable only after its response is locally delivered. Clients observe an overload through the SSE/WS close because a full queue cannot safely enqueue its own error response. Public standalone ACP behavior and the workspace/session count defaults are unchanged.

`maxSessions` and `maxTotalSessions` keep their current defaults and derivation, and this change gives them no new bound. An earlier draft claimed `maxTotalSessions` was transitively bounded because `workspaceCount` would be capped by the budget; that is false against this PR, where the workspace cap remains the fixed `MAX_REGISTERED_WORKSPACES = 25` and nothing derives a limit from the budget at all. Sessions still multiplex onto one child per workspace, so per-session memory sits inside a child heap that nothing currently bounds beyond V8's own ceiling. The documentation for `maxSessions` should be read as a fairness and file-descriptor lever, not a memory one.

`limits.memory` and `runtime.memory` on `GET /daemon/status` are additive and optional in the SDK mirror, so older daemons parse against newer clients.

Channel workers spawn `process.execPath` per workspace with no memory arguments (`channel-worker-supervisor.ts:823`). They are real consumers of the daemon tree's memory and are not covered by the per-child ceiling; the root reserve nominally covers them, and Part 2 measures them.

## Verification Plan

- Unit-test the budget arithmetic across constrained and unconstrained hosts with the host figure injected, including the per-child floor, the 16 GB ceiling, the cgroup sentinel clamp, and monotonicity of the per-child share in the child count.
- Regression-test that a budget-derived ceiling is emitted even when it falls below the spawning daemon's own heap limit. `getAcpMemoryArgs()` currently emits `--max-old-space-size` only when the computed target exceeds the current limit; a budget-derived value is usually smaller, so a naive change would silently drop the flag and restore the overcommit. This is the single most important test in the first change.
- Assert the effective budget never exceeds resolved host memory, in either direction: an explicit budget above the host is capped down, and a host below the documented minimum reports `insufficientMemory` rather than being clamped up. Assert the advisory share never exceeds `legacyChildCeilingMb` across host sizes from 768 MB to 32 GB.
- Assert that no child spawn argument changes: the existing spawn suites pass unmodified, and `getAcpMemoryArgs` is untouched at this stage.
- End to end: boot with several `--workspace` values and read `GET /daemon/status`; `limits.memory` should describe the host honestly and `runtime.memory` should show `activeAcpChildren` below `registeredWorkspaces` once a workspace goes idle — the observation that justifies keying the later policy on live children.
- For Part 2, assert a finite ratio under cgroup v2, cgroup v1, and neither; assert level classification; assert no remediation path exists; confirm aggregate child RSS includes secondary workspaces and channel workers. Then run the daemon under real use and read the result — that data calibrates Part 3.
- For each Part 3 change, the acceptance test is a before-and-after against a real oversized input: a multi-gigabyte single NDJSON frame, an 8000-frame ring of large events, a two-gigabyte `settings.json`. The daemon must refuse with a typed error while RSS stays flat, where today it grows until the process dies. That evidence is the point: a test that a ledger is internally consistent is not a test that memory is bounded.
- `npm run build`, `npm run typecheck`, and `npm run lint` on every change, plus the co-located suites for touched files.
