# Android Mobile Shell (Technical Spike)

[English](mobile-android-shell.md) | [简体中文](mobile-android-shell.zh-CN.md)

Status: development-only spike under review, following [issue #11704](https://github.com/QwenLM/qwen-code/issues/11704). It is not a production mobile client.

This document records the Phase 1 baseline. The [Phase 2 connection-profile design](mobile-connection-profiles.md) supersedes the single-profile and plaintext native-storage sections below; other production prerequisites still apply.

## Problem and Goals

Use the existing daemon-served Web Shell in an Android WebView, with no second native session UI and no locally bundled H5. Establish a buildable native bootstrap and a precise origin boundary before adding production credentials or background connectivity.

## Implemented Scope

- One development profile in `qwen_profiles` SharedPreferences: `daemon_url` and optional `daemon_token`. There is no profile editor, stable profile key or multi-profile switching yet.
- Validate that the saved URL is an HTTP(S) origin with no user information, non-root path, query or fragment. Pass an encoded token via `#token=`. The fragment is absent from the navigation request; the Web Shell subsequently sends the token in authenticated API requests.
- Compare parsed scheme, host and effective port for in-WebView navigation. Similar domain prefixes, user information and different ports are not same-origin. Only HTTP(S) and mailto external main-frame links may launch another app; missing handlers and device restrictions do not crash the activity.
- Check the WebView provider before constructing a WebView. Missing or pre-111 providers get a native update message. Missing/invalid profiles and connection failures also use native bootstrap messages; a connection failure offers Retry.
- Keep browser back history and zoom support. Disable file/content access and mixed content. Globally reject cleartext, with explicit loopback exceptions in the network security configuration.
- Exclude development credentials from cloud backup and device transfer. `allowBackup=false` is retained as well.
- Exclude this Gradle package from both npm and pnpm workspaces. Build using JDK 17, Android SDK 34 and the pinned Gradle 8.2.1 wrapper with its distribution checksum.

## Design Decisions

The WebView navigates to the daemon origin, so direct same-origin HTTP API behavior applies without `--allow-origin`. Reverse proxies and remote terminal/voice WebSocket upgrades still follow the origin requirements documented in [qwen serve](../users/qwen-serve.md). Chrome/WebView 111 is the Web Shell's CSS support floor, derived from Tailwind v4, independently of the ES2021 JavaScript target.

A static daemon token (`--token` or `QWEN_SERVER_TOKEN`) avoids restart invalidation during development. SharedPreferences storage is a temporary development mechanism, not Keystore-backed production security. HTTPS is the intended remote connection path. Additional HTTP LAN hosts require explicit network-security entries.

`adb reverse` makes a host loopback daemon reachable from the device loopback
port. It must never forward a token-less daemon to a physical device: any app
on that device can reach the port and act as the daemon user. Physical-device
testing requires `--require-auth` with a bearer token saved as `daemon_token`;
for example, `QWEN_SERVER_TOKEN=$(openssl rand -hex 32) qwen serve --require-auth`.

No foreground service starts in this spike. A service with no SSE connection would merely consume resources and show a misleading persistent notification, so its placeholder and permissions are deferred.

## Constraints and Production Prerequisites

Per-device revocable daemon credentials are a maintainer-owned prerequisite. This spike must not be presented as resolving that requirement. Android Keystore storage alone cannot make a shared static bearer revocable per device.

Phase 2 must implement N profiles with client-minted stable keys and display names; switching profiles navigates to a new origin. Native cached workspace state must be keyed by profile and workspace ID, and capability checks must be performed per profile and connection. Migration must remove the development plaintext token after moving it into the approved credential store.

Microphone permission bridging is superseded by the [microphone integration design](mobile-microphone-permission.md), including its close-on-background constraint for dictation and Qwen Live. File chooser, download handling, new-window handling, renderer-process recovery, lifecycle-aware SSE and notifications are not implemented here. System font-scale integration and complete pinch-zoom/accessibility acceptance also remain follow-ups. Browser H5 availability does not imply those native integrations already work.

## Reviewer Test Plan

1. Build the debug APK and run the JVM origin-policy tests using the committed wrapper.
2. On an emulator/device with WebView 111+, provision a development profile and confirm the daemon-served UI loads. Check that the navigation URL sent to the daemon has no token fragment.
3. Verify same-origin links stay in WebView; suffix domains, userinfo tricks and changed ports do not. External links without a matching app must not crash.
4. Launch without a profile or usable WebView provider; expect a readable native message, without relying on web rendering.
5. Stop the daemon, navigate, then restore it and press Retry. Confirm main-frame errors offer recovery and subresource errors do not replace the entire UI.
6. Confirm no foreground service or notification runs when opening or closing the activity.

## Validation Evidence

JVM tests cover origin comparison, saved-root validation and external scheme restrictions. Build results and exact revisions belong in the PR verification report. Emulator/device interaction and provider-update behavior require device evidence and are not claimed as completed by this design.

## Follow-ups

Production profile UI and credential migration; maintainer-provided per-device revocation; Keystore-backed storage; capability negotiation; lifecycle-aware SSE and native notifications with runtime permission handling; file selection, downloads, new windows and renderer recovery; font scaling and accessibility acceptance.
