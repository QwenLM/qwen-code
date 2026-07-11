# add-native-mobile-shells

## Why

The PWA shipped in `add-remote-control` works in any modern browser,
and `add-webpush-notifications` covers push delivery across Chrome,
Firefox, and (with a home-screen install) iOS Safari 16.4+. Three
real-world gaps remain that browsers alone cannot close:

1. **iOS push reliability.** iOS WebPush requires the PWA to be
   installed to the home screen AND the user to have manually
   accepted permission. In practice, a meaningful fraction of users
   never complete that flow, and even when they do, the iOS Safari
   service worker can be evicted at any time. A TestFlight build with
   a real APNs entitlement is the only reliable way to ping an
   operator who keeps their phone in a drawer.
2. **Token at rest is browser-storage.** The PWA stores the bearer in
   `localStorage` per origin. On a stolen unlocked phone that's
   sufficient to drive the session. Native shells can move the token
   into Android Keystore / iOS Keychain and gate access on Face ID /
   Touch ID / biometric or device PIN.
3. **App-store discovery and a stable launcher icon.** A subset of
   operators want to install via Play Store / TestFlight / F-Droid,
   not "open Safari, navigate to a URL, add to home screen, click
   through three permission dialogs." A shell on the store is just an
   icon they tap.

The cheap-and-correct way to deliver all three is a **thin shell**
around the existing PWA, not a from-scratch native rewrite. Android
uses a Trusted Web Activity (TWA) via `androidx.browser`; iOS uses
a WKWebView wrapper. The TypeScript web codebase remains the single
source of truth. Native code exists only to provide keystore
storage, biometric gating, camera permission for QR pairing, push
plumbing, and a stable home-screen icon.

## What Changes

- **Android shell (TWA).** Empty Android project under
  `apps/android/` using `androidx.browser` Trusted Web Activity.
  Loads the operator-configured daemon URL. Built with Gradle;
  signed APK and AAB outputs.
- **iOS shell (WKWebView).** Xcode project under `apps/ios/` with a
  single `WKWebView` controller, a Swift bridge for keystore + QR +
  push, and a configurable daemon URL. Built with `xcodebuild`;
  TestFlight-distributable.
- **Token in platform keystore.** Native shells store the bearer in
  Android Keystore / iOS Keychain (item attributes:
  `whenUnlocked` access control, biometric requirement opt-in).
  Native code exposes `getToken()` / `setToken()` / `clearToken()`
  to the WebView via a `qwen` JS object injected at navigation
  time. The web codebase calls `window.qwen.getToken()` when
  available; falls back to `localStorage` when running in a regular
  browser.
- **Token handoff.** On WebView startup, native shell injects
  `window.qwen.token = <stored>` via an evaluateJavaScript /
  `WKUserScript` at document start. Web code reads it once at boot
  and clears the global. Subsequent updates (post-pairing) flow
  through `window.qwen.setToken(newToken)`.
- **QR pairing via native camera.** Native shell exposes
  `qwen.scanQR(): Promise<string>`. On call, native presents the
  platform camera UI with a QR scanner overlay. The recognized text
  is returned to the WebView. Web client passes that to the
  pairing endpoint.
- **Custom URL scheme `qwen-rc://`.** Notification taps deep-link
  via `qwen-rc://session/<id>?event=<id>`. Native shell handles the
  scheme and navigates the WebView to the corresponding deep route.
- **Push.** On iOS, native shell registers for APNs at first
  launch (after user acceptance); on receipt, the native APNs token
  is POSTed to a new daemon endpoint
  `POST /rc/native-push/apns/register` so the daemon can drive
  APNs directly (using a small APNs client built around a P-8 key
  the operator supplies). On Android, the shell still uses
  WebPush — Android browsers' push pipeline is solid enough that
  duplicating with FCM is not worth the operator burden of
  managing FCM keys.
- **JS bridge contract.** Native shells implement a small, stable
  bridge:

  ```ts
  window.qwen = {
    platform: "android-twa" | "ios-wkwebview" | "web",
    getToken(): Promise<string | null>,
    setToken(t: string | null): Promise<void>,
    requireBiometric(): Promise<boolean>,
    scanQR(): Promise<string>,
    openExternal(url: string): Promise<void>,
    registerApns?(): Promise<string>,
    version: { shell: string, bridge: number },
  };
  ```

