# Web Shell updates

[English](web-shell-update.md) | [简体中文](web-shell-update.zh-CN.md)

## Problem and scope

Web Shell shows the running version but cannot prepare or apply updates. Check
and download in the background; only show a small **Update** button beside the
lower-left version when the payload is ready. Clicking applies the update,
restarts the connected daemon, and reloads the current browser URL after recovery.

This updates the connected daemon's installation, including remote daemons. It
does not update an embedded host. Restart ends running work through the daemon's
existing graceful shutdown path; it does not resume an interrupted model turn.

## Design

- Authenticated, process-global `GET /daemon/update` checks for a release without
  downloading or installing. Cache checks for 15 minutes and errors for one
  minute; `?refresh=true` forces a check. Concurrent checks share one request.
- `POST /daemon/update/prepare` downloads a server-selected release and returns
  immediately. Reuse standalone archive download/checksum verification or stage
  a managed npm installation without changing the active installation. Never
  hold the installation lock while waiting for the user. At activation, recheck
  the installation under its lock and preserve an already equal or newer version.
- `POST /daemon/update/restart` acknowledges before applying the prepared payload.
  Only this explicit action activates the update. Then close daemon services and
  replace the process with `process.execve`. Preserve PID, startup directory,
  bound primary port, authentication token, and CLI arguments; discard managed
  version pins and browser-opening flags so the new launcher selects the update.
- Restrict preparation/restart to primary connections using the daemon token
  or trusted tokenless loopback, actual CLI entry points with a restart callback, POSIX platforms with `process.execve`, supported
  standalone/global managed npm installs, and operator settings permitting
  `general.enableAutoUpdate`. Ignore workspace settings for this process-wide
  decision. Windows, embedded servers, development installs, package-manager
  installs, and unsupported Node runtimes do not offer the button.
- Status is `available`, `up-to-date`, `installing` (background preparation only),
  `ready`, `restarting`, `unavailable`, or `error`, with current/latest versions,
  `canInstall`, optional instructions, and optional message. Concurrent mutations
  share one operation; a prepared payload survives browser reloads. Clean staged
  files on cancellation, activation, failure, and ordinary daemon shutdown.
- Advertise `daemon_update`; expose REST-only SDK check/prepare/restart methods.
  Keep existing authentication, CORS, and strict mutation authorization. Clients
  cannot supply installation commands, paths, or a target version.
- Web Shell checks on mount and periodically, requests preparation automatically
  when supported, and polls preparation/restart every 2 seconds. The expanded
  sidebar places the version and button on a separate line above footer actions,
  including narrow widths. The collapsed sidebar shows an accessible icon only
  when ready. Use the shared button, semantic colors, and English/Chinese labels.
- Keep checks/downloads quiet. Explicit restart failures use the existing error
  notification. During restart, disable the button and tolerate connection loss;
  after the running version changes, reload the same URL. If recovery has not
  completed, show an error on the first completed poll after 60 seconds.
  Unmounting cancels browser polling, not daemon work.
- Hide the control for older daemons and the desktop shell. Custom footer items
  can omit `update`; this also disables the browser's preparation requests.

## Ownership and affected areas

The routes, release check, installer, staged payload, and restart belong to the
**daemon process**, not a selected workspace or session owner. Detection uses the
startup directory and operator settings. The primary listener/token restriction
avoids breaking ephemeral device-pairing credentials on restart; paired
connections do not offer updates. SDK and Web Shell are the consumers; neither
can redirect the operation into a workspace runtime.

Changes cover CLI serve routes/lifecycle/entry points and installer staging
helpers, SDK daemon types/client exports, Web Shell sidebar/translations, and
protocol documentation. Existing interactive CLI update behavior remains intact.

## Validation and acceptance

Establish the missing API/UI baseline with global `qwen serve` in an isolated
runtime. Never update the user's installation during tests. Exercise real local
archives/npm fixtures with fake activation boundaries; verify preparation does
not change the active install, cached payload activation works, and cleanup and
existing direct update behavior hold. Test authorization, primary-listener scope,
settings/platform/embedding restrictions, duplicate operations, failure recovery,
response-before-restart ordering, and preserved restart arguments/environment.

Test hidden/up-to-date/downloading/ready/restarting/error states, explicit-only
activation, disconnection/recovery, timeout, collapsed controls, narrow layouts,
and bilingual labels. Build, typecheck, bundle, run focused package tests, and
verify the packaged daemon plus browser flow. Record limitations separately.

Acceptance: no update control appears until preparation completes; the version
and update button sit together without overlapping footer actions; clicking once
applies/restarts once and returns to the same task after recovery. Unsupported or
disabled installations remain usable without a misleading restart button.

## Open questions

None. Windows replacement and restarting arbitrary embedded hosts are outside
this change.
