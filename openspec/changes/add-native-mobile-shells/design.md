# Design — add-native-mobile-shells

## Context

The web client built in `add-remote-control` is a PWA: installable to
home screen on iOS and Android, capable of receiving WebPush
(reliably on Android; conditionally on iOS 16.4+). For users whose
phone is their primary remote-control surface, three properties of
the PWA-only path are insufficient:

- **iOS push.** WebPush on iOS requires home-screen install AND user
  permission AND a healthy service worker. Each of those can fail
  silently; the operator has no insight that pushes are dead.
- **Token at rest.** `localStorage` is readable from any browser
  process that has the page open; a phone left unlocked exposes the
  token.
- **Discoverability.** "Open Safari, type a URL, add to home screen,
  enable notifications, install" loses users at every step.

A from-scratch native client (SwiftUI on iOS, Compose on Android)
would solve these but at enormous cost: a separate UI codebase
shadowing every feature in the web client. Every PWA UI change would
need two more implementations. That is the wrong trade for a project
whose web client is, by design, mid-scope.

The right trade is a **thin shell**: the smallest possible native
application that hosts the existing web client and adds exactly the
capabilities a browser cannot provide. This is the Trusted Web
Activity (TWA) pattern on Android and the WKWebView wrapper pattern
on iOS — both well-trodden production patterns.

## Goals / Non-Goals

**Goals:**

- Web codebase is the only UI. Native shells host it.
- Reliable iOS push via APNs, separate from the WebPush pipeline.
- Token stored in Android Keystore / iOS Keychain, optionally gated
  on biometric.
- Native camera for QR pairing (faster than typing a 9-char code).
- Stable launcher icon and app-store distribution channels.
- Forward compatibility: web client and shell evolve at different
  cadences via a versioned bridge contract.

**Non-Goals:**

- Replicating any UI in native code. Settings screens, transcript
  rendering, approval cards — all in the web client.
- Cross-platform UI frameworks (React Native, Flutter, etc.). The
  PWA is already cross-platform; adding a layer that re-renders the
  same UI in non-web tech is unjustified.
- Offline mode. The daemon is the source of truth; offline is a
  separate, harder problem.
- Watch / TV / desktop shells. Phones first.
- Play Store / App Store as the default channel. Self-distribution
  via F-Droid + GitHub + TestFlight; operators who want store
  distribution sign and submit themselves.
- Auto-update of native shell from a curated registry. Operators
  follow GitHub release tags.

## Architecture

```
   ┌──────────────────────────────────────────────────────────────┐
   │ Android phone                                                │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ qwen-rc Android shell (TWA)                            │  │
   │  │  - androidx.browser.trusted.TrustedWebActivityIntent   │  │
   │  │  - default daemon URL (configurable)                   │  │
   │  │  - JS bridge via custom CCT extension                  │  │
   │  │    keystore I/O, QR scanner, biometric prompt          │  │
   │  │  - Service: WebPush wakes the in-TWA SW                │  │
   │  │  - Handles qwen-rc:// custom scheme intents            │  │
   │  └────────────────────────────────────────────────────────┘  │
   │           │ HTTPS                                            │
   └───────────┼────────────────────────────────────────────────────┘
               │
   ┌───────────▼────────────────────────────────────────────────┐
   │ Daemon                                                      │
   │  - serves /ui/* (PWA)                                       │
   │  - all existing endpoints                                   │
   │  - NEW: POST /rc/native-push/apns/register                  │
   │  - NEW: DELETE /rc/native-push/apns/register/:id            │
   │  - NEW: optional APNs sender (P-8 key based)                │
   └───────────▲────────────────────────────────────────────────┘
               │ HTTPS
   ┌───────────┼────────────────────────────────────────────────┐
   │ iOS phone │                                                │
   │  ┌────────┴───────────────────────────────────────────────┐│
   │  │ qwen-rc iOS shell                                      ││
   │  │  - WKWebView host (UIViewController)                   ││
   │  │  - WKUserScript injects window.qwen at document start  ││
   │  │  - WKScriptMessageHandler for token/QR/biometric calls ││
   │  │  - Keychain access (kSecAttrAccessibleWhenUnlocked    ││
   │  │    + kSecAccessControlBiometryCurrentSet optional)     ││
   │  │  - Registers for APNs; reports token to daemon         ││
   │  │  - Handles qwen-rc:// via CFBundleURLTypes             ││
   │  └────────────────────────────────────────────────────────┘│
   └────────────────────────────────────────────────────────────┘
```

