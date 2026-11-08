# Settling Orphaned Background Shell Status Files

[English](2026-11-07-orphaned-shell-status.md) | [简体中文](2026-11-07-orphaned-shell-status.zh-CN.md)

- Status: proposed (the persisted value needs maintainer agreement)
- Date: 2026-11-07
- Issue: #15800
- Scope: `packages/core/src/services/backgroundShellRegistry.ts`,
  `packages/core/src/config/config.ts`, the status-file guidance in
  `packages/core/src/tools/shell.ts`, and the `nonBlocking` option of
  `openSyncNoFollow` in `packages/core/src/utils/no-follow-open.ts`

## Problem statement

A background shell (`run_shell_command` with `is_background: true`) has a JSON
status sidecar next to its output file. Only the CLI process that started the
shell writes it, through `BackgroundShellRegistry.writeStatusFile()`. The child
is spawned detached, so it outlives a CLI that is killed or crashes. Nothing
then moves the sidecar out of `running`: a resumed session, told by the shell
tool's guidance to read the file, sees a command that finished long ago as
still running.

## Current state

- Writers: `register()`, `complete()`, `fail()` and `settleAsCancelled()`, and
  `abortAll()` on an orderly shutdown.
- `writeStatusFile()` records the child `pid` so that a `running` sidecar left by
  a hard-killed CLI "can still be cross-checked", but no code performs the
  check. The pid alone does not say where it names a process: `~/.qwen` and a
  project path can be shared by a host and a container, or by two machines.
