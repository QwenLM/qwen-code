# Android connection profiles and protected credentials

[English](mobile-connection-profiles.md) | [简体中文](mobile-connection-profiles.zh-CN.md)

Status: Phase 2 proposal and implementation, following #11704 and dependent on #11722. This remains a development client pending maintainer-owned per-device revocation on the daemon's primary listener.

## Problem

The development shell reads one URL and an optional plaintext token from `qwen_profiles`. Configuring it requires editing private preferences. There is no supported way to select another daemon or recover from a lost credential. Reusing one WebView across profiles could also reuse the previous connection's sessionStorage, cookies and cached workspace state, even for two credentials on the same origin.

## Scope

Add native profile setup, editing, selection and deletion; Keystore-backed storage; migration of the development profile; and browser-state isolation. The daemon-served Web Shell remains the session UI and handles its own REST capabilities. This change does not introduce a native chat UI, native workspace cache, background service, new protocol, or per-device revocation endpoint. A subsequent native connection must negotiate its own capabilities rather than inherit another profile's result.

## Storage and migration

Each profile has a random stable ID, display name, validated daemon origin and optional bearer token. Native profile data is serialized together and encrypted using AES-256-GCM with a key generated in Android Keystore, a fresh provider-generated IV per write, and authenticated format context. The encrypted vault lives in `noBackupFilesDir` and is replaced through `AtomicFile`. Profile metadata is encrypted too. A missing key or invalid ciphertext fails closed; loading never silently generates a replacement key or falls back to the plaintext profile.

When no vault exists, import valid legacy preferences once. Verify an encrypted round trip before committing the vault, then remove the old URL/token only after a successful write. Every successful vault read also retries removal of legacy preferences, covering termination between the two writes. A failed write keeps the legacy data available; a failed cleanup blocks connection and offers Retry. Invalid legacy data is preserved for correction rather than silently discarded. Recovery of an unreadable vault is an explicit, confirmed reset of connection data; it cannot recover an invalidated Keystore key.

Native saved credentials live in the vault. Avoid logging them, disable view-state/autofill persistence on token inputs, and exclude application preferences and WebView data from backup/device transfer. Credentials enter the trusted Web Shell via its existing fragment bootstrap; the H5 retains its existing per-tab sessionStorage behavior. SessionStorage is not guaranteed to be memory-only by Chromium, so this change does not claim encryption of every WebView-held token copy. An explicit memory-only H5 authentication contract is separate work; a compromised daemon or rooted device can also access a live bearer.

## Profile UI and isolation

The native home screen lists profiles and offers Add, Connect, Edit and Delete. Blank names and invalid roots are rejected. Renaming retains the stable ID. Editing an origin requires entering its credential again; a token must not be carried to another server. Changing origin or credential rotates the browser profile identity so old cookies and local state cannot authenticate the new connection. Persist that identity together with the profile.

Each connection constructs a fresh WebView, sets its named AndroidX profile before navigation, and preserves the existing origin policy. Named profiles separate cookies, web storage and service-worker data, including for connections on the same origin. Switching destroys the old WebView and its pending JS confirmation before constructing the next. Callback handlers verify their WebView is still current. No WebView instance or saved WebView state is restored across profiles.

This requires `WebViewFeature.MULTI_PROFILE`, provided through the existing AndroidX WebKit dependency. If the installed provider lacks it, profile management remains usable but Connect shows a native update message. The Web Shell's browser floor remains 111; the Android connection feature additionally requires this provider capability. There is no fallback to shared browser storage. Delete/edit retires obsolete named profiles when the provider permits it; IDs are never reused. Keystore encryption does not replace daemon-side revocation.

## Files and dependencies

Production changes are confined to `packages/mobile-shell`: vault/cipher and profile management classes, `MainActivity`, resources, backup rules and focused tests. The existing Gradle, Kotlin and production AndroidX versions remain pinned; instrumented tests add pinned AndroidX test dependencies. The mobile CI workflow runs device tests on API 26 and 35, requiring profile isolation support on the API 35 lane. English/Chinese design documents and the package README describe actual behavior and the feature gate.

## Acceptance

1. A clean install presents native setup without private-file editing. Add/edit/delete survives relaunch, and token fields never display a stored secret.
2. Migration preserves an existing valid connection, removes the legacy token only after persistence succeeds, and safely retries interrupted operations.
3. Corrupt ciphertext, a missing key and failed storage writes show recovery instead of an unauthenticated connection or silent data loss.
4. Two profiles on the same origin retain isolated cookies/localStorage and never inherit another token. Switching rejects stale callbacks; changing credentials uses a new browser profile.
5. Missing/old WebView providers display native guidance. A provider lacking MULTI_PROFILE does not connect through a shared fallback.
6. Existing origin checks, JS confirmations, Retry, back navigation and renderer cleanup continue to work.

Verification uses JVM tests for serialization, migration/fault paths and authenticated encryption, plus Android instrumentation for the real Keystore and profile isolation where the provider supports it. Record unsupported scenarios as skipped, not passed. Use synthetic credentials and local fixtures; this does not require model calls. Actual device/TLS/backup acceptance remains explicitly reported rather than inferred from builds.

## References and remaining decisions

- [Maintainer architecture](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5645279859).
- [AndroidX named profiles](<https://developer.android.com/reference/androidx/webkit/WebViewCompat#setProfile(android.webkit.WebView,java.lang.String)>).
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore).

Official release/signing and the server's credential issuance/revocation contract remain maintainer decisions. Background notifications and file/media callbacks are separate Phase 2 changes.
