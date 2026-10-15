# ACP child process tree reaping

Status: implemented for PR2

Proposed PR title: `fix(acp-bridge): Reap ACP child process trees`

## Problem

`createSpawnChannelFactory()` starts each `qwen --acp` process without an
isolated process group. `ProcessRegistry` then sends `SIGTERM` and `SIGKILL`
only to that direct child. When the ACP process has started hooks, shell
commands, MCP servers, or other grandchildren, terminating the channel can
leave those descendants running after the ACP root exits.

The failure is not limited to the graceful path. `killSync()` also signals only
the root, and `ProcessRegistry` removes an entry as soon as the root emits
`exit`. A later shutdown or second signal therefore cannot reach descendants
that outlived the root.

A real-process baseline on macOS reproduced all of these cases:

| Path             | Descendant                    | Baseline result                                                                    |
| ---------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `terminate()`    | ordinary grandchild           | Root was killed after the 5 second grace period; grandchild survived under PPID 1. |
| `terminate()`    | grandchild in its own session | Root was killed; grandchild survived under PPID 1.                                 |
| `killSync()`     | ordinary grandchild           | Root was killed immediately; grandchild survived under PPID 1.                     |
| `killSync()`     | grandchild in its own session | Root was killed immediately; grandchild survived under PPID 1.                     |
| root exits first | either form                   | The registry had already released the entry, so later termination was a no-op.     |

An isolated root process group fixes the ordinary-grandchild cases, including
an ordinary grandchild that remains in the group after the root exits. It does
not fix a descendant that called `setsid()` or otherwise created a separate
group. Such a descendant is discoverable from a process-table snapshot while
the root lineage is still intact, but not after it has been reparented.

## Scope

This PR owns the ACP child lifecycle inside `packages/acp-bridge`:

- establish the ownership boundary when the standard spawn factory creates an
  ACP child;
- terminate the owned tree on every existing channel teardown path;
- retain enough cleanup state for the asynchronous graceful path and the
  synchronous second-signal path;
- preserve the existing `AcpChannel.exited` meaning and all bridge decisions
  about when a channel should be killed.

It does not change HookRunner cancellation, endpoint deadlines, request
abort propagation, session ownership, idle-channel policy, or bridge routing.
Those are separate PR boundaries. PR2 does not depend on a private helper from
the HookRunner change, so both PRs can be developed independently.

## Lifecycle contract

The implementation must preserve these invariants:

1. `AcpChannel.exited` reports the raw ACP root exit exactly as it does today.
   Descendant cleanup must not delay session-death observation.
2. `AcpChannel.kill()` resolves only after the owned tree is gone. It rejects
   when the root exits uncleanly or cleanup cannot be confirmed within the
   existing 10 second deadline.
3. `AcpChannel.killSync()` dispatches the strongest available tree kill before
   returning. It cannot wait because the daemon calls it immediately before a
   forced process exit.
4. Concurrent `kill()`, registry shutdown, transport-failure teardown, and
   `killSync()` calls are idempotent.
5. The registry adds a process group only from the isolated root or a validated
   snapshot of that root's current lineage; it never expands ownership from a
   historical PID after the root exits.
6. Existing external users of `ProcessRegistry` retain direct-child behavior
   unless they explicitly mark an attached child as a tree owner.

## Design

### Declare ownership at attachment

Add optional ownership metadata to `ProcessReservation.attach()`. The default
remains direct-child tracking. The standard spawn factory marks only the child
it created as an owned process-tree root.

On POSIX, marking a child as tree-owned requires the caller to have spawned it
as an isolated process-group leader. On Windows, the same metadata authorizes a
`taskkill /T` operation rooted at that PID. Keeping this opt-in avoids treating
an arbitrary publicly attached child as a group leader and accidentally
signalling the host's process group.

No `AcpChannel`, bridge, or daemon API changes are needed.

### Establish a POSIX process group

`createSpawnChannelFactory()` sets `detached: true` on non-Windows platforms.
The ACP root PID then becomes its process-group ID and session ID. Its stdio
remains piped and the child is not `unref()`ed, so the channel's transport and
lifecycle ownership do not change.

Isolation does change terminal-signal inheritance: a POSIX signal sent to the
host's foreground process group no longer reaches the ACP child automatically.
`qwen serve` therefore routes `SIGHUP`, as well as `SIGINT` and `SIGTERM`,
through the existing graceful and second-signal shutdown state machine.
Embedders remain responsible for calling `AcpChannel.kill()` or `killSync()`
from their own host lifecycle. An untrappable host crash such as `SIGKILL`
cannot run either cleanup path and remains outside this portable fix.

Windows keeps `detached` disabled and uses the native process-tree operation
described below.

### Snapshot before the first signal

For a tree-owned POSIX child, `terminate()` first takes one bounded process
table snapshot containing PID, PPID, and PGID. It walks descendants in memory,
and records each unique process group. The root group is always included from
the spawn-time isolation contract, even if the snapshot helper is unavailable.
Snapshot groups are accepted only when the root row still exists and confirms
that the root is its own process-group leader. If a present root row contradicts
that contract, even the provisional root group is discarded and teardown falls
back to signalling the direct child.

