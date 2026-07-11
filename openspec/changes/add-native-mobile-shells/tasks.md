# tasks — add-native-mobile-shells

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Shared design

**Effort:** ~1 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed` (web client
    > is reachable at `/ui/` and PWA-installable). Verify
    > `add-webpush-notifications` Phase 5 `completed` (so we know
    > the payload schema we mirror for APNs). If either is not
    > completed, mark this change as blocked. Confirm the web
    > client is loadable from a non-Chrome WebView (test in
    > `apps/manual/webview-probe.html` if it doesn't exist
    > already).
    > Set Status to `in-progress` before any other tool call.

- [ ] **0.1 Bridge TS interface + web fallback**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/web-client/src/native/bridge.ts`,
    `packages/web-client/src/native/bridge.types.ts`
  - **Prompt:**
    > Define `QwenBridge` per `design.md` "Bridge contract". Export
    > a singleton `bridge: QwenBridge` that is either
    > `window.qwen` or a web-fallback object backed by
    > `localStorage` / `BarcodeDetector` / `WebAuthn` /
    > `window.open`. Feature-detect optional methods at the call
    > site, never at instantiation. Acceptance: scenarios under
    > `Requirement: Bridge contract surface` from
    > `specs/native-mobile-shells/spec.md`.

- [ ] **0.2 PWA reads from bridge**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/web-client/src/auth/tokenStore.ts`
  - **Prompt:**
    > Replace direct `localStorage` token reads/writes with
    > `bridge.getToken()` / `bridge.setToken(t)`. The PWA must
    > behave identically in a plain browser (web fallback) and in
    > a native shell. Acceptance: existing PWA integration tests
    > pass; new test stubs `window.qwen` and verifies the
    > tokenStore calls bridge instead of localStorage.

## Phase 1 — Android TWA shell

**Effort:** ~3 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Decide Gradle / AGP versions
    > and Android target/min SDK (target latest stable, min 26
    > suggested). Record decisions here. Verify CI runner supports
    > Android SDK; if not, mark Android CI as "manual build only".

- [ ] **1.1 TWA project skeleton**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:**
    `apps/android/build.gradle.kts`,
    `apps/android/app/build.gradle.kts`,
    `apps/android/app/src/main/AndroidManifest.xml`,
    `apps/android/app/src/main/java/dev/qwen/rc/MainActivity.kt`
  - **Prompt:**
    > `androidx.browser:browser:latest` dep. `MainActivity`
    > launches a `TrustedWebActivityIntentBuilder` with the
    > configured daemon URL. First-launch screen captures the
    > daemon URL into shared prefs. Acceptance: TWA opens the
    > daemon `/ui/` in a fullscreen Chrome Custom Tab.

- [ ] **1.2 Digital asset link**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `apps/android/app/src/main/res/values/strings.xml`,
    `docs/operator/native-shells.md`
  - **Prompt:**
    > Document the `.well-known/assetlinks.json` payload the
    > operator must serve from their daemon for full TWA
    > verification. Provide a daemon route
    > `GET /.well-known/assetlinks.json` that returns the JSON
    > parameterized by config. Acceptance: scenario under
    > `Requirement: Android shell verified TWA`.

- [ ] **1.3 Bridge implementation (Android)**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `apps/android/app/src/main/java/dev/qwen/rc/bridge/CompanionService.kt`,
    `apps/android/app/src/main/java/dev/qwen/rc/bridge/Keystore.kt`,
    `apps/android/app/src/main/java/dev/qwen/rc/bridge/QrScanner.kt`
  - **Prompt:**
    > Implement the postMessage handshake per `design.md` "Token
    > handoff → Android TWA". Keystore stores the bearer with
    > optional biometric requirement
    > (`KeyGenParameterSpec.setUserAuthenticationRequired(true)`).
    > QR scanner uses MLKit Vision (no Google Play Services
    > dep variant via CameraX + ZXing for the F-Droid build —
    > select via build flavor `fdroid` vs `github`).
    > Acceptance: bridge calls from the web client succeed
    > end-to-end against a local daemon.

- [ ] **1.4 Custom scheme handler**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Add intent filter for `qwen-rc://`. On receipt, parse the > path per `design.md`, validate the URL portion matches the > paired daemon, navigate the TWA to the corresponding deep > route. Acceptance: scenario `Tap notification opens correct
session`.

- [ ] **1.5 Build flavors and CI**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `apps/android/fastlane/Fastfile`,
    `.github/workflows/android-build.yml`
  - **Prompt:**
    > Two flavors: `fdroid` (no Google Play Services), `github`
    > (full MLKit). CI builds both, signs the `github` flavor
    > with a release key for tagged builds, attaches APK + AAB
    > to GitHub Releases. F-Droid recipe is committed but build
    > runs on F-Droid's infrastructure. Acceptance: tag push
    > produces a signed APK in the release.

## Phase 2 — iOS WKWebView shell

**Effort:** ~3 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Decide iOS minimum version (15
    > vs 16; see open question 1 in `design.md`). Record decision.
    > Verify access to a macOS build environment (self-hosted
    > runner or operator-local Xcode); if neither, declare iOS
    > builds as "operator-built only" and mark CI tasks
    > `deferred`.

- [ ] **2.1 Xcode project skeleton**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `apps/ios/QwenRC.xcodeproj/`,
    `apps/ios/QwenRC/AppDelegate.swift`,
    `apps/ios/QwenRC/ViewController.swift`,
    `apps/ios/QwenRC/Info.plist`
  - **Prompt:**
    > Single-view app. `ViewController` hosts a `WKWebView`
    > whose configuration includes a `WKUserScript` injected at
    > `atDocumentStart` that defines `window.qwen` per
    > `design.md`. First-launch view captures daemon URL into
    > UserDefaults. Acceptance: shell loads daemon `/ui/` on
    > device.

- [ ] **2.2 Bridge implementation (iOS)**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `apps/ios/QwenRC/Bridge/Keychain.swift`,
    `apps/ios/QwenRC/Bridge/QrScanner.swift`,
    `apps/ios/QwenRC/Bridge/Biometric.swift`,
    `apps/ios/QwenRC/Bridge/MessageHandlers.swift`
  - **Prompt:**
    > Implement each bridge method per `design.md` "Bridge
    > contract". Keychain item uses `kSecAttrAccessibleWhenUnlocked`
    > with `kSecAccessControlBiometryCurrentSet` when biometric
    > opt-in is true. QR scanner uses
    > `AVCaptureMetadataOutput`. Each
    > `WKScriptMessageHandlerWithReply` exposes one method.
    > Acceptance: bridge round-trips for getToken/setToken/
    > scanQR/requireBiometric work against the PWA loaded from a
    > local daemon.

- [ ] **2.3 Custom scheme and universal links**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** update `Info.plist` `CFBundleURLTypes`
  - **Prompt:**
    > Register `qwen-rc://`. `AppDelegate.application(_:open:)`
    > parses and routes to the WebView. Acceptance: tapping
    > `qwen-rc://session/abc?event=123` from another app opens
    > the shell to the correct deep route.

