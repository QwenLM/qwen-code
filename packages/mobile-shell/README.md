# Qwen Code Mobile Shell (Android)

A development-only WebView spike around the daemon-served Web Shell. It has one saved development profile and native bootstrap/error messages. Production profile management, Keystore storage, per-device revocation, background SSE and native notifications are future work. See the [design and reviewer test plan](../../docs/design/mobile-android-shell.md).

## Build

Use JDK 17 and Android SDK platform/build tools 34. Configure `ANDROID_HOME` or an untracked `local.properties` containing `sdk.dir=/path/to/android-sdk`. From this directory:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

On Windows use `gradlew.bat`. The committed wrapper pins Gradle 8.2.1 and verifies its distribution checksum. The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. This native package is excluded from npm and pnpm workspaces.

## Development Profile

A debug installation can be provisioned through Android Studio Device Explorer in the application's private `shared_prefs/qwen_profiles.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<map>
    <string name="daemon_url">https://daemon.example.com</string>
    <string name="daemon_token">YOUR_DEVELOPMENT_TOKEN</string>
</map>
```

Stop the application before changing preferences and relaunch afterward. Use an HTTP(S) origin with an optional trailing slash; paths, query strings, fragments and user information are rejected. There is no profile editor or multi-profile switching in this spike.

The token is passed to the H5 in an encoded URL fragment, absent from the navigation request. The H5 uses it for authenticated API calls. A static `--token` or `QWEN_SERVER_TOKEN` avoids daemon-restart invalidation during development. This plaintext development storage is not a production credential solution; backup and device transfer exclude it.

## Runtime Requirements

Android API 26+ and Android System WebView 111+. The provider is checked before constructing a WebView, so unsupported or missing providers receive a native update message.

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

## Limitations

This is not a released mobile client. File selection, microphone permission bridging, downloads, new-window handling and renderer-process recovery still need native integrations. System font-scale integration and full pinch-zoom/accessibility acceptance remain follow-ups. No foreground service runs. Phase 2 also requires profile keys and switching, capability checks per connection, credential migration, maintainer-provided per-device revocation, Keystore storage, background SSE and notification permissions.

JVM tests and APK compilation are separate from emulator/physical-device acceptance. Consult the PR verification report for actual completed checks; source presence does not establish device validation.
