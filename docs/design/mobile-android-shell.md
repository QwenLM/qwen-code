# Android Mobile Shell (Technical Spike)

[English](mobile-android-shell.md) | [简体中文](mobile-android-shell.zh-CN.md)

Status: implemented and verified locally (Sep 2026). Source: maintainer
direction in QwenLM/qwen-code issue #11704.

## Problem

A phone client for `qwen serve`. The desired shape is a native shell around
the existing Web Shell, not a second UI: the H5 already carries maintained
mobile support (mobile-chromium Playwright project, touch composer, mobile
drawer, responsive breakpoints, browser turn notifications), so the native
layer must add only what a browser genuinely cannot do.

## Current State

- No Android client package exists; `packages/desktop-shell` (Tauri 2) is the
  only native shell precedent and its Android project is greenfield.
- The Web Shell declares its browser floor only after the compatibility work
  (see `web-shell-pwa-installability.md`): Chrome 107+ syntax, `@supports`
  fallbacks, `dvh`.
- Daemon side: per-device revocable credentials on the primary listener do
  not exist yet (maintainer-owned prerequisite); the only client-side
  mitigation today is keystore-bound storage of the bearer token.

## Goals

1. Load the daemon-served Web Shell in a WebView, no local bundling, no
   `--allow-origin` configuration.
2. Support N profiles of (URL, token, display name); switching daemons means
   navigating the WebView to a different origin (same-origin path, the way
   QR-code phone access already works).
3. Detect the WebView engine version at startup and show an explicit
   "update Android System WebView" screen below Chrome 107.
4. Skeletons for keystore-bound token storage and a foreground service that
   keeps SSE alive and raises native notifications (Phase 2).

## Out of Scope

- A native (Compose) UI of any kind; every session, permission, tool-activity
  and diff screen stays the Web Shell's.
- Multi-daemon from one loaded page (expensive, unsupported today); switching
  is by navigation.
- Building on `/acp`; the client uses the documented REST+SSE surface of the
  H5 only.

## Proposed Solution

`packages/mobile-shell` (excluded from the npm workspace; Gradle Kotlin DSL):

- `MainActivity`: WebView shell with same-origin navigation and external
  links opened in the system browser; token passed in the URL fragment
  (`#token=<value>`, read from `window.location.hash` by the Web Shell, never
  sent to the server); back button drives WebView history.
- Profiles in `SharedPreferences` as `(daemon_url, daemon_token,
profile_name)`; Phase 2 moves the token to the Android Keystore.
- `QwenForegroundService` (`dataSync` foreground-service type), notification
  channel, started from the activity; SSE client lands in Phase 2.
- `network_security_config.xml`: cleartext blocked globally, allowed for
  loopback only; operators add LAN hosts explicitly (Android blocks
  cleartext from API 28).
- WebView version check via `WebViewCompat.getCurrentWebViewPackage`, major
  component compared against 107 before any web content loads.

## Design Decisions

- Load whatever daemon the profile names: no local H5 copy, so every request
  is same-origin with the daemon's own served shell, zero cross-origin
  configuration.
- Profiles mint their own stable key: `/capabilities` carries no daemon
  identity and `runId` regenerates on every restart, so the app must persist
  its own profile key and display name.
- Static tokens per daemon (`--token` / `QWEN_SERVER_TOKEN`): auto-generated
  tokens rotate on every restart and would invalidate saved profiles.
- Public TLS is the primary documented path (secure context for SW and voice
  input); HTTP LAN needs the network-security-config entries.
- WebView floor 107 matches the Web Shell `browserslist`; a native check is
  cheaper than supporting old engines, with the honest caveat that devices
  that cannot update WebView cannot be helped.

## Constraints

- `denyBrowserOriginCors` rejects cross-origin requests unless allowlisted;
  same-origin navigation avoids the whole class.
- The daemon token grants code execution on its host; N static bearers on one
  phone raise the risk until per-device revocation exists daemon-side.
- Workspace ids collide across hosts (`sha256(cwd).slice(0,16)`); any native
  cache or draft must be keyed by `(profile, workspaceId)`.
- Capability preflight must be per profile and per connection, never cached
  globally.

## Risks

- WebView versions are device-controlled; the native check covers the floor
  but not devices that cannot update.
- Starting the foreground service unconditionally keeps a notification up
  with no profile; acceptable for the spike, gated in Phase 2.

## Validation

- Manual: emulator/device launch with a loopback daemon profile
  (`#token=` fragment verified in the daemon access log as absent).
- Version gate: force a low WebView version and confirm the update screen
  appears before any web content.
- `npm run build` must not touch this package (excluded from the workspace).
- Kotlin file reviewed against the maintainer's shell shape checklist:
  no second UI, no local H5 bundle, no `/acp`.

## Acceptance Criteria

1. A saved profile loads the daemon-served Web Shell with the token read
   from the URL fragment.
2. Below WebView 107 the app shows the update screen; above it, the shell
   loads.
3. Profiles are (URL, token, display name) tuples; switching navigates to a
   different origin.
4. Cleartext is allowed only for loopback until an operator adds a LAN host.
5. The foreground service runs and shows its notification; no SSE yet
   (Phase 2).

## Follow-ups

- Phase 2: profile picker UI, Android Keystore storage, OkHttp SSE client in
  the foreground service, native turn/permission notifications,
  POST_NOTIFICATIONS runtime request with rationale.
- Rebase the client work onto the daemon per-device credential work when it
  lands (maintainer prerequisite).
