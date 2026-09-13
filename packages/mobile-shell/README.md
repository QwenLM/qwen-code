# Qwen Code Mobile Shell (Android)

A thin Android WebView shell around the daemon-served Web Shell. It does not
contain a second UI: every screen except two bootstrap placeholders is the
same Web Shell the daemon already serves to browsers. The native layer adds
only what a browser cannot do: keystore-bound credential storage and a
foreground service for SSE (both Phase 2, skeletons in place).

## Architecture

- `MainActivity` loads the daemon origin in a `WebView` and passes the bearer
  token in the URL fragment (`#token=<value>`). The Web Shell reads it from
  `window.location.hash`, so the token is never sent to the server.
- Profiles are stored in `SharedPreferences` as a `(URL, token, display
name)` tuple (`daemon_url`, `daemon_token`, `profile_name`). Switching
  daemons means navigating the WebView to a different origin; each
  navigation loads a fresh same-origin document.
- `QwenForegroundService` is a foreground-service skeleton (`dataSync` type)
  that will keep the SSE stream alive and raise native notifications.

## Daemon requirements

- Every profile must point at a daemon started with a **static token**:
  `--token <value>` or `QWEN_SERVER_TOKEN`. Auto-generated tokens rotate on
  every restart and would silently invalidate saved profiles.
- Prefer a public profile over real TLS (`--tls-cert` / `--tls-key`). Only a
  secure context enables service workers and voice input in the H5.
  Plain-HTTP LAN profiles work but need entries in
  `app/src/main/res/xml/network_security_config.xml` (loopback is allowed by
  default for development).
- The H5 is served by the daemon. Do not bundle the Web Shell locally: a
  locally bundled copy would make every request cross-origin and require
  `--allow-origin` configuration.

## WebView requirement

The Web Shell targets Chrome 107+ (see `packages/web-shell/package.json`
`browserslist`). On launch `MainActivity` checks the Android System WebView
version and shows an explicit "update WebView" screen below that floor.

## Build

Requires JDK 17+ and the Android SDK. From `packages/mobile-shell`:

```bash
gradle :app:assembleDebug
```

## Status

- Phase 1: WebView shell, token fragment, profile storage, native WebView
  version check, foreground-service skeleton.
- Phase 2 (planned): profile picker UI, Android Keystore credential storage,
  OkHttp SSE client in the foreground service, native turn/permission
  notifications, request POST_NOTIFICATIONS with rationale.
