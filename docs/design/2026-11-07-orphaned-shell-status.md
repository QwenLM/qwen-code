# Settling Orphaned Background Shell Status Files

[English](2026-11-07-orphaned-shell-status.md) | [简体中文](2026-11-07-orphaned-shell-status.zh-CN.md)

- Status: proposed (the persisted value needs maintainer agreement)
- Date: 2026-11-07
- Issue: #15800
- Scope: `packages/core/src/services/backgroundShellRegistry.ts`,
  `packages/core/src/config/config.ts`, the status-file guidance in
  `packages/core/src/tools/shell.ts`

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
  check.
- The guidance lists `running|completed|failed|cancelled`.
- Handling SIGHUP in headless mode (#15823) narrows the window, but no write-side
  change covers SIGKILL, a crash or power loss.

## Goals

- A sidecar whose process is gone and whose owner can no longer update it stops
  reading `running`.
- Never invent an outcome that was not observed.
- Never touch a sidecar that a live process may still update.

## Non-goals

- Recording outcomes after the fact, or reattaching to surviving children.
- Shells of an execution environment, whose pids may not be on this host.

## Proposed changes

### A. Settling function

`settleOrphanedShellStatusFiles(dir)` reads every `*.status` file in a
session's `background-shells` directory, opening it without following
symlinks. A sidecar whose `status` is `running` and whose recorded `pid` is a
positive integer that `isPidAlive` reports gone is rewritten with
`status: 'unknown'` and a new `updatedAt`. Every other field is kept. The write
uses the same atomic, owner-only, no-follow options as `writeStatusFile()`.

Left alone: other statuses, sidecars without a pid, unreadable or malformed
files, and sidecars whose pid is alive.

### B. When it runs

`Config` settles the active session's directory when it takes a session:

- in `initializeOnce`, after the session writer is activated, which covers a
  process started on a resumed session (`--continue`, `--resume`, a daemon
  restore);
- in `startNewSession` when it switches to a different session id, which covers
  `/resume` inside a running CLI.

At those points this Config tracks none of that session's shells, and
`BackgroundShellRegistry.reset()` may only run once no managed shell of the
outgoing session is running. Resuming the session already in use is not a
switch and settles nothing. A new session has no directory, so the call is a
no-op. A Config with an execution environment skips it.

### C. Guidance

The model guidance lists `unknown` and says it means the session that started
the process ended without recording how it finished.

## Key design decisions

- **`unknown` rather than `failed`.** `failed` would claim an outcome nobody
  observed, and the command may have succeeded. This is the open question asked
  on the issue; switching to `failed` with an explanatory `error` is a one-line
  change if maintainers prefer it.
- **Child pid, not owner pid.** The sidecar records only the child. Settling
  happens when this Config has just taken the session, so the previous owner is
  not updating it, and a live child keeps `running`, which is true.
- **pid reuse.** A recycled pid looks alive, so the sidecar stays `running`,
  which is today's behaviour. The check never turns a live process into
  `unknown`.

## Constraints and risks

- Writers that take no session lease (the TUI and the headless CLI) could, in
  principle, run on the same session at once. If one of them settles a sidecar
  in the moment between its child exiting and the owner recording the result,
  the owner's later write still lands, but a write in the other order would leave
  `unknown`. Two concurrent writers on one session are already unsupported.
- Sidecars written by older versions have the same shape and are settled the
  same way.

## Validation plan

- Unit tests for the settling function: a dead pid, a live pid, other statuses,
  no pid, malformed JSON, non-status files, a missing directory, and a real
  exited process through the default `isPidAlive`.
- `Config` tests: initialization settles the session it starts with; switching
  settles the new session; resuming the current one does not.
- On Ubuntu 24.04 with Node 22: drive the bundled CLI with the repo's fake
  OpenAI server, kill it with SIGKILL and with SIGHUP to its process group while
  a background shell runs, let the command finish, then resume the session and
  read the sidecar.

## Acceptance criteria

- After the owning CLI is killed and its background command finishes, resuming
  the session turns the sidecar into `unknown` with its original fields.
- A sidecar whose process is still running stays `running`.
- Orderly shutdowns still write `cancelled`, as before.

## Open questions

- `unknown` or `failed` with an `error`, as asked on the issue.
