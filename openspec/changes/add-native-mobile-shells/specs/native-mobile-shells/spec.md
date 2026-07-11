# native-mobile-shells — spec delta

## ADDED Requirements

### Requirement: Bridge contract surface

A native shell SHALL inject a `window.qwen` object into the hosted
web client at document-start. The object SHALL satisfy the
`QwenBridge` interface defined in `design.md` (Bridge contract).

When the PWA is loaded in a regular browser (no native shell),
`window.qwen` SHALL NOT exist; the web client SHALL fall back to a
shim object with `platform: "web"` and methods backed by
`localStorage`, `BarcodeDetector` (where available), `WebAuthn`
(where available), and `window.open`.

The PWA SHALL feature-detect optional methods at the call site (e.g.
`'registerApns' in bridge`) rather than relying on a version check.

#### Scenario: Bridge present in native shell

- **GIVEN** the PWA is loaded inside the Android or iOS shell
- **WHEN** the page boots
- **THEN** `typeof window.qwen === "object"`
- **AND** `window.qwen.platform` is one of `"android-twa"` or
  `"ios-wkwebview"`
- **AND** `window.qwen.version.bridge >= 1`

#### Scenario: Bridge absent in plain browser

- **GIVEN** the PWA is loaded in a regular browser
- **WHEN** the page boots
- **THEN** `window.qwen` is undefined
- **AND** the web client's `bridge` singleton reports
  `platform: "web"`
- **AND** `bridge.getToken()` resolves with the localStorage value

#### Scenario: Optional methods feature-detected

- **GIVEN** the shell exposes `bridge: 1` (no `registerApns`)
- **WHEN** the web client wants to register for APNs
- **THEN** the call site checks `'registerApns' in bridge`
- **AND** when absent, the web client falls back to WebPush
- **AND** does NOT throw

### Requirement: Token storage in platform keystore

When `bridge.setToken(t)` is called on a native shell, the token
SHALL be stored in the platform's secure keystore (Android Keystore
on Android, Keychain on iOS). The on-disk representation SHALL NOT
be readable by other applications. The token SHALL NOT be written
to WebView storage (`localStorage`, `sessionStorage`, IndexedDB).

When `bridge.getToken()` is called, the shell SHALL read from
keystore and, if biometric is required for this install, prompt
for biometric BEFORE returning the value.

`bridge.clearToken()` SHALL remove the token from keystore.

#### Scenario: Token written to keystore, not localStorage

- **GIVEN** the user completes pairing in the native shell
- **WHEN** the web client calls `bridge.setToken(t)`
- **THEN** `t` is written to the platform keystore
- **AND** `localStorage["qwen-rc:<origin>:token"]` is unset
- **AND** `t` does not appear in any plaintext WebView storage

#### Scenario: Biometric required before getToken

- **GIVEN** biometric is enabled for this install
- **WHEN** the web client calls `bridge.getToken()` at cold start
- **THEN** the OS biometric prompt appears
- **AND** the resolved token is returned only after success
- **AND** on biometric failure the promise rejects with
  `biometric_failed`

### Requirement: QR pairing via native camera

Native shells SHALL implement `bridge.scanQR(opts?)` by presenting
the platform's camera with a QR scanner overlay. Returned text
SHALL be the raw QR payload. On user cancel or timeout, the promise
SHALL reject with `qr_cancelled` or `qr_timeout`.

The pairing QR payload format is:

```
qwen-rc-pair:<base32-Crockford-9char-code>;url=<daemon-https-url>
```

Web client SHALL parse the payload, validate the URL scheme is
`https://`, and submit the code to that URL's `/rc/pair/redeem`
endpoint.

#### Scenario: QR scan returns code and URL

- **GIVEN** the workstation prints a QR for code `ABCD-EFGH-JKLM`
  and URL `https://qwen.local:4170`
- **WHEN** the user scans it from the native shell
- **THEN** `bridge.scanQR()` resolves with the QR payload string
- **AND** the web client parses code and URL correctly
- **AND** posts the redeem to the parsed URL

#### Scenario: QR cancelled

- **GIVEN** the QR scanner is open
- **WHEN** the user taps cancel
- **THEN** `bridge.scanQR()` rejects with `qr_cancelled`

### Requirement: Custom URL scheme `qwen-rc://`

Both native shells SHALL register the URL scheme `qwen-rc://` and
handle the routes documented in `design.md` "Custom URL scheme".

When the shell is invoked via `qwen-rc://`, it SHALL validate that
the URL does NOT contain a daemon-changing component (no
`?url=…`), with the exception of the `qwen-rc://pair?code=…&url=…`
form which SHALL require an explicit user confirmation dialog
before mutating any state.

#### Scenario: Tap notification opens correct session

- **GIVEN** a push notification carries deep link
  `qwen-rc://session/abc?event=123`