The native code on each platform is small — a few Kotlin/Swift
files. The contract between native and web is the JS bridge.

## Bridge contract

The bridge is the only authoritative API across native shells. It
lives at `window.qwen` and is injected by the native side before any
web JS runs.

```ts
interface QwenBridge {
  // Identification and version negotiation
  readonly platform: 'android-twa' | 'ios-wkwebview' | 'web';
  readonly version: { shell: string; bridge: number };

  // Token storage
  getToken(): Promise<string | null>;
  setToken(t: string | null): Promise<void>;
  clearToken(): Promise<void>;

  // Biometric gate
  isBiometricAvailable(): Promise<boolean>;
  requireBiometric(reason: string): Promise<boolean>;

  // QR pairing
  scanQR(opts?: { timeoutSec?: number }): Promise<string>;

  // Native browser hand-off
  openExternal(url: string): Promise<void>;

  // Native push (iOS only)
  registerApns?(): Promise<{ deviceToken: string; bundleId: string }>;
  unregisterApns?(): Promise<void>;
}
```

`bridge: 1` for this change. Web client feature-detects optional
methods. Adding a method bumps `bridge`; removing one is a breaking
change requiring a major shell version.

### Web fallback

When `window.qwen` is undefined (i.e., the PWA is loaded in a normal
browser), `packages/web-client/src/native/bridge.ts` provides a
fallback object with `platform: "web"`, `getToken/setToken` backed
by `localStorage`, `scanQR` backed by `BarcodeDetector` (where
available) or unavailable (rejected promise), `requireBiometric`
backed by WebAuthn (where available) or unavailable, `openExternal`
backed by `window.open(_, '_blank')`.

## Token handoff

### Android TWA

TWA does NOT permit direct JS injection at document-start in the
canonical way WKWebView does. The shell talks to the in-TWA web
content via a small Custom Tabs companion service plus
`postMessage` over a `MessageChannel`. On TWA launch:

1. Shell mints a one-time per-launch `bridgeHandshakeToken` and
   passes it in the intent's `EXTRA_REFERRER`.
2. Web client reads the token from `document.referrer` and posts
   `{ kind: "handshake", token }` to the companion via
   `navigator.serviceWorker.controller`.
3. Companion verifies; replies with the stored bearer or `null`.
4. Web client stores the bearer in-memory for the session, never
   in `localStorage`.

This is more involved than WKWebView's `WKUserScript`. Documented
in `apps/android/README.md` with sequence diagrams.

### iOS WKWebView

WKWebView supports `WKUserScript` injected at
`atDocumentStart`. The shell injects:

```javascript
window.qwen = {
  platform: "ios-wkwebview",
  version: { shell: "1.0.0", bridge: 1 },
  __pendingToken: <bearer-from-keychain-or-null>,
  // methods bound to webkit.messageHandlers below
};
```

Method calls go through `window.webkit.messageHandlers.<name>.postMessage`.
A small JS shim in the injected script wraps each handler in a
Promise that resolves when the native side calls back via
`webView.evaluateJavaScript("window.qwen.__resolve('<id>', …)")`.

The bearer is read from Keychain at startup (after biometric prompt
if required) and passed in as `__pendingToken`. Web client reads it
once and clears the field.

## QR pairing

Native shell exposes `scanQR()`. Implementation:

- Android: standard MLKit / ZXing scanner activity. Returns the
  recognized text or rejects on cancel/timeout.
- iOS: `AVCaptureMetadataOutput` with `AVMetadataObject.ObjectType.qr`.
  Returns the recognized text or rejects on cancel/timeout.

QR payload format (defined here, used by the workstation
`qwen rc pair --qr` command):

```
qwen-rc-pair:<base32-Crockford-9char-code>;url=<daemon-https-url>
```