- **Distribution.**
  - Android: F-Droid (recipe in `apps/android/fastlane/`) and
    GitHub Releases (signed APK). Play Store NOT shipped by default;
    documented as opt-in if the operator wants it.
  - iOS: TestFlight (signed by the operator's Apple Developer
    account; operator-distribution model documented). App Store NOT
    shipped by default.
- **Update strategy.** Web content loaded from the daemon URL —
  any web-only change requires no shell update. Shell version bumps
  only for: keystore behavior, custom-scheme changes, OS API
  changes (Android target SDK, iOS minimum version),
  bridge-contract changes.

## Capabilities

### New Capabilities

- `native-mobile-shells` — bridge contract between native shells
  and the PWA, keystore behavior, QR pairing flow, custom URL
  scheme, distribution model, version compatibility rules.

## User Stories

**M1. Install from F-Droid, pair, biometric-protected.** I install
the qwen-rc app from F-Droid on Android. On first launch I enter the
daemon URL `https://qwen.evan.tail-xxxx.ts.net`. The shell asks
camera permission; I scan a QR pairing code displayed on my
workstation. The shell pairs, stores the token in Android Keystore
with biometric gate. From now on every launch asks for fingerprint
before showing the web client.

**M2. iOS push that survives.** I install the TestFlight build on
iOS. The shell registers for APNs and POSTs the device token to my
daemon. Overnight, the daemon's APNs sender (using my P-8 key) pings
my phone directly — no Safari, no PWA install dance, no service
worker eviction risk. I tap the notification, biometric unlock, and
the shell opens to the approval card.

**M3. Stolen unlocked phone is still gated.** Phone left unlocked on
a café table. Attacker opens the qwen-rc app. The shell requires a
biometric (since I enabled `requireBiometric: true` at pairing).
Attacker has no fingerprint. They cannot read the token; they
cannot drive the session.

**M4. Web update without shell update.** I ship a UI change to the
web client. Tomorrow's daemon serves the new bundle. Every native
shell loads the new bundle on next launch automatically — no app
store update.

**M5. Bridge contract bump.** I add a new method
`qwen.shareViaSystemSheet(text)` to the bridge. Web client
feature-detects (`if ('shareViaSystemSheet' in window.qwen)`);
shells that haven't updated simply lack the feature. No breakage;
operators can update shells when convenient.

**M6. Daemon URL rotates.** I changed my Tailscale name. I open the
shell's settings, type the new URL, and pair again. The old token
is cleared from keystore.

## Impact

- **qwen-code repo**:
  - New top-level `apps/android/` — Gradle/Kotlin TWA project.
  - New top-level `apps/ios/` — Xcode/Swift project with a
    `WKWebView` host and Swift bridge.
  - New web-client interface
    `packages/web-client/src/native/bridge.ts` exposing typed
    accessors for `window.qwen` with a `web` fallback shim.
- **Daemon**: two new endpoints —
  `POST /rc/native-push/apns/register` (store device token bound
  to a paired token) and `DELETE
/rc/native-push/apns/register/:id`. An optional APNs sender
  (operator supplies a P-8 key file + key id + team id via daemon
  config). When the P-8 file is absent, iOS native push is silently
  disabled and the shell falls back to WebPush as if on the web.
- **Capability response**: `remoteControl.nativeShells` block
  listing `bridgeVersion`, `apnsEnabled`, supported platforms.
- **Repo CI**: optional Android Gradle build job; iOS build job
  requires self-hosted macOS runner and is documented but not
  automated by default.
- **Out of scope** (deliberately):
  - Rewriting any part of the UI in SwiftUI, Jetpack Compose, or
    React Native. The web client remains the only UI implementation.
  - Offline functionality. The shell is a viewer for a live daemon;
    no offline cache beyond what the service worker already does.
  - Native widgets / lock-screen complications / Live Activities.
    Push is the only out-of-app surface.
  - Watch apps (Apple Watch / Wear OS).
  - Play Store / App Store distribution as default. Operators who
    want store distribution sign and submit themselves; we
    document the gotchas.
  - Cross-shell sync (e.g., "Android shell pairing visible on iOS
    shell"). Each install is a separate paired client.
