# Android microphone permission

[English](mobile-microphone-permission.md) | [简体中文](mobile-microphone-permission.zh-CN.md)

## Problem and current state

The Web Shell already captures microphone audio with `getUserMedia`, converts it to PCM and sends it through its authenticated voice WebSocket. The native shell currently denies WebView permission requests and declares no recording permission. This slice enables that existing path; it does not implement another recorder or transcription service. It builds on the isolated connection-profile development shell.

## Design

Only a request for exactly `RESOURCE_AUDIO_CAPTURE` from the current attached WebView and configured daemon origin is eligible. The requesting origin and current top-level origin must both match. HTTPS and explicitly allowed loopback HTTP origins are supported; no TLS exceptions are added. Camera, mixed audio/video and unknown resources are denied without an Android permission prompt.

A native dialog names the connection origin and asks the user to enable its microphone. This explicit action is required even if the application already has Android recording permission. After confirmation, the shell requests `RECORD_AUDIO` through the Activity Result API when needed. It checks the current view, origin, visible lifecycle and OS permission again before granting only audio capture. Android denial leaves text usage available. No permission request is launched at app startup.

One pending request owns the consent dialog and any outstanding system result. Navigation, connection failure, backgrounding, switching profiles and destruction cancel the pending request. A cancelled system request retains its result slot until the OS responds; a new document cannot adopt the old result. Recreation persists only that in-flight flag, not the WebView request. WebView cancellation hides the dialog without responding again to its cancelled request.

WebView's permission grant can last for the lifetime of the view, and its native API does not report reliably when individual audio tracks stop. Therefore a connection which has been granted microphone access is closed when the Activity stops. The native UI explains this before consent and offers a manual reconnection afterward. This also applies if dictation already ended or another fullscreen Activity is opened. Unsent in-page state may be lost. Text-only connections are unaffected. This deliberate development-client tradeoff guarantees that background capture is not enabled by this slice; no background recorder or foreground service is introduced. A future coordinated H5/native capture lifecycle may improve this behavior.

System document Open/Save needs a preflight because launching a picker would stop the Activity and destroy the page before it receives the result. For a microphone-authorized connection, the Activity intercepts `ACTION_OPEN_DOCUMENT` and `ACTION_CREATE_DOCUMENT` before launch and asynchronously returns the normal cancelled result to its launcher. It then offers **Keep editing** (retain the current page) or **Reconnect** (explicitly discard transient page state and stop microphone access). The user retries the file operation after reconnecting. No document destination is created by a blocked request. The guard lives in the microphone slice's Activity so the independent picker and download slices use it without acquiring each other's implementations. It does not resume a cancelled file operation or claim seamless microphone/file interoperability.

Native AppOps diagnostics observed an active-to-inactive recording transition and renewed consent on repeated `getUserMedia` on API36/WebView134, including a cloned audio track. An inactive app-op alone is not a documented lifetime revocation of WebView's capture permission, so this patch does not use that observation to relax background teardown.

## Components and scope

The manifest declares recording permission, the normal MODIFY_AUDIO_SETTINGS permission needed by Chromium audio input, and marks microphone hardware optional. `NativeMicrophonePermission.kt` owns request/result state; `MainActivity.kt` owns origin-labelled consent UI, the runtime launcher and view lifetime. Strings, the mobile README and instrumentation tests describe and verify the behavior. Existing H5 voice authentication, capability checks, secure-context rules, audio processing and owner-change cleanup remain authoritative. No daemon route, JavaScript bridge, audio storage or new dependency is added.

This is permission integration for a development client, not production mobile release approval. Physical microphone quality, transcription accuracy, background voice and per-device daemon revocation are outside this change.

## Verification and acceptance

- Establish on the parent APK that the actual WebChromeClient denies audio requests.
- Build debug/release, run existing JVM/storage/profile tests, lint and focused permission-state instrumentation.
- Check explicit native denial, OS denial and grant, already-granted OS permission, wrong origin, unknown/mixed resources and concurrent requests.
- Verify cancelled or restored OS results cannot authorize a replacement request; navigation and destruction invalidate pending consent.
- On a supported emulator, activate actual `getUserMedia` from a synthetic local page, accept/deny the native and OS prompts and check a live audio track only after consent. No host microphone input or actual speech is required.
- Background a microphone-enabled connection and verify its WebView is destroyed and manual reconnect UI appears. Verify a text-only connection survives the same transition. Record device/provider versions and actual gaps rather than claiming physical-device or daemon verification.
- In a combined picker/download build, try Open and Save after native microphone consent. Verify the system chooser never opens, the request is cancelled exactly once, Keep editing retains the same page/draft, and a second request is not stuck busy. Reconnect explicitly, retry Open/Save and verify actual bytes. No empty destination should be created by the blocked Save. Background an actively recording page and confirm the existing teardown remains effective.

## Open follow-ups

Maintainer review should confirm the explicit close-on-background tradeoff before merging. Improve voice/page-state preservation in a separately designed follow-up, and test real HTTPS daemons and physical devices before an official mobile release. Server-side device credentials remain a maintainer-owned prerequisite.

## References

- [Android PermissionRequest](https://developer.android.com/reference/android/webkit/PermissionRequest)
- [Runtime permission workflow](https://developer.android.com/training/permissions/requesting)