- **WHEN** the user taps it
- **THEN** the shell launches (or foregrounds)
- **AND** the WebView navigates to the session `abc` view
  scrolled to event `123`

#### Scenario: Untrusted pair URL prompts confirmation

- **GIVEN** the shell is already paired with daemon
  `https://qwen.local:4170`
- **WHEN** `qwen-rc://pair?code=XXX&url=https://evil.example/`
  is invoked
- **THEN** the shell shows a confirmation dialog naming both URLs
- **AND** does NOT auto-pair without user tap

### Requirement: Android shell verified TWA

The Android shell SHALL be built as a Trusted Web Activity bound to
the operator's configured daemon URL. The daemon SHALL serve
`GET /.well-known/assetlinks.json` returning the asset statement
required for TWA verification.

When asset-link verification fails (operator missed the route),
the shell SHALL fall back to a Custom Tab presentation (browser
chrome visible) rather than refusing to launch.

#### Scenario: Asset link present enables TWA

- **GIVEN** the daemon serves a correct `assetlinks.json` with
  the shell's package and signing fingerprint
- **WHEN** the Android shell launches
- **THEN** the content displays fullscreen without browser chrome

#### Scenario: Asset link missing falls back

- **GIVEN** the daemon returns 404 for `assetlinks.json`
- **WHEN** the shell launches
- **THEN** the content displays as a Custom Tab (browser chrome
  visible)
- **AND** the shell logs a one-time onboarding hint about the
  asset link

### Requirement: APNs subscription registration

When the daemon advertises `nativeShells.apnsEnabled: true`, the
iOS shell SHALL register for remote notifications and POST the
hex-encoded device token to
`POST /rc/native-push/apns/register { deviceToken, bundleId,
shellVersion }` with its bearer.

The daemon SHALL store the subscription bound to the caller's
token. On token revocation the APNs subscription SHALL be removed
in the same transaction.

Subscriptions SHALL be unique on `(token_id, device_token)`;
repeated calls update `last_seen_at` rather than creating
duplicates.

`DELETE /rc/native-push/apns/register/:id` SHALL remove a
subscription owned by the caller's token (or any subscription, for
owner scope).

#### Scenario: Register stores subscription

- **WHEN** the iOS shell posts a fresh device token
- **THEN** the response is 201 with the subscription id
- **AND** a row is present in `apns_subscriptions`
- **AND** subsequent register calls with the same device token
  update `last_seen_at` without creating a new row

#### Scenario: Token revoke cascades

- **GIVEN** an iOS shell with a registered APNs subscription
- **WHEN** the owner revokes the shell's token
- **THEN** the APNs subscription is removed
- **AND** no further APNs pushes target that device

### Requirement: APNs delivery pipeline

When `apnsEnabled` is true and routing decides to send to an APNs
subscription, the daemon SHALL:

- Sign a JWT with the configured P-8 key (alg `ES256`, header
  `kid: <key_id>`, claims `iss: <team_id>`, `iat: <now>`).
- Open or reuse an HTTP/2 connection to
  `api.sandbox.push.apple.com` or `api.push.apple.com` per config.
- POST the payload with headers `apns-topic: <bundle_id>`,
  `apns-push-type: alert`, `authorization: bearer <JWT>`.
- On `200 OK`: success.
- On `410 Unregistered` or `400 BadDeviceToken`: remove the
  subscription and emit `audit_event` with action
  `apns_subscription_removed`.
- On `429 TooManyRequests` or `5xx`: retry with exponential
  backoff up to 5 attempts.

The payload schema SHALL mirror `add-webpush-notifications`
payload, with iOS-specific fields populated:

- `aps.alert.title` from `summary`
- `aps.alert.body` from a short subtitle
- `aps.category` from `kind`
- `aps.thread-id` from `sessionId`
- `aps.mutable-content: 1` for `permission.required`

Same-kind coalescing within a 5-second window per
`add-webpush-notifications` D6 SHALL apply.

#### Scenario: APNs send happy path

- **GIVEN** routing emits a `send` decision for an APNs sub
- **WHEN** the sender posts to APNs and receives 200
- **THEN** an audit `push_routed { transport: apns }` is written

#### Scenario: 410 removes subscription

- **WHEN** APNs returns `410 Unregistered`
- **THEN** the subscription row is deleted
- **AND** an audit `apns_subscription_removed` is written
- **AND** no further attempts are made for that device token

#### Scenario: APNs disabled falls back gracefully

- **GIVEN** the P-8 key file is missing
- **WHEN** the daemon boots
- **THEN** `/capabilities` returns `apnsEnabled: false`
- **AND** the iOS shell does NOT call `registerApns()`
- **AND** WebPush remains functional for the shell

### Requirement: TLS pin on first pair

Native shells SHALL pin the daemon's TLS certificate SHA-256
fingerprint at first pair. On subsequent connections, mismatches
SHALL trigger a confirmation dialog naming the old and new
fingerprints. The user MUST tap accept (and, if biometric is
enabled, authenticate) to adopt the new fingerprint.

