# Web Shell updates

[English](web-shell-update.md) | [简体中文](web-shell-update.zh-CN.md)

## Problem and scope

Web Shell shows the running version but cannot prepare or apply updates. Check
and download in the background; only show a small **Update** button beside the
lower-left version when the payload is ready. Clicking applies the update,
restarts the connected daemon, and returns to the URL open when clicked.

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
  Only this explicit action activates the update. After acknowledging, re-resolve
  the current release once and, when it is newer than the prepared one and
  one-click covers it, stage the newer release and discard the prepared payload.
  A daemon that stays alive across several releases therefore lands on the
  current latest in one click, matching the CLI, which resolves and installs at
  every process start. Readiness itself stays pinned — polling never
  re-downloads — so the re-resolve belongs to the click, not to the check. A
  failed re-resolve or staging applies the prepared release: a registry failure
  must not strand an explicit update request on the running version. Commit to
  the newer payload before discarding the superseded one, and treat that discard
  as best-effort — a failed discard leaks disk, but must not orphan the payload
  just staged or fall back to one that may already be half removed. Staging runs
  after the acknowledgement because it can take minutes, and that window must be
  undisturbed: while the state is restarting, the status, prepare and restart
  routes return without consulting the operator setting and shutdown cleanup is
  a no-op, so neither disabling automatic updates nor concurrent clients nor an
  ordinary shutdown can pull the payload out from under an authorized restart.
  Then close daemon
  services and replace the process with `process.execve`. Preserve PID, startup
  directory, bound primary port, authentication token, and CLI arguments; discard
  managed version pins and browser-opening flags so the new launcher selects the
  update. Before closing services, require the standalone launcher's official
  shell header and run its `--version` with the restart environment, a 10-second
  timeout, and a valid semver result. A failed check leaves the current daemon
  serving. This checks the actual interpreter/runtime chain; it cannot guarantee
  recovery if files change after checking or if process replacement or serve
  startup fails.
- Restrict preparation/restart to primary connections using the daemon token
  or trusted tokenless loopback, actual CLI entry points with a restart callback, POSIX platforms with `process.execve`, supported
  standalone installs and global npm/pnpm/yarn/bun installs (including
  root-owned npm prefixes), and operator settings permitting
  `general.enableAutoUpdate`. Ignore workspace settings for this process-wide
  decision. Windows, embedded servers, development installs, and unsupported
  Node runtimes do not offer the button; other unsupported shapes report an
  available update with manual instructions instead. Eligibility and button
  visibility are widened by
  [Web Shell update coverage](web-shell-update-coverage.md).
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
  including narrow widths. The collapsed sidebar shows an accessible icon when
  ready or when manual instructions are available. Use the shared button,
  semantic colors, and English/Chinese labels.
- Keep checks/downloads quiet. Explicit restart failures use the existing error
  notification. During restart, disable the button and tolerate connection loss;
  capture the full URL when clicked and, after the running version changes,
  restore that URL in the current history entry and reload the document,
  including when the URL has an unchanged fragment. Session requests may return 404 and
  navigate the shell home during restart; that must not change the return target.
  Measure the give-up deadline from continuous unreachability, not from the
  click: the daemon keeps answering while it re-resolves and stages, which can
  outlast any fixed click-time budget, and a reachable daemon is still working.
  If it has been unreachable for 60 seconds, show an error on the first completed
  poll. Keep a generous absolute cap as well, above the daemon's own staging
  ceilings (five-minute archive download, ten-minute managed npm child), so a
  daemon that stays reachable but never leaves restarting — a hung activation or
  process replacement — cannot disable the control forever with no error. The cap
  must sit high enough that a slow but progressing update never reaches it.
  Unreachability is not the only terminal condition. Restarting is sticky
  until the process is replaced, so once the restart is acknowledged a reachable
  daemon reporting any other state with an unchanged running version means the
  replacement did not land on the new build: stop waiting, publish that settled
  state so the control offers whatever the daemon now reports, and report a
  failure. Sample the acknowledgement when the poll is initiated, not when its
  response arrives: the status and restart requests are independent, so a poll
  started before the acknowledgement can deliver a pre-restart snapshot after
  it, and treating that snapshot as a settled daemon reports a false failure and
  suppresses the reload a successful update still owes the user. Dropping the
  short click-time budget must not leave the control waiting
  forever for a version change that will never arrive, nor hide the control by
  leaving a stale restarting status rendered.
  Unmounting cancels browser polling, not daemon work.
- Hide the control for older daemons and the desktop shell. Custom footer items
  can omit `update`; this also disables the browser's preparation requests.

## Ownership and affected areas

The routes, release check, installer, staged payload, and restart belong to the
**daemon process**, not a selected workspace or session owner. Detection uses the
startup directory and operator settings. Only primary connections with
credentials that survive restart (or trusted tokenless loopback) offer updates.
Restarting still invalidates other devices' ephemeral pairings; those devices
must pair again. SDK and Web Shell are the consumers; neither can redirect the
operation into a workspace runtime.

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
Exercise an unusable launcher in a disposable process with real `execve`, and
verify that the startup check rejects before closing a working listener. Pin
cleanup during a failed restart so a refreshed check can prepare another update.
Cover the activation-time re-resolve on both the standalone and managed npm
paths: a newer release replaces the prepared payload and the old one is cleaned;
polling alone never re-downloads; and an unreachable registry, a release with
nothing newer, a newer release without a one-click path, and a failed restage
each apply the prepared payload, with the failed restage leaving it intact until
after activation. Pin the comparison direction against a prerelease below the
prepared release, a registry rollback, build metadata that does not change
precedence, and a malformed registry value — none may restage. Pin that a failed
discard of the superseded payload still activates the newer one, and that an
in-flight restart survives the operator disabling automatic updates, concurrent
polls and retries, and ordinary shutdown.

Test hidden/up-to-date/downloading/ready/restarting/error states, explicit-only
activation, disconnection/recovery, timeout, collapsed controls, narrow layouts,
and bilingual labels. The timeout coverage must distinguish a reachable daemon
that is still staging from an unreachable one: only continuous downtime trips the
deadline, and a successful poll restarts it. A daemon that comes back settled on
the same version must also terminate the wait, report a failure, and hand back an
actionable control instead of hanging or disappearing. Cover both response
orderings around the acknowledgement: a settled snapshot delivered before it must
not terminate the wait, and one delivered after it by a poll that was initiated
before it must not either — only a poll initiated afterwards may. Cover a daemon
that stays reachable and wedged in restarting, so the absolute cap is shown to
end the wait without firing during a slow but progressing update. Browser
fixtures must
model the daemon's own contract — restarting from the acknowledged restart until
the process is replaced — because a fixture that keeps reporting a prepared state
after the click cannot exercise that distinction. Build, typecheck, bundle, run focused package tests, and
verify the packaged daemon plus browser flow. Record limitations separately.
The browser regression must drive a restart-time session 404, observe the shell's
own navigation, then verify recovery restores the original task URL.

Acceptance: no update control appears until preparation completes; the version
and update button sit together without overlapping footer actions; clicking once
applies/restarts once into the current latest — not into the release that happened
to be latest when the daemon prepared — and returns to the same task after
recovery. Unsupported or disabled installations remain usable without a
misleading restart button.

## Open questions

None. Windows replacement and restarting arbitrary embedded hosts are outside
this change.
