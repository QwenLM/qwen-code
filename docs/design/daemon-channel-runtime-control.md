# Daemon Channel Runtime Control

[English](daemon-channel-runtime-control.md) | [简体中文](daemon-channel-runtime-control.zh-CN.md)

## Summary

Add runtime desired-state control for daemon-managed channel workers. A daemon
may start without `--channel`, then enable, replace, inspect, reload, and stop
its channel selection without restarting the daemon. Runtime changes are not
persisted. The next daemon boot follows an explicit `--channel`, otherwise it
restores each trusted registered workspace's own `serve.channels`; without
either it remains disabled.

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
the committed selection. Mutations use the strict operator-authority gate.

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
reservation and ready-before-success behavior. On a flagless boot, the daemon
restores `serve.channels` from every trusted registered workspace, each
contributing the list in its own workspace-scope settings. The startup
selection uses persisted folder-trust settings; workspace ownership and trust
are checked again before workers start. The workspace that listed a name breaks
an otherwise ambiguous ownership tie, and keeps breaking it for as long as the
daemon runs, so re-enabling a name the daemon stopped resolves as boot did. A
name contributed only by non-primary workspaces is dropped with a log rather
than failing the whole restore; a name the primary workspace listed keeps
failing it. `all` stays primary-only and is reported when configured
elsewhere. A trusted non-primary workspace registered after boot restores
its own names too, without holding the registration open, and only the first
time this daemon sees it — recorded as soon as it asks for anything — because a
later removal and re-registration, or a trust re-materialization, must not undo
an operator who stopped one of those channels in between. Late restores run one
at a time, each adding its names to the committed selection in one change, so
one name it cannot attribute costs that workspace its whole list, unlike boot.
After `DELETE /workspace/channel` has stopped hosting, a registration restores
nothing, because registering a workspace is not an instruction to turn hosting
back on; that waits for a `PUT /workspace/channel` that commits, or the next
boot. The daemon records that stop where it happens: a manager that has never
hosted anything reports the same state as a stopped one, so the state cannot
tell them apart. An explicit `--channel` selection is never extended by a
workspace registered later, and a committed `all` selection is left as it is.
Registration does not wait on the channel-control lane: the restore and the
reconcile of already-hosted channels are queued there and the hook returns, so
a worker that never becomes ready delays only channel work, never another
registration or a trust reconcile, which share a daemon-wide gate. The lane
orders that work on its own, and the late restore computes its additions
inside it, so each builds on what the previous one committed. Without an explicit selection, a persisted
selection, or a registration like the one above, the daemon does not reserve
the channel service or load the heavy channel runtime until the first runtime
mutation.

Stored startup names must be non-empty, have no leading or trailing whitespace,
and contain no unsafe control or invisible characters. Invalid entries are
skipped individually and logged by array index. Startup does not trim them into
other instance names or rewrite the stored configuration. Workers receive each
name as `--channel=<value>`, so a leading dash remains part of the value.

An invalid startup field or a validation or lease error before workers start
skips the automatic restore with a log identifying `serve.channels`; unrelated
settings remain in effect. A failed worker startup allows the daemon to
continue only after cleanup succeeds. Global runtime startup timeouts and
unconfirmed worker stops retain the existing startup-failure behavior. The
service lease remains held while worker termination is unconfirmed.

Channel management reports persisted startup settings and actual runtime state.
Skipped or failed automatic restores are diagnosed through the daemon log;
they do not replace the configured instances or startup toggles with a retained
boot-failure snapshot.

Legacy `runtime.channelWorker`, grouped `runtime.channelWorkers`, pidfile
fields, standalone `qwen channel start`, and `qwen channel reload` remain
compatible. New CLI control is exposed through `qwen channel set`, plus remote
variants of channel stop and status.
