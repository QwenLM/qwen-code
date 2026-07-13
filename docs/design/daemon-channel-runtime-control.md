# Daemon Channel Runtime Control

## Summary

Add runtime desired-state control for daemon-managed channel workers. A daemon
may start without `--channel`, then enable, replace, inspect, reload, and stop
its channel selection without restarting the daemon. Runtime changes are not
persisted; the next daemon boot still follows `--channel`.

The control layer sits above the workspace-grouped worker implementation. It
owns the committed selection, serializes lifecycle mutations, preserves the
serve-owned channel-service lease, and reconciles only workspace groups whose
ordered selection changed.

## Public contract

`GET /workspace/channel` returns the committed selection, an optional pending
selection, the current transition, and workspace-annotated worker snapshots.

`PUT /workspace/channel` accepts:

```json
{ "selection": { "mode": "names", "names": ["telegram", "feishu"] } }
```

or `{ "selection": { "mode": "all" } }`. Named selections are trimmed and
deduplicated without sorting. An empty selection is invalid. `all` remains
primary-workspace-only in multi-workspace mode.

`DELETE /workspace/channel` idempotently disables the runtime selection.
`POST /workspace/channel/reload` remains available and re-reads settings for
the committed selection. Mutations use the strict bearer-token gate.

The `channel_control` capability advertises the resource. `channel_reload`
continues to advertise only while the manager has a committed, reloadable
selection.

## Lifecycle

The manager exposes immutable snapshots and sends all mutations through one
FIFO lane. A selection update preflights workspace ownership and trust before
stopping workers. Unchanged workspace entries are retained. Changed and
removed entries stop before replacements start, while the daemon keeps the
global channel-service lease.

If a replacement fails, the manager attempts to stop newly started entries and
restart the previous entries. Clients inspect `rolledBack`, `rollbackError`,
and `state` because cleanup or restoration can also fail. A failure to observe
child exit after SIGKILL is a hard stop failure: the supervisor retains the
child reference, the manager retains the service lease, and no replacement is
spawned.

Worker callbacks carry a generation. Callbacks from replaced entries may log,
but cannot update current pidfile or routing state. A successful commit swaps
the selection, webhook configuration, and worker map together, then rewrites
the complete pidfile snapshot.

Partial adapter connection preserves existing behavior: a worker is ready when
at least one requested channel connects. Control results report `partial`, and
daemon status continues to emit `channel_worker_partial_connect`.

## Compatibility

Boot-time `--channel` uses the same manager while retaining pre-listen lease
reservation and ready-before-success behavior. Without `--channel`, the daemon
does not reserve the channel service or load the heavy channel runtime until
the first runtime mutation.

Legacy `runtime.channelWorker`, grouped `runtime.channelWorkers`, pidfile
fields, standalone `qwen channel start`, and `qwen channel reload` remain
compatible. New CLI control is exposed through `qwen channel set`, plus remote
variants of channel stop and status.
