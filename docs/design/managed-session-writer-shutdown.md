# Managed session writer shutdown

## Problem

A managed `qwen serve` replacement can start on a new hostname while the
previous ACP child still owns a session writer lock. A foreign-host v1 lock
cannot be proven stale, so the replacement correctly returns
`session_writer_conflict`. Reclaiming by hostname or age would allow two live
Pods to write the same transcript.

## Scope

This P0 makes cooperative managed shutdown release writer locks before the
parent's SIGKILL deadline. It does not add sealed handoff records, takeover
claims, TTL or hostname stealing, platform fencing, maintenance leases, or
automatic recovery after SIGKILL, an event-loop stall, or a storage failure.
Historical foreign-host locks still require an external writer fence and
manual cleanup.

Only an ACP child that validates the existing private parent capability uses
the managed path. Standalone ACP keeps its existing shutdown and local stale
owner recovery behavior. Managed acquisition never reclaims an existing lock
from PID visibility because container PID namespaces make that proof unsafe.

## Writer terminal

Writer close is single-flight and closes public recording admission
synchronously. Normal close finalizes metadata before closing and waits for
accepted work. Managed fast close does not wait for an active model turn and
does not append an additional finalize record; it drains only recorder work
accepted before the cutoff.

A flush failure seals the writer and is still reported after an exact-owner
release attempt, preserving the pre-existing close contract. An ownership or
release failure retains the primary lock unless release already committed. The
only release commit is a same-directory rename from the primary lock `P` to an
owner-unique retired path `R`. The old owner may clean only its exact `R`; it
never retries the primary rename or touches a successor's `P`. Managed
shutdown emits an operator-visible warning with candidate lock paths when the
writer terminal fails. Manual cleanup is safe only after verifying that the
previous writer is no longer running.

## Managed ACP shutdown

The first shutdown action closes session creation and turn admission and
snapshots active, initializing, and deferred-cleanup writer-capable Config
instances. All writer terminals start before the first await and run in
parallel. SessionEnd hooks run after the writer phase, while Config resources
are still available. Resource cleanup then runs with the remaining time.

The child exits zero only when every writer terminal is clean. A lock may have
been released while later hook or resource cleanup still makes the overall
shutdown unclean.

### Config resource quiescence

Writer shutdown and Config resource shutdown are separate terminals. Writer
close still starts before the first managed-shutdown await. Resource cleanup
then joins any in-flight `Config.initialize()` before inspecting and stopping
resources, so initialization cannot create a watcher, tool registry, or MCP
manager after cleanup has already returned.

Config initialization is sealed once shutdown starts, and resource cleanup is
single-flight across managed shutdown and concurrent request-failure cleanup.
The full `shutdown(options)` call is not single-flight because writer and
telemetry options remain call-specific.

An incompletely initialized Config fast-closes its writer before joining
initialization. A successfully initialized Config retains the normal
finalize, flush, and close order. Initialization join has no local timeout:
timing out the wait would leave the underlying initialization running and
reintroduce late resource creation. The daemon process deadline remains the
hard bound, after writer release has already completed or failed explicitly.

## Parent process lifecycle

Each daemon handle owns one process registry shared by primary, secondary, and
dynamic workspace channel factories. Spawn reservation and the shutdown seal
compete synchronously. A successful spawn is attached to the registry in the
same turn.

An error before Node's `spawn` event with no PID is `no_process`; after spawn
confirmation, only raw `exit` proves reaping. Post-spawn channel construction
failure immediately SIGKILLs the unpublished child and joins the channel
terminal before returning the construction error. After a channel factory
returns, the bridge owns the channel before constructing or publishing its full
ChannelInfo.

Daemon shutdown uses one monotonic process-registry timeline: SIGTERM at `t0`,
stable unclean shutdown if the child exits nonzero or by signal, SIGKILL at
`t0 + 5s`, and stable `not_reaped` failure at `t0 + 10s`. A zero exit is the
managed child's cooperative writer-terminal acknowledgement; raw exit alone
proves only reaping. The registry deadlines never restart, and a late raw exit
cannot change its failed terminal to success. The daemon retains its existing
retry path for an independently managed channel worker that later becomes
reapable; such a retry joins the same settled ACP process-registry terminal
rather than starting a new ACP shutdown timeline.

The parent deadline intentionally does not expand to match SessionEnd hook,
Config initialization, or MCP cleanup budgets because the platform
termination window may be shorter and outside the daemon's control. Those
post-writer phases use the time remaining after writer release and may be
interrupted, producing an unclean daemon exit without restoring the released
writer lock. Only an unconfirmed channel-worker exit keeps the daemon alive for
a second graceful-shutdown attempt; other ACP or bridge failures exit nonzero
on the first signal.

## Compatibility and rollout

The private capability and public ACP/REST payloads do not change. A custom
asynchronous ChannelFactory is covered only after it resolves an AcpChannel;
the default managed factory is covered from spawn reservation onward.

Mixed-version writer operation remains unsupported. Deployment and rollback
must drain old ACP writers before the replacement accepts sessions.

## Verification

Verification must distinguish:

1. lock released and the whole daemon shutdown is clean;
2. lock released but later cleanup makes shutdown unclean; and
3. lock retained, successor receives 409, and manual recovery remains
   required.

Required deterministic coverage includes flush failure, rename
error-after-effect, successor acquisition, normal-to-fast close, acquisition
at every cutoff boundary, async `ENOENT` spawn failure, post-spawn error,
partial channel construction, pre-resolved channel exit with a buffered
initialize response, D1/D2 and raw-exit races, late exit, two signals,
multi-runtime parallel shutdown, shutdown during Config initialization,
concurrent Config cleanup, initialization after shutdown admission, standalone
ACP, and mixed-version rollout guardrails.