This pin SHALL be storage-tied to the configured daemon URL; if
the user "forgets" the daemon, the pin is cleared.

#### Scenario: Cert change prompts confirmation

- **GIVEN** the shell has pinned fingerprint `F1`
- **WHEN** the daemon presents fingerprint `F2` (legitimate
  rotation)
- **THEN** the shell shows a dialog naming `F1` and `F2`
- **AND** does NOT proceed to load the WebView until accept

#### Scenario: Forget daemon clears pin

- **WHEN** the user runs "Forget this daemon"
- **THEN** the stored fingerprint, daemon URL, token, and
  biometric flag are all cleared
- **AND** the shell returns to first-launch state

### Requirement: Bridge version negotiation

`bridge.version.bridge` is an integer monotonically increased when
the bridge contract gains methods. The web client SHALL maintain a
map `<feature> → <minBridgeVersion>` and feature-detect before
invoking any optional method.

When the shell exposes a bridge version lower than required for a
feature, the web client SHALL degrade gracefully (e.g., fall back
to WebPush when APNs is unsupported), log a one-time warning, and
not error.

#### Scenario: Old shell loads new web client without crashing

- **GIVEN** an Android shell with `bridge: 1` (no
  `shareViaSystemSheet`)
- **AND** a web client that prefers `shareViaSystemSheet` for the
  share action
- **WHEN** the user invokes share
- **THEN** the web client falls back to `navigator.share` or a
  copy-link dialog
- **AND** the UI does not crash

#### Scenario: New shell, old web client ignores new methods

- **GIVEN** a shell with `bridge: 2` (adds `qwen.scanBarcode`)
- **AND** an older web client that does not use the method
- **WHEN** the page loads
- **THEN** no error occurs; the additional method is simply
  unused

### Requirement: Daemon URL pinning and reset

A native shell SHALL be paired with exactly one daemon URL at a
time. Switching daemons SHALL require an explicit "Forget this
daemon" action that clears token, fingerprint, biometric flag, and
all bridge-managed state.

The shell SHALL NOT expose UI to switch daemons mid-session.

When the shell is in "developer mode" (off by default; toggled via
a hidden settings entry requiring 7 consecutive taps on the about-
version row), the daemon URL field becomes editable without forget;
biometric requirement applies before the field is shown.

#### Scenario: Default mode locks daemon URL

- **GIVEN** the shell is paired with daemon `D1`
- **WHEN** the user navigates settings
- **THEN** the daemon URL is shown read-only
- **AND** the only way to change it is "Forget this daemon"

#### Scenario: Developer mode allows in-place change

- **GIVEN** developer mode is on
- **AND** biometric (if enabled) has succeeded
- **WHEN** the user edits the daemon URL field
- **THEN** the shell re-prompts pairing against the new URL
- **AND** the prior token is discarded

### Requirement: Capability advertisement

`GET /capabilities` SHALL include a `remoteControl.nativeShells`
block:

```jsonc
{
  "bridgeVersion": 1,
  "apnsEnabled": true,
  "supportedPlatforms": ["android-twa", "ios-wkwebview"],
  "minShellVersion": { "android": "1.0.0", "ios": "1.0.0" },
}
```

Shells SHALL refuse to launch if their declared shell version is
below `minShellVersion` for their platform, presenting an update
prompt instead.

#### Scenario: Capability response carries native-shell block

- **WHEN** a client requests `/capabilities`
- **THEN** the response includes `remoteControl.nativeShells`
- **AND** `bridgeVersion` is the integer agreed for this change
- **AND** `apnsEnabled` reflects whether the P-8 key file is
  loadable

#### Scenario: Below-minimum shell prompts update

- **GIVEN** a shell reports `shellVersion: "0.9.0"`
- **AND** the daemon advertises `minShellVersion.android: "1.0.0"`
- **WHEN** the shell loads
- **THEN** the shell displays an update prompt
- **AND** does NOT load the WebView

### Requirement: Distribution channels

The Android shell SHALL be published via F-Droid (no Google Play
Services dependency in the `fdroid` build flavor) and via GitHub
Releases (signed APK + AAB). The Play Store SHALL NOT be a default
distribution channel.

The iOS shell SHALL be operator-built and distributed via
TestFlight. The App Store SHALL NOT be a default distribution
channel.

Release tags SHALL include SHA-256 hashes of the published binaries
in the release notes.

#### Scenario: F-Droid build is reproducible

- **GIVEN** a tagged release
- **WHEN** F-Droid's build server compiles the source
- **THEN** the resulting APK matches the SHA-256 published in the
  tag's release notes

#### Scenario: Operator self-signs iOS shell

- **GIVEN** an operator with an Apple Developer account
- **WHEN** they follow `apps/ios/README.md`
- **THEN** they produce a signed TestFlight build
- **AND** the build can be installed to their own device for
  testing
