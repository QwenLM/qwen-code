# Daemon restart

Status: implemented.

English | [中文](2026-10-21-daemon-restart.zh-CN.md)

## Scope

`qwen daemon restart` restarts exactly one registered local `qwen serve` daemon. It reuses the daemon's recorded port, hostname, and workspaces, then waits for the new runtime to become ready. It does not add a supervisor, a Windows service, or cross-runtime-directory discovery.

## Command

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth]
```

`--port` is required when more than one daemon is registered. `--token` is required for a `auth: bearer` daemon; `QWEN_SERVER_TOKEN` is the preferred source.

## Behavior

- Select exactly one discovery record. No daemon or multiple daemons without `--port` is an error.
- Resolve the bearer token **before** stopping a bearer daemon. A missing token must not kill a working daemon.
- Stop through the existing `daemon stop` path, including PID/start-time/command checks and the Windows `--force` requirement.
- Start through the existing `daemon start --wait` path with the recorded port, hostname, and workspaces. The new process must report the runtime as serving before restart returns.
- For `auth: none`, remove `QWEN_SERVER_TOKEN` from the child environment so restart does not silently add bearer auth.

## Safety and failure

- A stop failure aborts the restart; no start is attempted.
- A start failure leaves the daemon stopped and returns non-zero. The operator can inspect the startup log and retry `daemon start`.
- The restart command never persists or prints the bearer token.

## Limitations and follow-up

- The discovery record does not yet store the original `web` mode or `require-auth`. Restart defaults to Web Shell enabled and `require-auth` off, force-enables it for a bearer record, and accepts explicit `--no-web` / `--require-auth`. Persisting both fields in the record is a follow-up.
- Restart currently emits the stop and start summaries. A structured `--json` result is a follow-up.

## Verification

- Unit: command registration plus the existing daemon suite.
- E2E: start a detached `--no-web` daemon, restart it, confirm the same port with a new PID, then stop it.
