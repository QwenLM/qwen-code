# Qwen Code Mobile Shell (Android)

A development WebView shell around the daemon-served Web Shell. Native connection profiles use a Keystore-encrypted vault and isolated browser profiles. Per-device daemon credential revocation, background SSE and native notifications remain future work. See the [connection-profile design and reviewer test plan](../../docs/design/mobile-connection-profiles.md).

## Build

Use JDK 17 and Android SDK platform/build tools 34. Configure `ANDROID_HOME` or an untracked `local.properties` containing `sdk.dir=/path/to/android-sdk`. From this directory:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

On Windows use `gradlew.bat`. The committed wrapper pins Gradle 8.2.1 and verifies its distribution checksum. The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. This native package is excluded from npm and pnpm workspaces.

## Connection Profiles

Open the app and choose **Add connection**. Enter a display name, a daemon origin and its bearer token, then Save and Connect. The native Connections button returns to the profile list. Profiles can be renamed, edited and deleted. Editing an origin requires entering its token again or explicitly deselecting **Keep the saved credential**. A blank token without Keep means no saved credential. Deleting a local profile does not revoke a daemon credential.

Native connection data is encrypted with an Android Keystore AES-GCM key and atomically saved in the app's no-backup directory. Token fields do not reveal a previously saved token. A missing key or corrupt vault shows Retry/Reset instead of connecting with different credentials. Reset deletes saved native connections after confirmation; they must then be entered again.

Existing development installations are migrated automatically from the old private `shared_prefs/qwen_profiles.xml` format:

```xml
<?xml version="1.0" encoding="utf-8"?>
<map>
    <string name="daemon_url">https://daemon.example.com</string>
    <string name="daemon_token">YOUR_DEVELOPMENT_TOKEN</string>
</map>
```

Use the native editor for new profiles. Migration encrypts and verifies the new vault before removing the old preferences. If migration fails, connection remains disabled and the old data is retained until recovery succeeds. Use an HTTP(S) origin with an optional trailing slash; paths, query strings, fragments and user information are rejected.

The token is passed to the H5 in an encoded URL fragment, absent from the navigation request. The H5 uses it for authenticated API calls and retains its existing per-tab sessionStorage behavior. Chromium does not guarantee sessionStorage is memory-only: this PR encrypts native saved credentials, not every token copy held by WebView. Backup/device transfer excludes the native vault and browser data. A static `--token` or `QWEN_SERVER_TOKEN` avoids daemon-restart invalidation during development; it is not per-device revocation.

## Runtime Requirements

Android API 26+ and Android System WebView 111+ with the AndroidX `MULTI_PROFILE` capability. New, migrated or recovered browser profiles also require `DELETE_BROWSING_DATA`. Version 111 or `MULTI_PROFILE` alone is insufficient: WebView 124 can reuse old storage for a fresh name after rapid process termination and lacks the complete-clearing capability. Profile management remains usable, but Connect displays an update message when safe initialization is unavailable. There is no shared-profile fallback.

Before first use, the app clears the connection's complete browser storage through the official completion callback and durably records initialization before loading any page or token. Updating from the previous vault format preserves native credentials but clears existing browser sessions/cache once. A name missing from the provider's registry requires another clear even if the native flag was saved. Known initialized profiles retain browser state; changing origin or credential starts with a new uninitialized identity. Returning to Connections or destroying the Activity cancels preparation. See the [initialization guard design](../../docs/design/mobile-profile-initialization.md).

Use HTTPS for remote daemons. Cleartext is disabled except for explicit loopback entries; LAN HTTP hosts need explicit network-security configuration. Secure web APIs require HTTPS or a trustworthy loopback origin.

An emulator's localhost is the emulator itself. For a host daemon on port 4170,
run `adb reverse tcp:4170 tcp:4170` and use `http://127.0.0.1:4170` in the
profile. **Never use a token-less daemon through this tunnel on a physical
device:** every app that can reach the device loopback port can then use the
host daemon as you. Start it with bearer authentication, for example
`QWEN_SERVER_TOKEN=$(openssl rand -hex 32) qwen serve --require-auth`, and save
the same value as `daemon_token` in the development profile. The app trusts
system certificate authorities; a host-only or
user-installed development CA is not automatically trusted by this WebView.
Use a certificate chain trusted by the device. Certificate errors are not bypassed.
The first Gradle build needs network access; offline builds require a populated
Gradle and SDK cache.

The H5 loads directly from the daemon, without a local copy. Direct same-origin HTTP API calls need no extra CORS
configuration. Reverse proxies and remote terminal/voice WebSocket connections
retain the daemon's [origin requirements](../../docs/users/qwen-serve.md#security-threat-model). Same-origin navigation compares scheme, host and effective port. Supported external main-frame links open in other apps; file/content and mixed-content access are disabled. Connection failures show a native Retry screen.

## Microphone

Existing Web Shell dictation can request audio capture from its connected daemon origin. A native prompt names that origin and asks for explicit consent before Android recording permission. Camera, mixed audio/video, unknown permissions and requests from other origins are denied. Permission is not requested on startup; denying it leaves text chat available. A compatible daemon with voice configured and a secure web context are still required.

A microphone-enabled connection closes when the app leaves the foreground, even if dictation already stopped. This also applies when another full-screen app, including a document picker, opens. Unsent page state may be lost; the prompt explains this before consent, and returning offers manual reconnection. Text-only connections remain open. This conservative development-client behavior prevents background capture without a new JavaScript bridge. See the [microphone design](../../docs/design/mobile-microphone-permission.md).

## Limitations

This is not a released production mobile client. File selection, downloads and new-window handling still need native integrations. System font-scale integration and full pinch-zoom/accessibility acceptance remain follow-ups. Renderer failure offers a new connection. No foreground service runs. The Web Shell probes its existing capabilities on each fresh connection; this slice adds no native workspace cache or native REST client. Phase 2 still requires maintainer-provided per-device revocation, background SSE, notification permissions and a stronger H5 token-persistence contract.

JVM tests and APK compilation are separate from emulator/physical-device acceptance. Consult the PR verification report for actual completed checks; source presence does not establish device validation.
