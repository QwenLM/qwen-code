# Native mobile shells — gateway-side support

`add-native-mobile-shells` is overwhelmingly a **native-client** spec (an Android
TWA and an iOS WKWebView shell that host the PWA, inject `window.qwen`, store the
token in the platform keystore, scan QR, pin TLS, etc.). Per "build gateway-side
support only", the gateway implements just the daemon-facing surface the spec
assigns it:

| Gateway surface                               | Status            |
| --------------------------------------------- | ----------------- |
| `POST /rc/native-push/apns/register`          | Cycle A ✅        |
| `DELETE /rc/native-push/apns/register/:id`    | Cycle A ✅        |
| Token-revoke → APNs cascade                   | Cycle A ✅        |
| `remoteControl.nativeShells` capability block | Cycle B           |
| `GET /.well-known/assetlinks.json`            | Cycle B           |
| APNs sender (JWT ES256 + HTTP/2 to Apple)     | Cycle C (ceiling) |

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

## Cycle split & verification ceiling

- **Cycle A** (this) — store + register/delete endpoints + revoke cascade + audit
  actions `apns_registered` / `apns_subscription_removed`. Fully unit- and
  server-integration-tested (auth floor, upsert, own-or-owner delete, cascade).
- **Cycle B** — `remoteControl.nativeShells` capability (`apnsEnabled` reflects an
  actually-loadable P-8 key AND a wired store) and `GET /.well-known/assetlinks.json`
  (404 when unconfigured → the Android shell falls back to a Custom Tab).
- **Cycle C** — the **APNs sender**: sign a JWT (ES256, `kid`/`iss`/`iat`), HTTP/2
  POST to `api[.sandbox].push.apple.com`, audit `push_routed { transport: apns }`,
  `410`/`400` → remove subscription, `429`/`5xx` → backoff. This is a **runtime
  ceiling** (needs real Apple credentials + a device + HTTP/2 to Apple): it will be
  built **injectable** and unit-tested against a fake transport, with the live send
  documented as unverified — same posture as the matrix-E2EE adapter.

### Note for Cycle C: orphaned-device safety

A token revoke cascade-deletes subscriptions, but if `persist()` throws mid-cascade
a subscription could be orphaned (and the revoke route would 500). When the sender
lands, it MUST validate each target against a live token, not blindly iterate the
store, so a revoked token's device can never still receive pushes.
