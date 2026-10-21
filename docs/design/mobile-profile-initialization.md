# Android browser-profile initialization

[English](mobile-profile-initialization.md) | [简体中文](mobile-profile-initialization.zh-CN.md)

## Problem and evidence

The original profile implementation assumes a new UUID name means empty WebView storage. On Android System WebView 124, rapid process termination can occur before the provider persists its profile registry. A subsequent new name then receives a previously used directory and exposes old localStorage. The unchanged parent APK reproduced this failure; waiting for metadata writes can hide it and is not a fix.

## Design

Persist a `browserInitialized` flag beside the browser identity in the encrypted native vault. New profiles, credential/origin changes and migration from the previous vault format start false. Renaming preserves the flag. Check the provider's known profile names before any operation that creates or loads a profile. A missing name invalidates a previously true flag and saves false before proceeding.

An uninitialized profile requires AndroidX WebKit 1.13's `DELETE_BROWSING_DATA` capability in addition to `MULTI_PROFILE`. Obtain its profile-specific WebStorage and call `WebStorageCompat.deleteBrowsingData`. No WebView loads a document or receives a credential before the completion callback and a successful durable true write. Unsupported providers, storage failures and preparation failures show native guidance without a shared-profile fallback. Previously initialized, still-known profiles preserve browser state.

A process-wide set reserves names while asynchronous clearing is in flight, including across Activity recreation. Check this reservation before the initialized-profile fast path. Reload the native vault at connection start and clear completion so another Activity's edits cannot resurrect a deleted or rotated profile. Navigation away invalidates the Activity attempt. A late completion releases the reservation but cannot mark a changed/deleted profile initialized or create a WebView. Cancellation leaves false so a subsequent attempt clears again. No timeout authorizes loading; a stuck provider requires retry after its operation completes or process restart.

## Scope and tradeoffs

This changes only native profiles, vault serialization, AndroidX WebKit's pinned version, Activity wiring, documentation and tests. Existing native credentials are preserved during format migration, but existing browser sessions/cache are cleared once. Provider loss of profile metadata may force another clear. This prevents stale browser data from being trusted; it cannot make a defective provider preserve data across process death. It does not alter daemon credentials, H5 token storage, other Phase 2 slices or the primary server protocol. The production guard uses no reflection, provider-private files, arbitrary delays or application-data resets.

## Validation

JVM tests cover previous-format migration, persisted initialization, failed writes, missing provider names, renamed/rotated identities and stale identity updates. Device tests cover provider capability rejection and profile-scoped clearing before same-origin cookie/localStorage use. Repeat process restarts without clearing app data or sleeps intended to flush metadata. The old provider must fail closed; a capable provider must clear before loading and retain initialized known-profile data. Record exact provider/API coverage and unsupported lanes separately.

## References and open questions

- [WebStorageCompat](https://developer.android.com/reference/androidx/webkit/WebStorageCompat)
- [ProfileStore](https://developer.android.com/reference/androidx/webkit/ProfileStore)

There is no public synchronous provider-registry flush API. The guard therefore depends on documented profile-name lookup and completion of profile-scoped browsing-data deletion, and on tests of the actual installed provider. Production mobile readiness and per-device server revocation remain separate work.
