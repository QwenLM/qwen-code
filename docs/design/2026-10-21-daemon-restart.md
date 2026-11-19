# Daemon restart

[English](2026-10-21-daemon-restart.md) | [简体中文](2026-10-21-daemon-restart.zh-CN.md)

Status: implemented.

## Scope

`qwen daemon restart` restarts exactly one registered local `qwen serve` daemon. It requests the daemon's recorded port and hostname, replays its recorded startup workspaces, Web Shell mode, and `--require-auth` setting, keeps its bearer credential, and waits for the new runtime to become ready. It does not add a supervisor, a Windows service, or cross-runtime-directory discovery.

## Command

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth | --no-require-auth]
                     [--force]
```

`--port` is required when more than one daemon is registered. `--web` and `--require-auth` default to the recorded values; passing either overrides the record. For a bearer daemon, or when `--require-auth` is requested for an `auth: none` daemon, `--token` or `QWEN_SERVER_TOKEN` is required.

## Discovery record

`qwen serve` adds three optional fields to its discovery record so restart can reproduce what the daemon was started with:

- `startupWorkspaces`: the explicit startup workspaces. `workspaces` also contains the persisted registrations the daemon restored at boot. Replaying those as `--workspace` would turn a registration that can be forgotten into a startup workspace, which the removal route then refuses to remove.
- `web`: whether the Web Shell was enabled.
- `requireAuth`: whether `--require-auth` was set.

The fields are optional, so older CLIs still read the record and the record version stays 1. The record still carries no bearer token.

## Behavior

- Select exactly one discovery record. With no record, or with several and no `--port`, restart reports the error and asks only for `--port`; it does not take `stop`'s `--all`.
- Decide every refusal that can be decided while the daemon is still running before the stop leg:
  - Reject an HTTPS discovery URL. `daemon start` cannot restore TLS settings, so restart must not downgrade an encrypted listener to plain HTTP.
  - Reject an older record without `startupWorkspaces` when it lists more than one workspace, because its restored registrations cannot be told apart from startup workspaces. An older single-workspace record is replayed, with notices naming the assumed Web Shell and `--require-auth` defaults.
  - Resolve the bearer token from `--token` or `QWEN_SERVER_TOKEN`. A recorded bearer daemon, `--require-auth`, or an explicit `--token` requires one. The error names a token generated at startup, which the record cannot recover, and notes that a token in a workspace `.env` or settings file is not read by `qwen daemon`.
  - For a running bearer daemon whose listener identity is verified, send the token to `/daemon/status`. A 401 refuses the restart, so a wrong token cannot silently rotate the daemon's credential. An unverified or unreachable listener is not sent the token.
  - Refuse when the restart process is a descendant of the target daemon, for example a Web Shell terminal it hosts. Stopping the daemon tears that shell down, and this command with it, before the start leg runs.
  - Validate the startup workspaces with the same check `daemon start` applies, so a workspace that disappeared while the daemon ran does not stop a healthy daemon.
- Stop through the existing `daemon stop` path, including PID/start-time/command-line checks. `--force` is passed only when the operator passes `restart --force`. It confirms the Windows hard kill and allows SIGKILL on POSIX after the SIGTERM timeout; restart never adds it on the operator's behalf.
- Start through the existing `daemon start --wait` path with the recorded port, hostname, startup workspaces, Web Shell mode, and `--require-auth`. The new process must report the runtime as serving before restart returns.
- Run both legs as `qwen daemon stop` and `qwen daemon start` subprocesses. Each leg is the public command with its own checks and output, and the restart process can give the legs a child environment (token added or removed) without changing its own.
- Preserve `process.execArgv` for JavaScript/TypeScript entries so `npm run dev -- daemon restart` keeps its loader.
- For an `auth: none` daemon without `--require-auth` or `--token`, remove `QWEN_SERVER_TOKEN` from the child environment so an inherited token does not silently add bearer auth. An explicit `--token` configures bearer auth, as it does for `daemon start`.

## Safety and failure

- A stop refusal or timeout keeps the discovery record, and restart does not start. When the stop leg fails because the record is already gone (the daemon exited on its own while the stop leg started), restart starts the daemon.
- A stop or start leg that cannot be launched is reported with the spawn error.
- A start failure has three outcomes, which are `daemon start`'s:
  - `daemon start` refused before spawning (invalid workspace, missing token, duplicate daemon, spawn failure): the daemon is stopped, and retrying is safe.
  - No discovery record within 30 seconds: the detached child may still start. Check `qwen daemon status` before retrying.
  - The record was published but the runtime did not report ready within 30 seconds: the daemon is usually running but not ready, though it may have exited during startup. Check `qwen daemon status`, and use `qwen daemon stop --port <port>` before starting again; a bare `qwen daemon start` is refused while it runs.
- `serve` moves to the next free port when the recorded one is in use. Restart then exits non-zero, because the daemon did not come back on its recorded port; the start summary prints the actual URL.
- The restart command never persists or prints the bearer token.

## Limitations and follow-up

- Restart reproduces only the port, hostname, startup workspaces, Web Shell mode, `--require-auth`, and bearer credential. Every other `qwen serve` option, such as `--profile`, `--http-bridge`, `--channel`, `--join`, `--local-control`, `--allow-origin`, `--rate-limit-*`, and the session and memory limits, resets to its default. Relaunch a daemon configured with those options through `qwen serve`.
- To rotate the bearer token, stop the daemon and start it with the new token.
- Restart currently emits the stop and start summaries. A structured `--json` result is a follow-up.

## Verification

- Unit: discovery record validation for the new fields; the restart plan (record replay, older records, token and auth decisions, flags, loader arguments); target selection; the ancestor check; the token probe; and the sequencing, including every pre-stop refusal, the vanished-record path, spawn errors, and a port that moved.
- E2E: start a detached `--no-web` daemon, restart it, confirm the same port with a new PID, then stop it. Restart a bearer daemon with and without its token, from inside a Web Shell terminal, and after removing a startup workspace.
