# Daemon Multi-Workspace Resource Protection: Phase 1

## Status

- Tracking issue: [#8051](https://github.com/QwenLM/qwen-code/issues/8051)
- Delivery split: [#8091](https://github.com/QwenLM/qwen-code/issues/8091)
- Scope: production `qwen serve` root and daemon-managed restore paths
- Out of scope: workspace/session capacity LRU, active-session eviction,
  RSS-triggered remediation, and generic exactly-once operation receipts

This document describes the target state after the complete Phase 1 stack
lands. The first delivery PR adds only the budget and scheduler foundations; it
does not wire production routes, advertise resource guards, or change daemon
behavior.

## Problem

The daemon limits registered workspaces and sessions, but count limits are not
memory limits. A single large request, transcript, replay burst, slow client,
child-process result, or generation-scoped cache can still exhaust the daemon.
Dynamic workspace churn also makes any missing disposal hook an unbounded
retention path.

Phase 1 establishes deterministic byte and queue limits before adding any
memory-pressure action. It keeps the existing workspace and session defaults:
25 registered workspaces, 20 sessions per workspace, and the existing
`maxTotalSessions` derivation behavior.

## Invariants

1. Resource admission is synchronous and never waits.
2. Operations with a declared heap peak reserve it before entering a scheduler
   lane or state lock. Reader-only operations use fixed source/record limits;
   no path waits for memory while holding a lane or lock.
3. Every reservation has one generation-scoped owner and an idempotent release
   path.
4. New work cannot consume the completion reserve.
5. Cleanup and fixed terminal responses remain possible when normal admission
   is full.
6. Workspace-scoped work stays pinned to its resolved runtime generation and
   never falls back to the primary runtime.
7. Memory observation has no remediation side effects in Phase 1.

## Resource Budget

The daemon creates one process-owned `ResourceBudget` at the start of
`runQwenServeImpl`, before runtime configuration, bridge, route, and logger
publication work. The same instance is injected into every daemon-owned
runtime and transport.

The default heap proxy cap is 512 MiB. Normal admissions may consume at most
384 MiB. The remaining 128 MiB is reserved for completion-priority leases held
by already-admitted response encoding and cleanup. Fixed overload and shutdown
responses are constant-size schemas, do not copy request payloads, and use a
separate emergency category capped below 3 MiB. Business responses cannot
reserve that category.

`tryReserveComposite` atomically evaluates the parent cap, admission ceiling,
and every requested category watermark. Leases can be split, transferred,
shrunk, grown with a non-waiting attempt, and released idempotently. A lease is
tagged with its category and optional workspace/runtime/channel generation.

Heap proxy charging includes all simultaneously retained representations:

- buffer bytes;
- two bytes per JavaScript string code unit;
- 96 bytes per object/array node;
- 16 bytes per property or array slot;
- raw, decoded, parsed, encoded, and base64 copies while they coexist.

The initial policy is:

| Resource                    |                                                   Limit |
| --------------------------- | ------------------------------------------------------: |
| Daemon heap proxy           |                                                 512 MiB |
| Normal admission ceiling    |                                                 384 MiB |
| Completion reserve          |                                                 128 MiB |
| Emergency response pool     |                                                 < 3 MiB |
| Runtime baseline            |                                                   1 MiB |
| Root session baseline       |                                                 256 KiB |
| ACP connection baseline     |                                                  32 KiB |
| WebSocket active + pending  |                                                      32 |
| WebSocket assembly          |                                                 256 MiB |
| Parsed inbound              | 128 MiB global / 32 MiB and 256 messages per connection |
| Prepared outbound           |                                   256 MiB / 4096 frames |
| Prompt                      |                     48 accepted globally, 5 per session |
| Completed replay/cache      |                                                 128 MiB |
| Background jobs             |                                                  64 MiB |
| Voice retained data         |                                                 128 MiB |
| Buffered process output     |                                                 128 MiB |
| Fan-out snapshots           |                                                  32 MiB |
| Settings source per scope   |                                                   8 MiB |
| Session organization store  |                                                   8 MiB |
| ACP pending client requests |                              256 / 8 MiB per connection |
| Generation stream queue     |                          128 frames / 8 MiB per request |
| Session shell output        |                                                   8 MiB |
| Early child events          |      64 sessions / 32 each / 8 MiB per channel retained |
| Daemon log directory scan   |                                            4096 entries |

Category limits are watermarks, not partitions. The parent and completion
reserve still apply when the category limits sum to more than 512 MiB.

## Bounded Protocols

### HTTP and JSON

HTTP JSON bodies remain limited to 10 MiB and accept only identity
`Content-Encoding`. A JSON request reserves the parser ceiling before body
collection, then shrinks or non-blockingly grows the lease to the inspected
raw/decoded/parsed heap estimate before `JSON.parse`.

Generic JSON is limited to depth 64, 10,000 nodes, and 1 MiB per string.
Prompt, file, and voice routes use fixed schema profiles that allow their
documented large fields. Protected routes encode with a bounded canonical JSON
encoder that rejects accessors, `toJSON`, cycles, `BigInt`, and non-plain
objects unless the endpoint normalizes them first.

### WebSocket and NDJSON

ACP and CDP WebSocket frames are limited to 8 MiB. Voice retains its existing
10 MiB frame contract. Compression is disabled. The global active-plus-pending
WebSocket cap is 32 and remains active when the listener connection cap is
disabled. ACP, CDP, and voice message handling uses a FIFO with explicit
message-count and retained-byte admission; daemon-owned frames also reserve
the shared ingress category until handling settles.

Parent-to-channel-worker webhook IPC permits 64 pending tasks and 16 MiB of
serialized pending data. Success, failure, timeout, worker exit, and shutdown
all release the same accounting.

The internal ACP NDJSON frame limit is 64 MiB including the line terminator.
The reader is pull-driven, keeps at most one parsed message queued, and charges
raw chunks, concatenation copies, parsed heap estimates, and outbound encoding
copies. It counts chunks before concatenation, decoding, and parsing. Outbound
messages are structurally inspected and measured before `JSON.stringify`, so
escaping cannot allocate past the declared frame budget; unsafe JSON objects
are rejected without invoking their accessors or `toJSON`. Incomplete EOF is
fatal on daemon-managed streams. Malformed input diagnostics contain only size
and a bounded SHA-256 fingerprint.

Streamable HTTP transfers the parsed-body lease to each accepted post-response
dispatch before returning 202 and limits a semantic connection to 256
in-flight dispatches. The lease remains charged until dispatch settles rather
than being released with the acknowledgement response.

Public `ndJsonStream` defaults stay source compatible. Daemon callers opt into
the frame/structure limits, resource leases, and fatal EOF behavior. Existing
payload-byte hooks keep their meaning; an additive wire-byte hook includes
CR/LF.

### Delivery ownership

Transport send operations resolve to `delivered`, `closed`, or `failed`:

- HTTP delivery completes on response `finish`;
- SSE delivery completes after the write callback or drain while the stream is
  still open;
- WebSocket delivery completes in the send callback.

These states cover local socket delivery, not an end-client acknowledgement.
Fresh session ownership follows:

`REQUEST -> OPERATION -> PENDING_DELIVERY -> OWNED | DISCARDED`

A provisional binding cannot prompt or appear in `ownedSessions`. Failed
delivery removes a fresh session and rolls back an existing attach.

## Event and Replay Protection

One event and one replay turn are limited to 8 MiB. The per-session ring is
bounded by both its configured count and an 8 MiB heap proxy. Completed,
rebuildable replay caches may use LRU eviction; workspace and session objects
may not.

Byte eviction sets a sticky
`requiresAuthoritativeReload { reason, anchor }`. It remains until an
authoritative restore or a new bus generation. Active turns use only lossless
coalescing. A turn over 8 MiB, 10,000 events, or its retained ceiling emits one
`turn_workset_too_large` terminal error and closes the exact channel
generation.

Explicit `historyPageSize` selects byte-paged mode and returns the newest
complete-turn suffix with `hasMore`, `anchorRecordId`, `byteLimited`, and
`limitBytes`. Omitting `historyPageSize` keeps legacy full mode: histories up
to 8 MiB are returned in full; larger histories fail atomically with
`session_replay_limit_exceeded`. They are never silently truncated.

## Session and File Protection

Daemon-managed `SessionService` instances receive a
`SessionLoadProtectionPolicy`:

- source snapshot: 32 MiB;
- physical line: 8 MiB;
- records: 100,000;
- depth: 64;
- nodes: 10,000 per record;
- single string: 8 MiB;
- retained decoded records/messages/artifacts: 128 MiB.

Restore acquires the writer barrier, records file identity and size, reads that
snapshot, and checks identity again. Replacement, shrinkage, and short reads
fail. Appends after the snapshot are ignored and reported as
`hasNewerData: true`. Managed resume performs one authoritative load and then
atomically initializes session data, goal runtime, recorder, and Gemini.

Session catalogs use bounded directory iteration instead of materializing all
names. A request inspects and matches at most 50,000 entries and retains only
the requested top-k page plus one. Head scans reuse the physical-line and file
identity checks. An oversized individual file is skipped with a truncation
diagnostic rather than failing the whole page.

Workspace path completion also streams directory entries. It inspects at most
4,096 entries and retains the lexicographically smallest 50 matching
directories.

Virtual subagent readers use the same bounded reader. Branch and rewind use
bounded snapshots, temporary files, and atomic rename. A post-commit delivery
failure is `outcome_unknown` and is not automatically retried. Export admits a
64 MiB representation before collection/formatting, then writes the bounded
encoded result to a mode-0600 temporary file. The spool permits four files and
256 MiB total.

## Scheduling and Lifecycle

`FairDaemonBulkScheduler` permits four global active operations, 128 waiting
operations, one active operation per workspace, and 16 waiters per workspace.
`FairDaemonSpawnScheduler` permits four active roots and 128 waiters. Buffered
child processes use four active slots, 128 waiters, and 128 MiB of retained
output. Queue entries have a 30-second deadline and an abort signal. A shared
execution context rejects nested and cross-lane acquisition while a scheduled
task is active.

The ordering is:

1. bounded ingress and authentication;
2. resolve and pin the runtime generation;
3. semantic singleflight;
4. acquire Spawn only at the actual root-fork point;
5. acquire generation/read lease, ordered archive keys, and session FIFO;
6. acquire Heavy only at the source/decode/format seam;
7. prepare the bounded result, release locks and lanes, then deliver.

Heavy code cannot call `ensureChannel`, acquire Spawn, or recursively acquire
Heavy. A channel failure fails the top-level operation without restarting
inside a state lock.

Every runtime owns a `WorkspaceResourceScope`. Its single disposal commit runs
registered cleanup callbacks, prevents late generation work from repopulating
generation-scoped state, and only then releases runtime and session baseline
leases. Runtime shutdown remains the owner of bridge, MCP, skills, goal,
authorization, and background-job state. The added disposer registry covers
module caches and queues that previously outlived runtime removal, including
settings mutation locks, transcript state, GitHub PR cache, and extension
controller state. Process-global canonical-path and telemetry memoization use
a fixed LRU of at most 64 entries.

Daemon settings reads use fixed snapshots capped at 8 MiB per system-default,
system, user, and workspace scope. The serve fast path applies the same cap to
settings, trust, and environment sources before parsing. The session
organization sidecar uses the same per-workspace cap, fixed-snapshot identity
checks, and generation disposal for its warning cache.

## Observe-Only Memory Status

The CLI adds:

- `--memory-pressure-mode <off|observe>`, default `off`;
- `--memory-budget-mb <positive-safe-integer>`.

Providing only a budget enables observe mode. Explicit `off` with a budget is
invalid. Phase 1 does not accept `enforce`.

A non-overlapping sampler runs every 15 seconds. It reports daemon process-tree
RSS and cgroup usage/limit as independent sources. Linux prefers cgroup data
for the pressure level and uses process-tree data for fallback or attribution.
Windows validates PID creation identity.

Levels are `normal <70%`, `soft >=70%`, `hard >=85%`, and
`critical >=95%`. Escalation is immediate. Recovery requires three consecutive
complete samples below the target boundary minus five percentage points.
Partial or stale samples may escalate but cannot recover a hard or critical
state.

The observer never invokes GC, LRU, session closure, channel reclamation, or
process termination. Existing child-local legacy policies remain unchanged
and are reported as such.

## Status and Errors

Status adds:

- `limits.maxTotalSessionsSource`;
- `limits.resourceGuards`, whose matrix names only paths that are fully wired;
- `limits.memory { mode, budgetBytes, enforced: false }`;
- `runtime.resourceBudget`;
- `runtime.memory`;
- `daemon_memory_pressure` and `daemon_memory_observation_stale` issues.

The legacy primary-only `childRssBytes` field remains. Additive fields report
child sum, maximum, unknown count, and bounded per-workspace attribution.

REST and ACP share:

```ts
interface DaemonResourceErrorData {
  errorKind: string;
  httpStatus: number;
  limitBytes?: number;
  observedBytes?: number;
  minimumBytes?: number;
  actualBytesKnown?: boolean;
  retryable: boolean;
}
```

Representation limits return 413. Resource and queue admission return 503 with
`Retry-After`. The existing workspace registration cap remains 409. Error
summaries are at most 1 KiB and never include the original large payload.

## Shutdown

The shutdown implementation builds on
[#7975](https://github.com/QwenLM/qwen-code/pull/7975). Root-owned POSIX
children use their own process group. Windows registrations retain PID and
creation identity and revalidate it before tree termination.

At shutdown entry the daemon synchronously seals listener, workspace/session,
Bulk, Spawn, Process, and process-registry admission. Runtime and bridge
cleanup then drains or aborts writers before the shared process registry
verifies owned process trees. Remaining children receive the registry's
graceful-close, TERM, rescan, and KILL sequence. Only after runtime/process
cleanup does the listener's five-second drain deadline force-close sockets; a
second two-second deadline turns a missing `server.close` callback into an
unclean error.

Unsettled resource leases, process-tree verification failures, writer/runtime
shutdown failures, or a stuck listener make shutdown unclean and produce a
non-zero exit. The strong guarantee covers daemon root-owned process groups.
Detached descendants created inside ACP remain a documented Phase 2 residual.

## Compatibility

The workspace and session count defaults do not change. Resource admission can
return 503 even when count caps are disabled. Other intentional changes are:

- global WebSocket cap 32;
- ACP/CDP frame cap 8 MiB, voice unchanged at 10 MiB;
- compressed JSON rejected with 415;
- large legacy replay fails with 413 unless byte paging is requested;
- replay count may be shortened by the byte cap;
- oversized active turns close their exact channel generation;
- slow clients and full queues fail deterministically;
- shutdown waits for writer/runtime cleanup before applying a bounded
  seven-second listener drain and terminates root-owned descendants.

Standalone ACP construction and public `ndJsonStream` defaults remain
unchanged.