Web client receives the string, parses, calls
`POST /rc/pair/redeem` against the parsed URL with the code. On
success, stores the token via `window.qwen.setToken(token)` which
the native shell writes to Keychain / Keystore.

## Custom URL scheme

Both shells register the scheme `qwen-rc://`. Routes:

| URL                                    | Behavior                                  |
| -------------------------------------- | ----------------------------------------- |
| `qwen-rc://session/<sid>`              | Open shell, navigate web to session `sid` |
| `qwen-rc://session/<sid>?event=<eid>`  | Same, scrolled/focused on event           |
| `qwen-rc://permission/<pid>`           | Same, scrolled to permission `pid` card   |
| `qwen-rc://pair?code=<code>&url=<url>` | Open shell, attempt pairing               |

Notification taps (from APNs payloads or WebPush) use these URLs in
their `click_action` / `category` payload. The shell intercepts and
navigates the WebView accordingly.

## iOS push (APNs)

This is the most operator-friction-heavy piece. The daemon needs an
APNs P-8 key, key id, team id, and bundle id to send pushes. These
are typically obtained from the operator's Apple Developer account.

### Operator setup

1. Operator obtains a P-8 key file via Apple Developer portal.
2. Stores at `~/.qwen/rc/apns/AuthKey_<keyid>.p8` mode 0600.
3. Adds to daemon config:

   ```toml
   [native_push.apns]
   enabled = true
   key_path = "~/.qwen/rc/apns/AuthKey_ABC123.p8"
   key_id = "ABC123"
   team_id = "DEF456"
   bundle_id = "dev.qwen.rc"
   environment = "sandbox"  # or "production"
   ```

4. Restarts daemon. `/capabilities` `nativeShells.apnsEnabled: true`.

### Registration

Shell registers for remote notifications:

- iOS: `UIApplication.shared.registerForRemoteNotifications()`
- On `didRegisterForRemoteNotificationsWithDeviceToken`, shell
  POSTs the hex-encoded device token to
  `POST /rc/native-push/apns/register { deviceToken, bundleId,
shellVersion }` with its bearer.

The daemon stores `(tokenId, apnsDeviceToken, bundleId)` in a new
`apns_subscriptions` table. The routing module from
`add-notification-routing` treats APNs subscriptions as just
another delivery target alongside WebPush; rules don't distinguish.

### Send

APNs sender mirrors the WebPush sender. JWT signed with P-8 key
(`ES256`, header `kid: key_id`, claims `iss: team_id, iat`); HTTP/2
POST to `api.sandbox.push.apple.com` or `api.push.apple.com`. Same
payload schema, with the iOS notification fields populated. On `410
Unregistered` or `400 BadDeviceToken`, drop the subscription (same
pattern as WebPush 410/404).

If P-8 key is absent or `enabled = false`, the daemon advertises
`apnsEnabled: false` and the iOS shell falls back to WebPush
(degraded but functional).

## Distribution

### Android

- **F-Droid.** Recipe under `apps/android/fastlane/metadata/`
  pointing at a tagged release commit. Reproducible build verified
  by F-Droid's CI; no Google Play Services dep.
- **GitHub Releases.** Signed APK + AAB attached to each release
  tag.
- **Play Store.** Not shipped by default. Operators who want Play
  Store distribution sign their own version with their key and
  upload. We document the upload steps but do not maintain a Play
  Store listing.

### iOS

- **TestFlight.** Operators with an Apple Developer account
  ($99/yr) build and submit to TestFlight, then invite themselves.
  We provide the Xcode project; we do not provide signing.
- **App Store.** Not shipped. Apple's review for "remote terminal
  control" apps is unpredictable; we don't pretend it's a one-click
  path.

This distribution model is deliberate: operators who set up a
self-hosted daemon already accept some operations cost. Adding "set
up your own Apple Developer account if you want iOS push" is in
keeping. Documented prominently in `apps/ios/README.md`.

## Decisions

### D1 — TWA on Android, WKWebView on iOS; no React Native

**Choice**: Thin native wrappers around the web client. No
cross-platform native UI framework.

**Alternative considered**: React Native or Capacitor — write the
shell logic once, deploy to both.