The snapshot must happen before any signal is sent. Killing the root first can
reparent descendants to PID 1 and destroy the only portable ownership evidence
for a descendant that left the root group.

The helper stays private to `acp-bridge`, with bounded runtime, output, depth,
and process count. It invokes `/bin/ps` directly rather than resolving `ps`
through the inherited `PATH`, because the returned PGIDs authorize later
signals. If that trusted path is unavailable, snapshot failure follows the safe
root fallback instead of executing an untrusted replacement. Re-exporting the
existing Core PID helper would widen PR2 into a cross-package public API change
and still would not provide PGIDs or the synchronous snapshot required by
`killSync()`.

### POSIX termination state machine

`terminate()` uses the existing 5 second grace and 10 second total deadline:

1. Mark termination active and memoize the returned promise.
2. Snapshot the still-owned lineage and merge its PGIDs into the tracked
   ownership set.
3. Send `SIGTERM` to each owned process group, with the root group last. Use a
   direct-child signal only as a fallback for the ACP root itself.
4. Wait for both the raw root exit and disappearance of every known group.
   Root exit alone is not completion while a group remains.
5. At the grace deadline, if the original root is still alive in its isolated
   group, take one more bounded snapshot rooted only at that root, merge any
   newly visible descendants, and send `SIGKILL` to every surviving owned
   group, followed by the direct-root fallback. Once the root exits, never
   expand ownership from historical PIDs because the operating system can
   reuse them for unrelated processes.
6. Resolve after the root and owned members are gone. At the total deadline,
   reject with the root PID, surviving groups, and any snapshot failure.

After the root exits and KILL has been dispatched, process-group liveness is
supplemented with a bounded process-state snapshot. This handles Linux PID 1
environments that do not reap adopted grandchildren: a zombie can keep its
PGID addressable even though it can no longer execute. A known group is removed
only when the snapshot observes members for that group and every observed
member is terminal. An absent group, an unknown state, or a failed query stays
live. On Linux, a zombie leader with more than one thread also stays live,
because other threads can still execute after the leader exits.

`ESRCH` means a PID or group is already gone. `EPERM` means it still exists and
cleanup is not confirmed. Timers and liveness polling remain referenced while
`kill()` is pending; an unresolved promise does not by itself keep Node alive
after the ACP root exits.

Termination state is monotonic. A synchronous force-kill sets a
`forceKillRequested` state before taking its snapshot. The asynchronous path
checks that state after every awaited snapshot or timer and can only advance
from TERM to KILL; it must never send a later TERM after `killSync()` has
already escalated the tree. Registry release is also guarded so concurrent root
exit, `terminate()`, and `killSync()` paths invoke it exactly once.

The raw root exit and registry release become separate events. During explicit
termination, root exit settles `AcpChannel.exited` but the tree-owned registry
entry remains until cleanup settles, so `killAllSync()` can still strengthen an
in-progress shutdown. A root that exits unexpectedly triggers an immediate
best-effort synchronous kill of its known root group before the entry is
released. If termination begins while that cleanup is still in progress, it
waits for the known groups rather than treating the raw root exit as tree
completion.

If the initial snapshot is unavailable or truncated, the implementation still
kills the isolated root group but must not silently claim complete coverage of
separate descendant groups. After dispatching the safe fallback,
`terminate()` rejects because full cleanup could not be proven. `killSync()`
has no error channel, so it records no stronger guarantee than best-effort
dispatch.

If the root disappears before a valid initial snapshot can establish the
lineage, the asynchronous path applies the same unverified-cleanup result. The
second snapshot narrows ordinary spawn races during the grace period, but this
mechanism is lifecycle cleanup rather than a security sandbox: it cannot stop
an adversarial process from double-forking out of the observed lineage.

### POSIX synchronous force-kill

`killSync()` takes a bounded synchronous PID/PPID/PGID snapshot before it
signals the root. It merges that snapshot with groups already recorded by an
in-progress `terminate()`, sends `SIGKILL` to every known owned group with the
root group last, and then attempts the direct-root fallback. After root exit it
does not enumerate again, but still signals groups proved by an earlier
snapshot.

The synchronous helper shares parsing and ownership validation with the
asynchronous helper but uses `spawnSync()` with a short timeout. If enumeration
fails, it still kills the isolated root group. The method guarantees dispatch,
not observation of process exit, and then returns immediately for the daemon's
second-signal handler.

### Windows tree termination

Windows does not have POSIX `SIGTERM` semantics. The asynchronous `terminate()`
path starts the trusted absolute executable
`%SystemRoot%\\System32\\taskkill.exe` with `/F /T /PID <rootPid>` and waits for
that operation before using direct-child force-kill as a failure fallback. It
then waits for the root exit within the existing total deadline. The taskkill
invocation itself is bounded and cannot outlive that deadline. This path does
not pretend to provide a TERM grace period.

