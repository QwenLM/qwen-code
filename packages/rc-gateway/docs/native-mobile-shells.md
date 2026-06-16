# Native mobile shells — gateway-side support

`add-native-mobile-shells` is overwhelmingly a **native-client** spec (an Android
TWA and an iOS WKWebView shell that host the PWA, inject `window.qwen`, store the
token in the platform keystore, scan QR, pin TLS, etc.). Per "build gateway-side
support only", the gateway implements just the daemon-facing surface the spec
assigns it:

| Gateway surface                               | Status     |
| --------------------------------------------- | ---------- |
| `POST /rc/native-push/apns/register`          | Cycle A ✅ |
| `DELETE /rc/native-push/apns/register/:id`    | Cycle A ✅ |
| Token-revoke → APNs cascade                   | Cycle A ✅ |
| `remoteControl.nativeShells` capability block | Cycle B ✅ |
| `GET /.well-known/assetlinks.json`            | Cycle B ✅ |
| APNs sender (JWT ES256 + payload + retry)     | Cycle C ✅ |
| Notifier wiring (fan-out + routing/coalesce)  | Cycle D ✅ |
| Live HTTP/2 send to Apple (vendor)            | ceiling    |

Everything else — the `window.qwen` bridge contract, keystore token storage,
biometric, QR/`scanQR`, `qwen-rc://` URL scheme, TLS pinning, daemon-URL pinning,
bridge-version negotiation, distribution (F-Droid/TestFlight) — is client/native
work and is out of boundary.

## APNs subscriptions (Cycle A)

`POST /rc/native-push/apns/register { deviceToken, bundleId, shellVersion }`
(bearer; gated at **SESSION_READ** to mirror the webpush router's floor — a
notification channel carries session-read-class payload data, so a zero-scope or
guest SHARE token cannot mint one). Returns `201 { id }`. Upsert on
`(tokenId, deviceToken)`: a repeat refreshes `lastSeenAt`/`shellVersion` instead
of duplicating.