- The guidance lists `running|completed|failed|cancelled`.
- Handling SIGHUP in headless mode (#15823) narrows the window, but no write-side
  change covers SIGKILL, a crash or power loss.

## Goals

- A sidecar whose process is gone and whose owner can no longer update it stops
  reading `running`.
- Never invent an outcome that was not observed.
- Never touch a sidecar that a live process may still update.
- Never judge a pid in a scope other than the one that recorded it.

## Non-goals

- Recording outcomes after the fact, or reattaching to surviving children.
- Shells of an execution environment, whose pids may not be on this host.

## Proposed changes

### A. Pid scope

`writeStatusFile()` records, next to the `pid`, the scope it belongs to:

```json
"pidScope": { "hostname": "…", "bootId": "…", "pidNamespace": 4026531836 }
```

`hostname` is `os.hostname()`. `bootId` and `pidNamespace` come from the
existing `readLocalBootId()` and `readPidNamespaceId()` in
`process-liveness.ts`, and are `null` where the platform does not expose
them. A hostname alone cannot distinguish machines. A sidecar is settled
only when both boot and PID-namespace identities are available and all three
fields match the settling process. Matching `null` values do not prove a
shared scope. Without those identities, including on macOS and Windows,
automatic settling is skipped and the sidecar stays `running`.

### B. Settling function

`settleOrphanedShellStatusFiles(dir)` reads every `*.status` file in a
session's `background-shells` directory. It opens each through
`openSyncNoFollow(path, { nonBlocking: true })`, so it neither follows a
symlink nor waits on a FIFO, and reads it only when `fstat` reports a regular
file of at most 1 MiB. The read buffer is that size plus one byte, so a file
that grew after the size check is detected and left untouched;
`writeStatusFile()` replaces sidecars rather than appending to them. Short
reads are continued until EOF or that bound.
A sidecar whose `status` is `running`, whose recorded `pid` is a positive
safe integer, whose `pidScope` matches, and whose process
`isPidAlive` reports gone is rewritten with `status: 'unknown'` and a new
`updatedAt`. Every other field is kept. The write uses the same atomic,
owner-only, no-follow options as `writeStatusFile()`. The persisted value has
its own type, `ShellStatusFileStatus`; `BackgroundShellStatus` stays the
in-memory set.

Left alone: other statuses, sidecars without a pid or with an invalid one,
sidecars whose `pidScope` differs, is missing, or lacks a boot or PID-namespace
identity, files that are not regular, oversized, unreadable or malformed,
and sidecars whose pid is alive. One
sidecar that fails does not stop the others.

The function returns the sidecars it left `running` that may need settling
later: those whose process is alive, whose rewrite failed, or that could not
be read, which have no pid yet. `watchOrphanedShellStatusFiles(orphans)`
checks them every two seconds. Each attempt reads the sidecar again and checks
its scope and process before writing, so a pid from an earlier read only
saves a read while that process is alive. Once a process is gone it settles
the sidecar the same way, and keeps it watched until that succeeds or the
sidecar no longer needs settling, so a failed read or write is retried and
logged once. Its timer does not keep the process
alive, and it returns a function that stops it.

### C. When it runs

`Config` settles the active session's directory when it takes a session:

- in `initializeOnce`, after the session writer is activated, which covers a
  process started on a resumed session (`--continue`, `--resume`, a daemon
  restore);
- in `startNewSession` when it switches to a different session id, which covers
  `/resume` inside a running CLI.

When a sidecar is left `running` at that point, the Config watches it, so a
command that finishes after the resume is settled within the same session. Switching to another session or shutting down stops the
watch.

At those points this Config tracks none of that session's shells, and
`BackgroundShellRegistry.reset()` may only run once no managed shell of the
outgoing session is running. Resuming the session already in use is not a
switch and settles nothing. A new session has no directory, so the call is a
no-op. A Config with an execution environment skips it.

### D. Guidance

The model guidance lists `unknown` and says it means the session that started
the process ended without recording how it finished. It also says a `running`
value can outlive the session that wrote it, and that if that session ended
without shutting down, the recorded pid should be checked (e.g. `ps -p`)
before the process is treated as running, but only under the same condition
the settler uses: the sidecar's `pidScope` has the reader's hostname and a boot
ID and pid namespace that are both present and equal to the reader's. A
missing or different `pidScope`, or one with a null boot ID or pid namespace
(as on macOS and Windows), cannot show that the pid is local, so the model is
told not to check it and to treat the outcome as unverified rather than as
ended.

## Key design decisions

- **`unknown` rather than `failed`.** `failed` would claim an outcome nobody
  observed, and the command may have succeeded. This is the open question asked
  on the issue; switching to `failed` with an explanatory `error` is a one-line
  change if maintainers prefer it.
- **Child pid, not owner pid.** The sidecar records only the child. Settling
  happens when this Config has just taken the session, so the previous owner is
  not updating it, and a live child keeps `running`, which is true.
- **Scope before liveness.** A pid from another pid namespace, machine or boot
  can be absent here while its process still runs, and the guidance would then
  tell the model a live command had ended. The scope check makes such a
  sidecar keep `running`, which is today's behaviour.
- **Sidecars without a scope stay `running`.** Older versions wrote no
  `pidScope`, so it cannot be told whether their pid is local. They keep
  today's behaviour; sidecars are per session, so this affects only sessions
  started before the upgrade.
- **pid reuse.** A recycled pid in the same scope looks alive, so the sidecar
  stays `running`, today's behaviour. A start-time token would let a reused
  pid be settled too, but it is Linux-only and is not needed to avoid a false
  `unknown`.

## Constraints and risks

- Writers that take no session lease (the TUI and the headless CLI) could, in
  principle, run on the same session at once. If one of them settles a sidecar
  in the moment between its child exiting and the owner recording the result,
  the owner's later write still lands, but a write in the other order would leave
  `unknown`. Two concurrent writers on one session are already unsupported.
- Sidecars written by older versions have no `pidScope` and stay `running`.
- Automatic settling currently requires Linux boot and PID-namespace identities.
  On macOS, Windows, or Linux where either identity cannot be read, sidecars
  stay `running`; matching hostnames alone do not justify checking their PIDs.
- A change of host name, which macOS can make when the network changes, keeps
  that session's sidecars `running`. A sidecar written in an earlier sandbox
  container is also kept, because the new container has another pid
  namespace and cannot see the old one's processes.

## Validation plan

- Unit tests for the settling function: a dead pid, a live pid, a foreign pid
  namespace, boot or host, a missing or incomplete scope, other statuses, no pid,
  invalid pids, malformed JSON, a status-shaped non-status file, a FIFO, an oversized
  file, post-stat growth, exactly-at-limit and one-byte-over files, short reads
  through multibyte text, a symlinked sidecar, one sidecar whose check throws,
  a missing directory, a real exited process through the default `isPidAlive`,
  and a registry-written sidecar: settled with the native scope on Linux, kept
  `running` where the platform cannot prove the scope.
- Watcher tests: a watched sidecar is settled once its process exits and not
  after the watch is stopped; a failed rewrite is retried until it lands, and
  logged once, while a sibling settles; a sidecar unreadable at takeover is watched and settled
  once it can be read; the timer is unref'd; and, with a real child, a process
  alive at takeover that exits later is settled with no second takeover.
- `Config` tests: initialization settles the session it starts with; switching
  settles the new session; resuming the current one does not; unsettled
  sidecars are watched until a switch or shutdown; a Config with an execution
  environment does not settle; a settle that throws does not stop
  initialization.
- Guidance tests assert `unknown`, its meaning, the stale-`running`
  cross-check and its `pidScope` condition, including that a null boot ID or
  pid namespace leaves the outcome unverified, in both the launch and the
  promote messages.
- `openSyncNoFollow` tests: `nonBlocking` opens a FIFO without waiting, on
  the native path and on the fallback. The native open runs in a child process
  under a kill deadline, and the fallback's mocked `openSync` refuses an open
  without `O_NONBLOCK`, so a regression fails the test instead of hanging the
  run.
- Mutation checks: removing each of these guards turns a test red.
- On Ubuntu 24.04 with Node 22, and on macOS: drive the bundled CLI with the
  repo's fake OpenAI server, kill it with SIGKILL and with SIGHUP to its
  process group while a background shell runs, let the command finish, then
  resume the session and read the sidecar. Repeat with the sidecar's
  `pidScope` changed to another host, which must stay `running`. On macOS,
  whose native scope lacks these identities, verify that the default recovery
  leaves the sidecar `running` instead of judging the PID by hostname alone.

## Acceptance criteria

- With proven same-scope identities, after the owning CLI is killed and its
  background command finishes, resuming the session turns the sidecar into
  `unknown` with its original fields.
- With proven same-scope identities, a sidecar whose process is still running
  stays `running`, and becomes `unknown` once that process exits while the
  resumed session is open.
- A sidecar written in another pid scope, without one, or with either
  boot or PID-namespace identity missing stays `running`.
- Orderly shutdowns still write `cancelled`, as before.

## Open questions

- `unknown` or `failed` with an `error`, as asked on the issue.
