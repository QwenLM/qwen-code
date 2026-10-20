# Local daemon discovery and control commands

[English](2026-10-19-daemon-discovery-and-control.md) | [简体中文](2026-10-19-daemon-discovery-and-control.zh-CN.md)

## Status

Implemented in this change. The new unit tests and typecheck pass. `qwen serve` keeps
its existing protocol, authentication, and workspace-isolation behavior; the
new surface is local operator tooling only.

## Problem

`qwen serve` can start a local HTTP daemon and serve the Web Shell with no
configuration, but it leaves no machine-readable trace once it is running. An
operator must parse stdout for the bound port, use `ps` to find the process,
and know the internal log path under the runtime directory. A second terminal
cannot answer "is a daemon already running for this workspace?" without
guessing a port and probing it. `GET /daemon/status` exists, but no CLI command
reaches it.

## Goals

- Publish one small discovery record per live listener.
- Provide `qwen daemon status`, `qwen daemon logs`, and `qwen daemon stop` for
  the local operator.
- Keep the discovery record free of bearer tokens.
- Leave `qwen serve` behavior unchanged when the record cannot be written.

## Non-goals

- No remote registry, cross-host federation, or multi-daemon coordination.
- No restart command in this slice.
- No token persistence. `--token` and `QWEN_SERVER_TOKEN` remain the only
  bearer sources.
- No change to the `qwen serve` HTTP protocol or Web Shell.

## Discovery record

The daemon writes one JSON record after its listener is bound:

```text
${QWEN_RUNTIME_DIR:-${QWEN_HOME:-~/.qwen}}/daemon/daemon-<port>.json
```

```json
{
  "v": 1,
  "pid": 12345,
  "port": 4170,
  "hostname": "127.0.0.1",
  "url": "http://127.0.0.1:4170",
  "workspaces": ["/repo/project"],
  "primaryWorkspace": "/repo/project",
  "startedAt": "2026-10-19T06:00:00.000Z",
  "auth": "none",
  "logPath": "/home/user/.qwen/debug/daemon/daemon.log",
  "pidNamespace": "pid:[4026531836]"
}
```

- The directory is created `0700`; the record is written atomically with mode
  `0600` on POSIX.
- `auth` is `none` or `bearer`; `tokenGenerated` is present only when the
  daemon generated an ephemeral token. Neither field contains the token.
- `logPath` is the active log file the daemon already writes. The stable
  `debug/daemon/daemon.log` path is the fallback for older records.
- `pidNamespace` is the writer's PID namespace (`/proc/self/ns/pid`). A pid
  only names a process inside its own namespace, so a reader outside it —
  a container sharing the runtime directory, or another kernel — treats the
  pid as unaddressable rather than as evidence of life or death, and never
  signals it. The field is absent where the kernel has no PID namespaces,
  and on v1 records written before it existed.
- A wildcard bind (`0.0.0.0` / `[::]`) is recorded with a loopback `url` so a
  local client can probe it; `hostname` keeps the requested bind address.

The record deliberately carries no credential. A served workspace can expose
files through the daemon's file routes, so a record inside a workspace must
never become a token store.

## Command surface

```bash
qwen daemon status [--json] [--prune]
qwen daemon logs [--port <port>] [--lines <n>] [--follow]
qwen daemon stop [--port <port>] [--all] [--force]
```

- `status` lists every record with `running`, `unreachable`, or `stale`
  health. Any HTTP answer from `/health` proves the listener is alive,
  including `401` from `--require-auth`.
- `status --prune` removes records whose process is gone.
- `logs` prints the trailing lines and, with `--follow`, polls the recorded
  file until interrupted. It survives truncation by resetting its offset and
  drains the old file before following a rotated replacement.
- `stop` sends `SIGTERM` to the recorded PID only after the listener answers
  or the PID is still alive, and only when the process start time is close to
  the record and its command line is a `serve` process (POSIX, or Windows
  through PowerShell when available). A PID outside that window or without a
  readable identity is never signalled. On Windows `stop` is a hard kill and
  requires `--force`: shutdown handlers do not run. On POSIX `--force` sends
  `SIGKILL` after the graceful timeout. A stale record is removed without
  signalling anything.
- When exactly one daemon is registered, `logs` and `stop` select it
  implicitly. Multiple registrations require `--port` or, for `stop`, `--all`.

## Lifecycle

- The record is written after the listener is bound and removed on graceful
  close and on process exit.
- A crash can leave a record behind. `status` reports it as `stale`;
  `status --prune` and `stop` remove it.
- A failed record write is reported on stderr and never fails startup.

## Safety

- Files are private to the user (`0700` directory, `0600` record).
- No bearer token, prompt, transcript, or credential is written to the record.
- `stop` refuses to signal the current process and never signals a PID whose
  record is already stale. It also refuses a PID whose process started after
  the record was written, and refuses when the start time cannot be read.
- `--force` is opt-in and only applies after the graceful timeout.

## Validation

- Unit tests cover record round-trip, POSIX permissions, malformed records,
  expected-PID removal, runtime-directory resolution, wildcard URL rewriting,
  process-start identity, entry selection, age formatting, and log tailing.
- Typecheck passes for the whole workspace.
- Manual validation: start `qwen serve`, run `qwen daemon status`, follow the
  log, then `qwen daemon stop`, and confirm the record is removed.

## Acceptance criteria

- A second terminal can discover a live local daemon without parsing stdout
  or knowing its port in advance.
- `qwen daemon stop` exits a default loopback daemon cleanly and removes its
  record.
- No discovery file contains a bearer token.
- `qwen serve` still starts when the discovery directory is unwritable.

## Follow-ups

- `qwen daemon restart` and a startup Ready block.
- `qwen daemon token` and opt-in token persistence for `--open-with-auth`.
- A first-class terminal client (`qwen attach`).
