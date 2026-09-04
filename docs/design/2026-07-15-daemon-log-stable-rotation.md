# Stable and Bounded Daemon Logs

- **Status:** Implemented
- **Date:** 2026-07-15
- **Scope:** `qwen serve` file logging, lifecycle ownership, access-log admission, daemon status, and the TypeScript SDK status mirror

## Decision

Each runtime log namespace has one stable active path:

```text
${runtimeBaseDir}/debug/daemon/daemon.log
```

Normal restarts append to that path. The fixed policy is:

| Limit                                 |        Value |
| ------------------------------------- | -----------: |
| Active file                           |       10 MiB |
| Archives per family                   |            4 |
| Rendered file record                  |      256 KiB |
| Accepted but unsettled file payload   |        4 MiB |
| Stable lease stale/update             |  60 s / 10 s |
| Stable/maintenance acquisition budget | 1 s / 250 ms |
| Public logger close budget            |          2 s |

These values are intentionally not CLI flags, environment variables, or settings. A healthy stable family occupies at most about 50 MiB. Retaining the most recent inactive fallback family brings the converged namespace to about 100 MiB. Live or not-yet-stale fallback owners are never deleted, so temporary use can grow with the number of possibly live daemons.

Every start generates a random 128-bit `runId`. Every file record begins with immutable `runId` and daemon PID context. Caller context cannot replace those values. Stderr keeps the existing formatting and field order.

## Namespace and ownership

The configured log directory is the ownership and retention namespace. Workspace, listener port, and PID are not storage identities: a daemon can host several workspaces, port zero is dynamic, ports can advance on conflict, and embedded daemons can share a PID.

The stable family is owned by a lifetime `proper-lockfile` lease. A contender that cannot acquire it writes to:

```text
debug/daemon/runs/run-<32-hex-runId>/daemon.log
```

It holds that family's `.owner.lock` for its lifetime and never promotes into the stable family during the run. The boot banner and full daemon status are authoritative for the selected path. `runs/recent-fallback` is only a validated discovery hint.

Fallback allocation and cleanup are serialized by `runs/.maintenance.lock`. Cleanup retains every busy owner family and at most one inactive family. It prefers a valid locator, then the newest active-log mtime, then basename as a deterministic tie-breaker. A non-lock cleanup error or failed deletion rejects the allocation so a damaged namespace does not accumulate a new directory on every start.

Clean fallback close acquires maintenance ownership, releases its owner lease, retains the current family, removes other inactive families, and repairs the locator. If maintenance ownership is unavailable, close releases only the owner lease and leaves repair to a later start.

## Filesystem layout

```text
debug/daemon/
├── daemon.log
├── latest -> daemon.log
├── .stable-writer.lock/
├── archive/
│   └── daemon-000000000001-20260715T031415926Z-a1b2c3d4.log
└── runs/
    ├── .maintenance.lock/
    ├── recent-fallback
    └── run-6a45c211000000000000000000000000/
        ├── .owner.lock/
        ├── daemon.log
        └── archive/
```

Only strictly matching regular archive files participate in retention. Legacy `serve-<pid>.log` and `serve-<pid>-<workspaceHash>.log` files are neither migrated nor deleted.

New directories use mode `0700`; new active logs and locator temporary files use `0600`. Existing object permissions are not rewritten. `latest` is updated only by a successful stable owner and remains best-effort where symlinks are unavailable.

## File records and queue

File records are truncated on a valid UTF-8 boundary. The final record, including an original-byte-count marker and newline, is at most 256 KiB. Its stderr copy is not truncated.

One Promise queue preserves file mutation order. Accepted but unsettled record bytes are accounted synchronously. A record that would raise the queue above 4 MiB loses only its file copy; the logger increments `droppedRecords` and `droppedBytes` and warns once for that overflow episode.

After capacity recovers, the next caller record is preceded by a file-only warning named `daemon file log records dropped`. It reports the unreported record and byte totals and does not recursively contribute to them. Close makes one final attempt after draining the queue.

Each queue task catches its own failure and releases its pending-byte accounting in `finally`; the shared tail never remains rejected. If an active append rejects, its result is unknown: the logger records `write_failed`, stops all subsequent file mutation for that run, and does not claim the failed record as an exact loss. Later records that are deliberately skipped are counted.

Lease compromise likewise stops new file mutations immediately. A single filesystem operation that already started may finish, but no later append, rotation, or deletion starts through that family.

## Rotation transaction

Before a record would make the active file exceed 10 MiB, the logger:

1. verifies that `archive/` is a real, non-symlink directory;
2. removes the oldest generated archives until at most three remain;
3. chooses a nonexistent name containing a 12-digit generation, UTC timestamp, and random suffix;
4. atomically renames the active path to that archive name;
5. appends the triggering record to a new `daemon.log` with mode `0600`; and
6. commits the in-memory size and generation state.

Thus a family produced by this implementation has at most one active file and four archives. If the new-active append fails, the previous active file remains complete in the newest archive.

Archive validation, pruning, naming, or rename failure drops the record rather than allowing the active file to cross 10 MiB. Rotation is retried at most once per 60 seconds while smaller records that still fit may continue. There is no special ENOSPC/EDQUOT deletion-and-retry protocol and no rejected-append truncate rollback because neither can prove the file's resulting state.