`DELETE /rc/native-push/apns/register/:id` — own-or-owner (a non-owner targeting
another token's subscription gets 404, no existence leak).

On `DELETE /rc/tokens/:id`, the revoke route's `onTokenRevoked` hook
cascade-removes the token's APNs subscriptions in the same request and audits
`apns_subscription_removed { reason: token_revoked, count }`.

### Deviation: JSON store, not a SQL table

The spec uses SQL language ("a row in `apns_subscriptions`", "unique on
`(token_id, device_token)`"). The implementation uses a **JSON-file store**
(`nativePush/apnsStore.ts`, mode 0600) — deliberately mirroring its sibling
`PushStore` (webpush subscriptions), which is also JSON, not sqlite. Introducing
`better-sqlite3` gating here (as cost-tracking/search do) would be an inconsistency
with the very feature this one parallels. The uniqueness constraint is enforced by
the upsert; "table/row" is read as data-model language, not a storage mandate.

## Config + capability + asset links (Cycle B)

Optional `~/.qwen/rc/native-push.yaml` (parsed once at boot, tolerant — a
missing/invalid file disables both features):

```yaml
apns:
  enabled: true
  keyPath: ~/.qwen/rc/apns/AuthKey_ABC.p8
  keyId: ABC123
  teamId: DEF456
  bundleId: dev.qwen.rc
  environment: sandbox # or production
androidTwa:
  packageName: dev.qwen.rc
  sha256Fingerprints:
    - 'AB:CD:EF:...'
```

`GET /rc/capabilities` → `remoteControl.nativeShells`:

```jsonc
{
  "bridgeVersion": 1,
  "apnsEnabled": false,
  "supportedPlatforms": ["android-twa", "ios-wkwebview"],
  "minShellVersion": { "android": "1.0.0", "ios": "1.0.0" },
}
```

`apnsEnabled` is true ONLY when `apns.enabled` is set, all four identifiers
(`keyId`/`teamId`/`bundleId`/`keyPath`) are present, AND the P-8 key file is
readable — the same honesty rule cost-tracking uses. Key readability is re-checked
**live per request** (the rest of the config is boot-time), so dropping in the key
file flips `apnsEnabled` true without a restart.

`GET /.well-known/assetlinks.json` is PUBLIC (Android fetches it pre-launch, no
token); it serves the asset statement from `androidTwa`, or **404** when no TWA is
configured (the shell then falls back to a Custom Tab).

## Cycle split & verification ceiling

- **Cycle A** (this) — store + register/delete endpoints + revoke cascade + audit
  actions `apns_registered` / `apns_subscription_removed`. Fully unit- and
  server-integration-tested (auth floor, upsert, own-or-owner delete, cascade).
- **Cycle B** — `remoteControl.nativeShells` capability (`apnsEnabled` reflects an
  actually-loadable P-8 key AND a wired store) and `GET /.well-known/assetlinks.json`
  (404 when unconfigured → the Android shell falls back to a Custom Tab).
- **Cycle C** — the **APNs sender**, built injectable so the routing logic is
  fully unit-tested while the live Apple call stays behind a ceiling:
  - `apnsJwt.ts` — ES256 provider JWT (`kid`/`iss`/`iat`), with a caching
    `ApnsJwtSigner` (~50 min refresh). **Verifiable** and verified: the test signs
    and checks the signature against the public key, and a malformed key throws
    (so `apnsEnabled` can later reflect parse-validity, not just file presence).
  - `apnsPayload.ts` — maps `PushPayload` → `aps` (`alert.title`=summary,
    `alert.body`=session name, `category`=kind, `thread-id`=sessionId,
    `mutable-content:1` for `permission.required`). Pure, tested.
  - `apnsSender.ts` — `ApnsSender` over an **injected** `ApnsTransport`: `200` →
    `push_routed { transport: apns }`; `410`/`400` → remove subscription +
    `apns_subscription_removed`, no retry; `429`/`5xx` → exponential backoff up to
    5 attempts; other `4xx` → reject (no retry, no removal); and the orphan guard
    (`isTokenLive` false → remove + no send), closing the Cycle-A flag. All tested
    against a fake transport.
  - `createHttp2ApnsTransport` — the real `node:http2` client is now
    **integration-tested** against an in-process HTTP/2 server impersonating APNs
    (`apnsTransport.integration.test.ts`, hermetic): it asserts the `POST
/3/device/<token>` path, the `apns-topic`/`apns-push-type`/`authorization`
    headers, a well-formed ES256 JWT, and drives a real-transport `410` → removal
    through `ApnsSender`. `connectOptions` is a test-only TLS-trust escape hatch
    that **defaults to strict verification** (a test asserts the production default
    rejects the self-signed server), so prod never skips cert checks.
  - **Remaining ceiling (genuinely un-CI-able):** only Apple's own acceptance of
    the JWT + delivery to a real device (needs an Apple Developer account + a
    device). Everything up to "bytes correctly sent over real HTTP/2" is verified,
    and the notifier wiring below routes real events to that boundary.

## Notifier wiring (Cycle D)

`PushNotifier.notify` now drives APNs as a **second transport** alongside web-push:
the same payload fans out to APNs device subscriptions through the gates that
apply to a token-bound, field-less APNs record — the event-global gates (snooze,
routing `drop`), token-level **scope + session-lock** (a session-locked share
token never receives another session's metadata via APNs), per-subscription
routing drop, and **same-kind coalescing** (D6, shared coalescer keyed by the APNs
sub id). `push_routed { transport: apns }` is audited by the sender on `200`.

- **Intentionally not applied:** prefs/quiet-hours (no such field on an APNs
  record); **working-device** (it keys on `tokenId` so it _could_ run, but a phone
  whose token merely polled recently is **not** foregrounded — suppressing a
  `permission.required` there would defeat the point of mobile push); **rate-limit**
  (a deliberate choice — the spec names only coalescing, and coalescing + the
  sender's 429 backoff cover bursts; the default-cap path exists if symmetry is
  wanted later).
- **Construction.** `cli.ts` builds the `ApnsJwtSigner` (validating the P-8 key
  parses) + bundle/host once at boot and passes them as `deps.apns`; the gateway
  builds the `ApnsSender` so it wires its own audit + `isTokenLive`. Absent/malformed
  key → no sender → APNs simply isn't delivered (plain web-push unaffected).
- **Two honest caveats.** The sender is built from the key read **at boot**, so
  toggling APNs delivery requires a **restart** (whereas the capability's
  `apnsEnabled` is re-checked live per request — they can momentarily disagree).
  And the APNs fan-out currently rides inside the web-push notifier, so APNs
  delivery requires web-push (VAPID) to be configured — true in every real
  deployment, but a coupling worth naming.
- **Verified:** the notifier→APNs fan-out (incl. the session-lock confinement) is
  unit-tested with a fake sender, and a server-level test drives `deps.apns` →
  `ApnsSender` → a fake transport end-to-end (correct device token, topic, JWT).
  The live HTTP/2 call to Apple remains the vendor ceiling above.

### Resolved in Cycle C

- **`apnsEnabled` existence-vs-loadable** — now parses the P-8 as an EC private
  key (`createPrivateKey`) on each capability read, so a present-but-malformed key
  reads `false` (mirrors bind-security's `createSecureContext`), not just presence.
- **Orphaned-device safety** — `ApnsSender` provides an `isTokenLive` guard
  (removes the subscription and sends nothing when its token is no longer live).
  As of Cycle D this is **enforced**: the gateway builds the sender with
  `isTokenLive: (tid) => store.scopesFor(tid) !== undefined` (scopesFor drops
  expired/revoked tokens), so a revoked token's device is never delivered to and
  is pruned on the next attempt — independent of the token-revoke cascade.