`killSync()` uses `spawnSync()` with the same absolute path and flags so
`taskkill` enumerates the tree before the daemon exits. It then attempts the
direct-child `SIGKILL` fallback if taskkill could not be launched or returned a
failure. A bare `taskkill` command is not allowed because Windows resolves it
through the current directory and `PATH`.

### Direct-child compatibility

An attachment without tree ownership keeps the current behavior:

- root `exit` releases the registry entry;
- `terminate()` signals only the direct child;
- `killSync()` signals only the direct child;
- reservation and committed-process accounting remain source compatible.

For a tree-owned child, committed-process accounting extends through explicit
tree teardown rather than ending at raw root exit. This continues the existing
admission invariant: a winding-down child remains counted while its owned
processes may still hold memory.

## Failure semantics

- Repeated and concurrent teardown calls share one asynchronous state and may
  safely receive an additional synchronous force-kill.
- A clean root exit is not sufficient while a known descendant group remains.
- A non-zero or signalled root exit during shutdown remains an unclean-shutdown
  error after descendant cleanup, preserving current behavior.
- Snapshot, `ps`, or `taskkill` failure always falls back to the strongest safe
  root operation. The reported error includes the failed mechanism when full
  cleanup cannot be confirmed; registry shutdown continues to aggregate child
  failures.
- Process-table parsing accepts only positive safe-integer PID/PGID rows,
  deduplicates cycles, and never signals the host's own process group.
- A process-state query failure is conservative. Zombie-only groups can be
  released after KILL, but a group with any live member is retained.

## Platform limit

Portable PID/PPID/PGID enumeration cannot recover a descendant that established
a separate session and then lost its ancestry because the ACP root exited
before cleanup began. Windows PID-tree enumeration has the same root-first
race. Absolute containment for that case needs a Linux cgroup, Windows Job
Object, or another OS supervisor.

This PR therefore guarantees cleanup of the isolated root group and of separate
groups that are still discoverable when cleanup starts. It must not claim to
reap an already-daemonized process whose ownership evidence disappeared before
teardown. As with any PID/PGID-based lifecycle cleanup, OS identifier reuse
leaves an irreducible check-to-signal race; stronger identity and containment
require an OS supervisor. Adding that containment is intentionally out of
scope for this minimal fix.

## Implementation surface

Production changes should remain limited to:

- `packages/acp-bridge/src/process-registry.ts` for ownership state, bounded
  snapshots, platform termination, and registry release;
- `packages/acp-bridge/src/spawnChannel.ts` for POSIX `detached` spawning and
  the ownership marker;
- `packages/cli/src/serve/run-qwen-serve.ts` for routing `SIGHUP` through the
  existing daemon shutdown state machine;
- at most a contract clarification in `packages/acp-bridge/src/channel.ts`.

No new dependency, shared process-manager abstraction, Core export, or bridge
production change is required.

## Verification

### Unit and contract tests

- Legacy `attach(child)` retains direct-child semantics.
- The standard factory uses `detached: true` on POSIX and not on Windows.
- PID/PPID/PGID parsing is bounded, cycle-safe, and deduplicated.
- POSIX TERM, grace, resnapshot, and KILL target all owned groups.
- Root exit does not resolve `kill()` while an owned group is alive.
- Linux zombie-only groups settle after KILL, while `Z` leaders with live
  threads and groups with any non-zombie member stay committed.
- `ESRCH`, `EPERM`, missing PID, spawn errors, snapshot failures, and deadlines
  follow the declared semantics.
- Concurrent `terminate()` calls, registry shutdown, and `killSync()` remain
  idempotent.
- A root-exited tree remains reachable by `killAllSync()` during explicit
  teardown.
- Windows uses the absolute System32 path, exact `/F /T /PID` flags, and a
  direct-child fallback on launch or exit failure.
- Multiple children are all attempted and failures remain aggregated.
- `qwen serve` routes `SIGHUP` through graceful cleanup, keeps the listener for
  second-signal escalation during drain, and removes it after shutdown.

### Real-process tests

On POSIX, an ACP-like root starts both an ordinary grandchild and a grandchild
that creates a separate session. Both ignore `SIGTERM`. Exercise `terminate()`,
`killSync()`, and root-first timing independently, assert the documented
guarantees and platform limit, and clean every recorded PID in `finally`.

### Bridge and daemon regression

Existing teardown decisions must continue to converge on the tree-aware
channel operation for channel-construction failure, initialization failure,
empty session creation, transport failure, normal daemon shutdown, and the
second signal. A single session failure on a shared channel must not kill that
channel while another session still owns it.

Focused implementation verification:

```bash
(cd packages/acp-bridge && npx vitest run src/process-registry.test.ts src/process-registry.process.test.ts src/spawnChannel.test.ts)
(cd packages/cli && npx vitest run src/serve/run-qwen-serve.test.ts)
npm run build
npm run typecheck
npm run lint
git diff --check
```
