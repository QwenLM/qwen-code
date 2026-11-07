# Agent View: Left-arrow backgrounding and the roster

[English](2026-11-06-agent-view-left-arrow-roster.md) | [简体中文](2026-11-06-agent-view-left-arrow-roster.zh-CN.md)

Status: implemented and verified on Windows and Linux (see Validation).

## Problem

The Agent View backend (supervisor, PTY workers, session lifecycle) is merged, but nothing in a released build can reach it. The supervisor and PTY host entry flags are not parsed, so the supervisor child exits on an unknown argument. The roster UI and the `qwen agents` command surface live in the open stacked PRs #7802 and #7803, which no longer apply cleanly to `main`. A user who wants to run several sessions side by side and see which one needs them has no way to do it from the terminal.

## Current state

- The supervisor runtime, PTY host, worker sideband, roster store and presentation layer are on `main` and unit tested.
- `--internal-agent-view-supervisor` and `--internal-agent-view-pty-host` have no handler in the CLI entry.
- Workers never send the `ready` event the supervisor waits for, so adoption times out after 15 seconds.
- There is no key or command that moves the current session into Agent View.

## Goals

- Pressing Left on an empty prompt backgrounds the current session and opens a full-screen roster of all background sessions, the way Claude Code does.
- The roster groups sessions by state (Needs input, Working, Completed, Failed, plus Pinned) and shows a title, a one-line summary, the latest bound PR and the age on each row.
- From the roster: Space peeks at a session and can send a reply without leaving, Enter attaches to the full session, Left on an attached session's empty prompt returns to the roster, Up/Down/PgUp/PgDn move the selection, Ctrl+T pins, Ctrl+R renames, Ctrl+X stops and a second Ctrl+X removes.
- Typing a prompt in the roster starts a new background session.
- It works on Windows, Linux and macOS.

## Non-goals

- Backgrounding a session in the middle of a turn. Adoption restarts the session inside a supervisor-owned PTY, so an in-flight turn would be lost; the command refuses until the session is idle.
- An OpenTUI version of the roster. The OpenTUI renderer reports that detaching is not supported there.
- `qwen --bg` and the managed-resume guard from #7802. They are independent of this flow and can follow separately.

## Design

### Entry and gating

Everything sits behind `experimental.agentView` (default `false`). When it is off, Left behaves exactly as before. When it is on, Left on an empty prompt (no modifiers, not in shell mode, reverse search, completion or attachment mode) submits `/background` (alias `/bg`), so the key and the command share the same checks: no running turn, no pending tool or command confirmation, no foreground shell, no queued prompt, and the session must already be saved. `/background` uses the submission-scoped idle check that `/restore` and `/logout` use, because the general idle flag reads busy while any slash command runs.

`qwen agents` (or `qwen agents list`) opens the roster in a TTY and prints a text list otherwise; `attach`, `logs`, `stop`, `kill`, `respawn`, `rm` and `daemon` are subcommands, and the existing `join` subcommand is kept.

### Handing the terminal to the roster

Detaching flushes the chat recording, asks the supervisor to adopt the session, shuts the session down and starts the roster. On Windows a nested `spawnSync` from the exiting session does not work: the blocked parent keeps reading console input and the roster never receives keys. The session therefore sends the roster command line to the relaunch supervisor over its existing IPC channel and exits; the supervisor, whose stdin is already paused, starts the roster with inherited stdio. Without a relaunch supervisor (for example on Linux where the process is replaced in place) the session falls back to `spawnSync`.

The exiting session clears the console title. On Windows with Node 22, libuv aborts when the next process reads an empty title, so the relaunch supervisor sets a title before it starts the roster.

### Workers

A worker sends `ready`, reports `idle` and starts its heartbeat as soon as configuration is loaded. While running in a worker the UI reports its state on every change and polls the sideband every 250 ms for replies, answers, stop and redraw requests. On attach the supervisor queues a redraw; the worker repaints with the same path as wake/SIGCONT, because `refreshStatic` writes nothing in terminal-buffer mode and an attached terminal would otherwise stay blank until the first key.

### Rows

- Title: the rename title, else the first user prompt of the session.
- Summary: after each finished turn the worker asks the model (the fast model when configured, otherwise the session model) for one line describing what happened, and reports it in place of the raw last output line. While the session is waiting on a question the raw question is kept, so needs-input detection is unchanged.
- PR label: the latest entry of the session's PR sidecar, for example `#221` or `#221 merged`.
- Failed sessions get their own group below Completed, and the header counts them separately.

## Decisions and rationale

- Reuse the upstream roster rather than write a new one: it already covers peek, reply, pin, rename and stop/remove, and keeps one vocabulary with `qwen sessions ps`.
- Keep the backend on `main` and port only the UI and commands: `main` carries later backend fixes (for example the ConPTY backend for Windows PTYs).
- Route the roster handoff through the relaunch supervisor instead of fixing console reads in the exiting process: the supervisor already performs this handoff correctly for every launch.
- Generate the summary with a side query instead of a text heuristic: the last output line is often a table row or a code line.

## Risks

- A summary costs one extra model request per finished turn in each background session. It only runs inside Agent View workers. It is best effort: when the request fails or returns nothing, the row keeps the raw last output line.
- Pressing Ctrl+X in the few seconds while a just-dispatched worker is starting can record it as failed instead of stopped, because the stop and the worker exit race inside the supervisor's ready wait.

## Validation

- Unit tests for the Left-arrow binding, the `/background` idle exception, the relaunch roster handoff, PgUp/PgDn, the Failed group and the summary cleaner, plus the ported roster, command and backend suites.
- End-to-end runs in a real pseudo-terminal against a live model on Windows (source build on Node 24 and the standalone package on its bundled Node 22) and on Linux (WSL Debian 13, Node 22): chat, Left to the roster, peek and reply, attach with an immediate paint, Left back, start a session from the roster, rename, pin, stop and remove.

## Acceptance criteria

- With the setting off, Left and every existing key behave as before.
- With the setting on, Left on an empty idle prompt opens the roster and the session keeps running in the background.
- Every key listed under Goals works on Windows and Linux.
- Attaching paints the session immediately.

## Open questions

- Should Left also be able to background a running turn, as Claude Code does? That needs the worker to take over a live turn instead of resuming the transcript.
- Should daemon-owned sessions (`qwen serve`) be adopted into the roster? See `docs/plans/2026-09-04-background-agent-surfaces.md`.