Initialization reads the active file's real size. If its last byte is not a newline and the boot record does not first rotate it, the logger inserts a newline and marks the boot record with `previousTailIncomplete=true`. If the stable boot probe cannot safely write, it releases the stable lease and attempts one fallback family. A failed fallback probe yields degraded stderr-only logging.

## Logger state and lifecycle

```ts
type DaemonLogMode = 'stable' | 'fallback' | 'stderr-only';
type DaemonLogHealth = 'ok' | 'degraded';
type DaemonLogIssue =
  | 'init_failed'
  | 'rotation_failed'
  | 'retention_failed'
  | 'queue_overflow'
  | 'write_failed'
  | 'lease_compromised';
```

`getStatus()` returns the run identity, mode, health, ordered issues, and loss counters. `QWEN_DAEMON_LOG_FILE=0|false|off|no` returns a healthy stderr-only logger without accessing the filesystem: `info`, `warn`, and `error` still write stderr, while `raw` remains file-only and therefore does nothing.

`close()` is idempotent and non-rejecting. It synchronously stops accepting file copies, while structured stderr calls remain usable. Its background finalizer drains the queue, attempts the final loss summary, performs fallback cleanup, and releases the lifetime lease. The public Promise waits at most two seconds; a timeout does not release the lease early, and the finalizer remains alive until started I/O settles. `flush()` keeps its unbounded queue-snapshot semantics. Forced signal paths and retryable resource-close failures race it against 250 ms.

Logger ownership moves through:

```text
startup -> published handle -> terminal close
       \-> startup signal -> terminal close
```

An internal close before handle publication drains daemon resources without waiting for the logger queue, then leaves the logger to the outer startup-error owner. That owner records `daemon startup failed` and closes it. A terminal published or signal-owned close seals access logging, records `daemon stopped`, and closes the logger even when resource shutdown returns a non-retryable error; the original resource error remains the returned error. Terminal diagnostic writes are best-effort so an unavailable stderr cannot replace the original failure or skip logger cleanup. A retryable channel-worker/service-lease failure keeps the logger open, uses the bounded flush above, and does not record `daemon stopped`.

## Access-log admission

Each runtime Express app owns a constant-space token bucket with burst 60 and refill 2 records/second, measured with a monotonic clock. Clock retreat never moves the refill baseline backward. Health, heartbeat, and successful SSE exclusions are unchanged.

Route, session ID, and the first raw `x-qwen-client-id` occurrence are capped at 2 KiB, 256 bytes, and 256 bytes on UTF-8 boundaries. Truncated values carry an original-byte-count context field. Using the first raw header avoids merged duplicate headers becoming a new cardinality source.

When no token is available, only five fixed counters are retained: 2xx, 3xx, 4xx, 5xx, and other. On recovery a WARN `access logs suppressed` summary consumes the next token before any individual record. If that was the only token, the current request joins the next summary. Shutdown seals the controller after normal listener drain or the secondary deadline, emits a final summary, ignores late finish callbacks, and then records `daemon stopped`.

Rate limiting affects diagnostics only; it never changes the HTTP result. Suppressed individual records reach neither stderr nor file, while summaries reach both.

## Daemon status and SDK

Each status response takes one logger snapshot. Summary and full responses may contain:

- `daemon.runId`
- `daemon.logMode`
- `daemon.logHealth`

Full responses may additionally contain `daemon.logPath`, `daemon.logIssues`, `daemon.logDroppedRecords`, and `daemon.logDroppedBytes`. Degraded logging adds a path-free top-level `daemon_log_degraded` warning to the existing rollup. The TypeScript SDK mirrors the optional fields and closed unions. No capability tag or client upgrade is required.

Opt-out reports `stderr-only/ok`; ordinary stable contention reports `fallback/ok`; filesystem initialization failure reports degraded logging with `init_failed`.

## Operational and compatibility boundaries

- Use separate runtime directories for independent retention or audit namespaces.
- On macOS/Linux use `tail -F daemon.log`; on every platform, viewers must reopen the pathname after rotation.
- Do not configure external logrotate to mutate `daemon.log`. Copying or shipping it is safe; renaming, truncating, or deleting it breaks the in-memory size model.
- There is no age expiry, compression, fsync durability, or absolute bound during concurrent-daemon or crash-restart storms inside the stale window.
- Same-user tampering, false stale takeover, filesystem calls that never return, sudden power loss, and Windows readers that prevent rename are handled by safe degradation, not by platform-specific no-follow, fsync, or process-admission protocols.
- Downgrading remains possible; older versions simply resume creating PID-named files.

## Verification strategy

Unit coverage includes formatting, immutable file context, stable reuse, UTF-8 truncation, rotation bounds, incomplete tails, queue overflow summaries, poisoned appends, active and post-release compromised leases, bounded close and retry flushes, stable/fallback concurrency, fallback retention, cleanup refusal, lifecycle diagnostic failures, access token admission, shutdown sealing, status snapshots, isolated test runtime namespaces, and SDK type surface.

Process-level verification uses a built bundle and isolated runtime directory for restart reuse, real-threshold rotation, stable/fallback concurrency, signal lease release, SIGKILL stale-window behavior, access aggregation, legacy-file preservation, and opt-out without filesystem access. The CI platform matrix must exercise direct active paths on macOS, Linux, and Windows; Windows additionally verifies safe degradation when a reader prevents active/archive rename.