- [ ] **2.4 TestFlight build doc**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `apps/ios/README.md`
  - **Prompt:**
    > Operator-facing: how to obtain an Apple Developer account,
    > set bundle id, sign, archive, upload to App Store Connect,
    > distribute via TestFlight. Include screenshots of the
    > Xcode signing step. Acceptance: a first-time operator can
    > follow the doc and produce a TestFlight build in < 1 hour.

## Phase 3 — Keystore bridge + biometric polish

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Verify bridge feature parity
    > across Android and iOS: both expose getToken/setToken/
    > scanQR/requireBiometric. Document any platform gap
    > (e.g. Android API level where biometric is unavailable)
    > and update `design.md` if needed.

- [ ] **3.1 First-pair biometric opt-in**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/src/views/Pairing.tsx`
  - **Prompt:**
    > After successful pair, if `bridge.isBiometricAvailable()`
    > resolves true, show a one-time prompt: "Require biometric
    > to open this app?". On accept, call
    > `bridge.requireBiometric("Setup")` (verifies hardware) and
    > set a persistent flag the shell reads on cold start.
    > Acceptance: scenario `Biometric opt-in at pairing`.

- [ ] **3.2 Cold-start biometric prompt**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Native shell, on `applicationDidBecomeActive` (iOS) or > `onResume` (Android), if the flag is set, prompt > biometric BEFORE loading the WebView's URL. On failure, > show "Tap to unlock" with a retry button. Acceptance: > scenario `Biometric blocks app foreground without
fingerprint`.

## Phase 4 — iOS APNs sender

**Effort:** ~2 days.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 3 `completed`. Verify `add-notification-
routing` Phase 5 `completed` — routing decisions emit > both webpush and (future) apns subscriptions through the > same path. If routing module doesn't accept an `apns` > subscription kind yet, extend it here and update routing > spec.

- [ ] **4.1 APNs subscription routes**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/nativePush/apns/routes.ts`,
    `packages/cli/src/serve/remoteControl/nativePush/apns/storage.ts`,
    `schema/00X_apns_subscriptions.sql`
  - **Prompt:** > `POST /rc/native-push/apns/register { deviceToken,
bundleId, shellVersion }` (any non-bridge auth scope). > `DELETE /rc/native-push/apns/register/:id`. Store > `(token_id, device_token, bundle_id, shell_version,
created_at, last_seen_at)`. Acceptance: scenarios under > `Requirement: APNs subscription registration`.

