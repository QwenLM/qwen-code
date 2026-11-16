# Background daemon start

[English](2026-10-20-daemon-start.md) | [简体中文](2026-10-20-daemon-start.zh-CN.md)

## Status

Implemented in this change. `qwen daemon start` is local process management; it
does not change the serve protocol, authentication, or workspace isolation.

## Problem

Starting a local daemon required a service manager, tmux, or `nohup`. The
discovery record and `qwen daemon stop` already made a running daemon
inspectable, but there was no supported way to start one and return to the
shell.

## Behavior

`qwen daemon start` spawns `qwen serve` as a detached child, waits for the
child to publish its discovery record, then prints the bound URL, PID, log
path, and stop command. The child keeps running after the parent exits.

Supported inputs: `--port`, `--hostname`, `--workspace` (repeatable),
`--no-web`, `--require-auth`, and `--token`. The child is always started with
`--no-token-qr` so the startup log cannot contain a token QR.

## Environment isolation

The child is a new daemon, not a worker of the session that launched it. The
start command removes the parent's session and worker bindings before spawn:
`QWEN_CODE_SESSION_ID`, `QWEN_CODE_PROMPT_ID`, `QWEN_CODE_PROJECT_DIR`,
`QWEN_CODE_SERVE`, `QWEN_CODE_AGENT_ID`, `QWEN_DAEMON_TOKEN`,
`QWEN_CODE_MESSAGING_TOKEN`, `QWEN_CODE_MESSAGING_SOCKET`,
`QWEN_CODE_CLI`, `QWEN_CODE_NO_RELAUNCH`, and every key starting with
`QWEN_CODE_PRIVATE_` (including the Conversations runtime and guard-provider
markers). Relative `QWEN_RUNTIME_DIR` and `QWEN_HOME` values are resolved
against the launching directory before spawn, so the parent polls the same
discovery namespace the child writes. The operator's model and auth
environment is kept.

Windows drive-relative roots are resolved against the launching drive as well; only drive-letter and UNC forms are kept verbatim.

An explicitly empty `QWEN_RUNTIME_DIR` or `QWEN_HOME` is preserved as a set variable; only an absent variable is removed.

The command canonicalizes workspaces with the same function `serve` uses, so a
symlink alias and its target are treated as one workspace for the
duplicate-start check and in the child's arguments.

A supplied token is passed through `QWEN_SERVER_TOKEN`, never as a child
argument. `--token` is visible in the launching shell's process list, so the
command warns and recommends the environment variable.

## Logging and security

Startup stdout and stderr go to a `0600` file in the runtime daemon directory.
The file is removed after a successful start; on failure it is kept and its
tail is printed. Startup logs older than 24 hours are swept on the next start.
A non-loopback bind requires `QWEN_SERVER_TOKEN`: the command refuses to let
the child generate an ephemeral token that would otherwise be written to the
startup log.

## Failure handling

- An existing live daemon for the same primary workspace is refused unless
  `--port` is supplied.
- A missing workspace, missing `--require-auth` token, or missing
  non-loopback token fails before spawning.
- If the child exits or does not publish a record within 30 seconds, the
  command exits non-zero, says the detached child may still start, points at
  `qwen daemon status`, and prints the startup log path and tail.

## Non-goals

- No supervision, crash restart, or service installation.
- No Windows service wrapper.
- No ephemeral-token mode on a non-loopback bind; use `qwen serve` directly.

## Validation

- The daemon command suite covers argument construction, summary formatting,
  environment isolation (including the private-key prefix and relative runtime
  paths), workspace canonicalization (including Windows drive-relative roots),
  startup-log sweeping, record selection,
  and the existing status/log/stop behavior.
- Full workspace typecheck and ESLint pass.
- Local E2E: `daemon start --port 0 --no-web --json` published a record,
  `daemon status --json` reported it running, `daemon stop --port <port>`
  terminated it, and the record directory was empty afterwards.

## Acceptance criteria

- A second terminal can start a daemon and return to the shell without a
  service manager.
- The printed stop command terminates the child.
- The child does not inherit the launching session's identifiers or private
  capabilities.
- No startup artifact contains a bearer token.

## Follow-ups

- Optional restart (`stop` + `start` with the recorded workspace).
- Windows service integration.
