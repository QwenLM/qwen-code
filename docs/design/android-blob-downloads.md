# Android Blob downloads

[English](android-blob-downloads.md) | [简体中文](android-blob-downloads.zh-CN.md)

## Problem and current state

The Web Shell exports sessions, workflow history, and workspace artifacts through Blob URLs and download anchors. Android WebView cannot hand these renderer-local URLs to DownloadManager. The native shell currently provides no download destination or byte transport. This follow-up builds on the connection-profile slice; it does not change server authentication or the original mobile-shell PR.

## Proposed changes

Add an internal Web Shell Blob-saving helper and a native controller. Existing export producers await the helper and surface failures in their existing error UI; preview download links use it only when the native capability is present. Plain browsers and the desktop shell retain their download-anchor behavior. Preview-only object URLs are unchanged. Native transport handles already acquired bytes, never authenticated network requests or remote URL fetching.

Artifact links pass their original Blob directly; image tabs decode their data URLs locally. The daemon's `connect-src 'self'` policy blocks `fetch(blob:...)` and `fetch(data:...)` in the tested WebView, so the helper never fetches either scheme. A Blob URL without its original bytes produces a visible reopen/browser hint instead of weakening CSP or silently failing.

Android injects `qwenAndroidDownloadV1` before loading the configured origin using AndroidX WebMessageListener. Both `WEB_MESSAGE_LISTENER` and `WEB_MESSAGE_ARRAY_BUFFER` must be supported. The listener validates the actual source origin, main-frame flag, attached WebView, and current document lifetime. Responses use the frame-bound JavaScriptReplyProxy. No wildcard origin or unrestricted JavaScript interface is introduced.

## Protocol and limits

There is one active export per native controller. A version-1 JSON `begin` message carries a random 32-hex-digit `id`, filename, MIME type, and exact byte size. Metadata is limited to 2 KiB. Android sanitizes filenames, validates MIME types, and accepts sizes from zero through 16 MiB. This is an explicit native-only limit; the existing 100 MiB workspace-download limit in ordinary browsers is unchanged.

After the `ready` reply, the sender transfers at most 64 KiB per ArrayBuffer message. Each frame starts with the 32 ASCII ID bytes and a four-byte unsigned big-endian offset. Android accepts only the current ID and exact next offset, acknowledges each chunk, and rejects overflow or incomplete transfers. Only one chunk is awaiting acknowledgement at a time. The bounded in-memory buffer avoids plaintext staging files; the active slot stays occupied until any document-provider writer exits, even after cancellation.

An exact-length `finish` message opens `ACTION_CREATE_DOCUMENT` with the proposed name and MIME type. The user chooses the destination. A `choosing` acknowledgement ends the transfer timeout; there is no short timeout while the user selects a destination. A final response reports saved, cancelled, or error. Once native saving starts, errors never fall back to an anchor and create a duplicate download. Transfer acknowledgements time out after 30 seconds. An explicit cancel message releases an incomplete transfer.

## Ownership, permissions, and failure behavior

Only an external `content:` URI with a returned and effective write grant is accepted. App-owned providers, non-content URIs, and missing grants are rejected. No broad storage permission or persisted URI grant is requested. Writes run off the UI thread and check cancellation between chunks. Provider errors are visible; failure after writing starts can leave a partial destination file. The app does not delete an arbitrary provider URI to hide that failure.

Navigation, profile change, connection error, renderer loss, and Activity destruction invalidate the transfer. Late callbacks cannot attach to a new document or profile. An outstanding system-picker slot remains reserved until its result arrives; only that reservation is retained across Activity recreation, never file bytes, URI, or page callbacks. A normal trip to the system Save picker does not itself invalidate a text-only connection. The separate microphone slice destroys a previously microphone-authorized WebView on backgrounding, so combining the slices can cancel saving from that connection; this safety tradeoff must remain visible and be tested when integrating them.

## Affected files and scope

Native changes are limited to the mobile-shell download controller, Activity wiring, device tests, and README. Web Shell changes are limited to the internal saving helper, session-export producers, workflow-history export, artifact download producers and links, and their tests. No daemon route, SDK authentication contract, server-side credential issuance, background service, public host API, dependency, or workspace membership changes are proposed.

## Validation and acceptance

Before implementation, exercise the parent APK with a real HTML Blob download and confirm that no native destination opens. Global CLI execution cannot exercise Android WebView and is replaced with the parent APK plus a local synthetic fixture; record CLI availability separately.

Verify ordinary browser fallback, byte-for-byte binary and zero-length exports, filenames, native size limits, chunk ordering/IDs, busy behavior, timeout and cancellation. Verify all changed H5 producers with focused tests. On emulator APIs 26 and 35, test actual WebMessage transport, the real system Save picker, destination bytes, cancellation followed by retry, hostile frame/origin messages, navigation, recreation, and stale picker results. Build and typecheck the repository, bundle the CLI, and build/lint/test the native package. Record unsupported provider capabilities rather than claiming they passed. Read the entire final diff twice and obtain independent review before publication.

## Open questions

Raising the native 16 MiB limit would require a separately reviewed storage and memory policy. Arbitrary server-provided HTTP downloads and resumable/background downloads remain out of scope. Combining the independently reviewable profile, picker, microphone, and download slices needs an integration pass after maintainer direction; this slice alone does not complete Android Phase 2.