- [ ] **4.2 APNs sender**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/nativePush/apns/sender.ts`,
    `packages/cli/src/serve/remoteControl/nativePush/apns/jwt.ts`
  - **Prompt:** > JWT signing with P-8 key (ES256, header `kid`, claims > `iss` + `iat`). HTTP/2 client (Node's built-in `http2`) > posting to `api.sandbox.push.apple.com` or > `api.push.apple.com` per config. Payload mirrors > `add-webpush-notifications` schema, mapped to APNs alert / > category / thread-id fields. On `410 Unregistered` or > `400 BadDeviceToken`, drop the subscription and audit. > Acceptance: scenarios under `Requirement: APNs delivery
pipeline`.

- [ ] **4.3 Capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > `/capabilities` `remoteControl.nativeShells` block:
    > `bridgeVersion`, `apnsEnabled`, `supportedPlatforms`.
    > `apnsEnabled` reflects whether the P-8 key file is present
    > and parseable. iOS shell uses this to decide whether to
    > call `registerApns()`.

- [ ] **4.4 iOS shell registers APNs**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > In `AppDelegate`, after successful pair, if
    > `/capabilities.apnsEnabled == true`, call
    > `UIApplication.shared.registerForRemoteNotifications()`.
    > On the delegate callback, POST the hex-encoded device
    > token. Acceptance: an end-to-end test on a real device
    > (manual) confirms a push arrives via APNs.

## Phase 5 — Polish + distribution + docs

**Effort:** ~1.5 days.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 4 `completed`. Spot-check that
    > `qwen-rc://` notifications from APNs payloads round-trip
    > to the right session view. Verify bridge fallback in a
    > plain browser still works (so we don't regress the web-
    > only path).

- [ ] **5.1 TLS pin on first pair**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Native shells fetch the daemon's TLS cert at first pair > and store its SHA-256 in keystore. Subsequent connections > verify; on mismatch, show a confirmation dialog and require > biometric (if enabled) to accept the new fingerprint. > Acceptance: scenarios under `Requirement: TLS pin on
first pair`.

- [ ] **5.2 Bridge version negotiation**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Web client logs a warning when > `bridge.version.bridge < <required>` for a feature it > tried to use. Add a `<MIN_BRIDGE_FOR_FEATURE>` map in > `bridge.ts` and gate optional features on it. Acceptance: > scenario `Old shell loads new web client without
crashing`.

- [ ] **5.3 Operator docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/operator/native-shells.md`
  - **Prompt:**
    > Distribution channels (F-Droid, GitHub Releases,
    > TestFlight), APNs setup (P-8 key acquisition, daemon
    > config), bundle-id-per-operator note, fingerprint pin
    > workflow, "Forget this daemon" flow. Under 2000 words.

- [ ] **5.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-native-mobile-shells`.

## Effort summary

| Phase     | Description                      | Estimate (days) |
| --------- | -------------------------------- | --------------- |
| 0         | Shared design + bridge interface | 1               |
| 1         | Android TWA shell                | 3               |
| 2         | iOS WKWebView shell              | 3               |
| 3         | Keystore + biometric             | 1               |
| 4         | iOS APNs sender                  | 2               |
| 5         | Polish + distribution + docs     | 1.5             |
| **Total** |                                  | **11.5**        |