**Why**: TWA on Android is the Google-blessed pattern for "PWA in a
shell"; it gets the system browser's update cadence and storage
isolation. WKWebView on iOS is similarly the standard. RN/Capacitor
adds a runtime, an SDK, a build pipeline, and ongoing version
churn — all to ship the same web view under it. The bridge surface
is small enough (six methods) that hand-writing per-platform Kotlin
and Swift is cheaper than the cross-platform framework's overhead.

**Cost**: Two native codebases instead of one. Bounded by the
small bridge surface; <500 LoC each in practice.

### D2 — Bridge contract versioned by integer, feature-detected

**Choice**: `window.qwen.version.bridge` is an integer. Web client
checks `'method' in window.qwen` before calling optional methods.
Adding methods bumps the integer; removing methods requires major
shell version bump and a web-client version guard.

**Alternative considered**: SemVer string, or pre-flight handshake
where shell declares supported methods.

**Why**: Integer + feature detection is the simplest contract that
survives shell-and-web update skew. SemVer requires a comparator;
pre-flight handshake adds an async boot step. The bridge surface is
small and grows slowly.

**Cost**: A future "this method's semantics changed" change cannot
be expressed via the integer alone. Compensated by feature
detection: a renamed method is a new method.

### D3 — APNs handled directly by the daemon, not via a relay

**Choice**: The daemon signs JWTs and posts to `api.push.apple.com`
directly using the operator's P-8 key.

**Alternative considered**: Use a third-party relay (Firebase,
OneSignal, Pushwoosh) that handles APNs.

**Why**: The architectural commitment from `add-remote-control` is
"no vendor relay we operate." Letting Firebase see the encrypted
push metadata reintroduces that. Operators who balk at the P-8
setup can run without iOS-native push; WebPush degrades gracefully.

**Cost**: Operator must set up an Apple Developer account.
Documented as opt-in.

### D4 — Token in keystore optionally gated by biometric

**Choice**: Token is stored in Android Keystore / iOS Keychain.
Biometric gate is opt-in at pairing time (per-shell setting). When
enabled, biometric prompt fires on every cold start.

**Alternative considered**: Always require biometric; never require
biometric.

**Why**: "Always require" punishes users without biometric hardware
(rare but real, especially older Android). "Never require" loses
the unlocked-phone-attack mitigation. Opt-in at pairing time gives
operators the choice, with a sensible default (off; explicit toggle
at pairing).

**Cost**: A toggle in the pairing UI. Trivial.

### D5 — One installable shell per phone, no in-shell daemon switching

**Choice**: A shell is configured with exactly one daemon URL at
first launch (or after a "factory reset" action). To use a
different daemon, the operator wipes the shell's storage
("Forget this daemon") and pairs anew.

**Alternative considered**: Multi-daemon support inside one shell,
like an SSH client's host list.

**Why**: Multi-daemon adds token-management UX, accidental-pairing-
wrong-daemon risk, and confusion when an event arrives via APNs
("which daemon was this?"). For the operator-hosted model, one
shell per daemon is fine; reinstall is cheap. If operators ask for
multi-daemon, a follow-up change can add it on top of this bridge
contract.

**Cost**: Operators managing N daemons install N "qwen-rc" apps
side by side (each is its own bundle id). Acceptable; F-Droid
allows it.

### D6 — F-Droid + GitHub Releases + TestFlight, not stores

**Choice**: Default distribution is F-Droid (Android), GitHub
Releases (Android APK), TestFlight (iOS). Play Store and App Store
are NOT default channels.

**Alternative considered**: Play Store as default.

**Why**: Project ethos is self-hosted, no vendor relay. Play Store
review adds friction. F-Droid policy (reproducible builds, no
proprietary deps) aligns with the rest of this stack. App Store is
even higher friction; TestFlight gets the operator past the worst
of the friction.

**Cost**: Some operators expect "search in Play Store" discovery.
Documented.

## Threat model

