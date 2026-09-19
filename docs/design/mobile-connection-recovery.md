# Android connection recovery

[中文](./mobile-connection-recovery.zh-CN.md)

## Problem and current state

The Android profile foundation (#12121) always opens the connection list when Android recreates its Activity. Renderer failure already offers Retry, but reconnecting loses the selected session/workspace. A rotation normally follows `configChanges`, so a rotation-only test does not exercise this gap.

## Proposed behavior

Keep a small connection snapshot containing the profile ID, browser generation ID, and allowlisted Web Shell navigation. Save it in Android instance state while a connection is active. Recreating the Activity reloads the encrypted vault, matches both IDs, passes the existing browser initialization checks, and creates a fresh WebView. A rename preserves the generation; deleting a profile or changing its origin/token prevents restoration. A normal cold launch without Android saved state still shows Connections.

Track navigation using WebView history callbacks, including H5 `history.replaceState`. Restore only `/` or `/session/<id>`, the optional `workspace` identifier, and `context=standalone|live`. Identifiers are bounded ASCII letters, digits, `_` and `-`. Foreign origins, user information, malformed routes, duplicate/unknown query parameters and invalid identifiers fall back to the profile root. Fragments are discarded. Saved state never contains the daemon origin, bearer, raw URL, WebView history, form values or page content. Credentials come exclusively from the current vault entry and are attached to the fresh load as in the existing connection flow.

Cache the sanitized route while the renderer is alive. Renderer failure captures that snapshot before destroying the old WebView and keeps Retry explicit. Recreating an Activity on the failure screen preserves that explicit Retry choice. Choosing Connections clears recovery state. Normal connection errors similarly offer an explicit retry at the sanitized route; this is not an automatic retry loop.

## Components and decisions

- `ConnectionNavigation.kt`: pure route validation and canonical reconstruction, independently unit tested.
- `ConnectionRecovery.kt`: bounded Bundle serialization and profile generation matching; no credential serialization.
- `MainActivity.kt`: fresh-vault restore, history tracking, explicit recovery and instance-state wiring.
- Native device tests: real Activity recreation and renderer termination against an embedded loopback fixture. Profile state is restored/cleaned without wiping app data.

Do not use `WebView.saveState`/`restoreState`: they preserve more browsing state than this feature needs. Do not persist navigation in preferences or add a JavaScript bridge. The existing native picker/permission controllers retain responsibility for cancelling old callbacks and reserving late-result slots when this slice is combined with them.

## Acceptance

Recreation returns to the same profile/session/workspace in a fresh named-profile WebView. Same-origin profiles remain isolated. Renames restore; deletion and credential/origin rotation do not. The saved Bundle contains only the documented identifiers and retry flag. A killed renderer offers Retry and reconnects to the same route with current vault credentials. Unsupported WebView providers still fail closed. Cancelling or leaving a connection does not silently reopen it.

## Scope and open work

Only saved Android instance state is restored, not force-stop, task removal or arbitrary cold launches. Unsent drafts, scroll position, browser history, recording, permissions and pending native file operations are not resumed. This does not establish physical-device, TalkBack, real voice-backend or server-side per-device revocation acceptance. The separate microphone slice deliberately tears down microphone-authorized connections when backgrounded, including full-screen document pickers; this policy is not relaxed here. Production credentials, notifications and official release/signing remain separate Phase 2 work. No new server protocol is required.
