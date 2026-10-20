# Daemon restart

Status: implemented.

English | [中文](2026-10-21-daemon-restart.zh-CN.md)

## Scope

`qwen daemon restart` restarts exactly one registered local `qwen serve` daemon. It reuses the daemon's recorded port, hostname, and workspaces, then waits for the new runtime to become ready. It does not add a supervisor, a Windows service, or cross-runtime-directory discovery.

## Command

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth] [--force]
```

`--port` is required when more than one daemon is registered. For a bearer daemon, or when `--require-auth` is requested for an `auth: none` daemon, `--token` or `QWEN_SERVER_TOKEN` is required.

## Behavior

- Select exactly one discovery record. No daemon or multiple daemons without `--port` is an error.
- Reject an HTTPS discovery URL before stopping. `daemon start` cannot restore TLS settings, so restart must not downgrade an encrypted listener to plain HTTP.
- Resolve and validate the bearer token **before** stopping. This covers both a recorded bearer daemon and an explicit `--require-auth` hardening of an `auth: none` daemon. The token is retained in the child environment.
- Stop through the existing `daemon stop` path, including PID/start-time/command-line checks. On Windows, `--force` is passed only when the operator passes `restart --force`; restart never acknowledges the hard kill on the operator's behalf.
- Start through the existing `daemon start --wait` path with the recorded port, hostname, and workspaces. The new process must report the runtime as serving before restart returns.
- Preserve `process.execArgv` for JavaScript/TypeScript entries so `npm run dev -- daemon restart` keeps its loader.
- For `auth: none` without `--require-auth`, remove `QWEN_SERVER_TOKEN` from the child environment so restart does not silently add bearer auth.

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