| Attacker                              | Capability                                  | Mitigation                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen unlocked phone                 | Open shell, drive session                   | Biometric gate (opt-in) re-prompts on app foreground. Token in keystore, not page memory.                                                                                   |
| Stolen locked phone                   | Read storage                                | Android Keystore / iOS Keychain protect ciphertext at rest. Requires device unlock + (if set) biometric.                                                                    |
| Malicious WebView content (XSS)       | Steal token via JS bridge                   | Bridge methods are scoped: `getToken` returns the bearer only AFTER biometric (if required); web code holds in-memory only; CSP blocks 3rd-party JS.                        |
| Compromised daemon URL DNS            | Phish a fresh pairing onto the wrong server | Pairing flow shows the daemon's fingerprint (TLS cert SHA-256) before accepting; operator visually compares with their workstation. Documented; UI shows in pairing screen. |
| MITM TLS on daemon URL                | Read traffic                                | Daemon serves over TLS (existing); shell pins to the daemon's TLS cert SHA-256 on first pair; cert change → manual confirm.                                                 |
| Custom-scheme abuse                   | Malicious app sends qwen-rc:// URLs         | Shell handlers VALIDATE the path; pairing scheme requires URL == previously-paired daemon URL; unknown URLs show a confirmation dialog.                                     |
| APNs P-8 key leak                     | Attacker impersonates this app to APNs      | P-8 file mode 0600; rotated via Apple Developer portal; subscriptions re-bind on next app launch.                                                                           |
| Token leak (out-of-band)              | Drive session until revoke                  | Same as web-client token leak; daemon revoke is the remedy. Keystore makes leak harder to start with.                                                                       |
| Side-loaded malicious "qwen-rc" build | Pretends to be ours, captures pairing       | Reproducible F-Droid builds; signed GitHub releases with SHA-256 in release notes; operator verifies.                                                                       |

## Risks / Trade-offs

| Risk                                         | Likelihood | Impact | Mitigation                                                                                        |
| -------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Apple changes WKWebView semantics            | M          | M      | Bridge wraps narrow surface; periodic re-test against new iOS majors. Document iOS minimum.       |
| TWA verification (digital asset links) fails | M          | M      | Provide both TWA (full screen) and Custom Tab fallback. Asset-link file documented.               |
| F-Droid build reproducibility breaks         | M          | L      | CI builds and compares to F-Droid build server; mismatches block release.                         |
| iOS push P-8 key rotation breaks all subs    | L          | M      | Subscriptions self-heal on next launch (re-register with new key id).                             |
| Operator can't get Apple Dev account         | M          | M      | iOS shell still works with WebPush only — degraded but functional.                                |
| Bridge version skew (old shell, new web)     | M          | L      | Feature detection in web client; missing features degrade, not crash. Documented.                 |
| WebView storage gets cleared by OS           | L          | M      | Token in keystore is preserved; web client re-injects on next launch via handshake.               |
| Custom scheme conflict with another app      | L          | L      | `qwen-rc://` is namespaced enough that collision is unlikely; documented as the canonical scheme. |

## Open questions

1. **Should the iOS shell minimum version be iOS 15 or iOS 16?**
   16 gets us better WKWebView APIs and Live Activities (not used
   here but future-relevant). 15 is more inclusive. Leaning 16;
   revisit during alpha testing.

2. **Bundle id namespace.** `dev.qwen.rc` is fine for our F-Droid
   build but an operator self-distributing on TestFlight will use
   their own bundle id (forced by Apple Developer). Document that
   APNs subscriptions are bundle-id-scoped; daemon must accept any
   bundle id the operator configures.

3. **Should the Android shell support arbitrary daemon URL on every
   launch, or pin after first pair?** D5 says pin. But operators who
   want to test against `localhost:4170` in dev would prefer an
   unlocked "switch daemon" screen. Compromise: a "developer mode"
   toggle (off by default) unlocks daemon-URL switching.

4. **Watch / Wear support.** Out of scope per Non-Goals, but the
   bridge contract leaves room for a future `qwen.deliverToWatch`
   method. Document; do not implement.

5. **iOS Live Activities for in-flight permission prompts.** Could
   render the approval card on the lock screen without unlock.
   Compelling UX; not in scope this change. Future change can add
   if push payload schema is extended.

6. **Reproducible iOS builds.** Apple does not support reproducible
   builds in the F-Droid sense. We document this as an asymmetry;
   operators self-sign and accept it.
