# Android WebView file selection

[English](mobile-file-selection.md) | [简体中文](mobile-file-selection.zh-CN.md)

Status: Phase 2 follow-up, dependent on connection profiles (#12121) and the original shell (#11722).

## Problem and scope

Web Shell already uses HTML file inputs for attachments, workspace uploads and extension archives. Android's default WebChromeClient cancels them, so the shell cannot use these existing features. Add a native document-picker bridge without duplicating upload logic or changing daemon routes. Camera/microphone capture, directories, downloads and background work are separate changes.

## Design

Handle `onShowFileChooser` only for the current attached WebView at its configured daemon origin. Support single and multiple open modes. Use `ACTION_OPEN_DOCUMENT` with `CATEGORY_OPENABLE`, read access and the requested MIME hints, falling back to a general file picker when a hint is unknown. The Web Shell's existing unrestricted inputs must remain able to choose source files and text, not only images. Capture hints use the document picker; unsupported save/directory modes cancel.

Keep one outstanding OS picker at a time. Each callback belongs to the requesting WebView/document. Profile switch, main-document navigation, connection errors and Activity destruction cancel that callback exactly once. Cancellation does not release the in-flight slot until the old OS result arrives: otherwise a late result could be delivered to a newer request. On recreation save only the in-flight flag, never the callback, URI or file contents; discard the orphan result before accepting another request.

Treat picker output as untrusted. Accept only content URIs with a read grant, from a resolvable provider outside the application's own UID; reject file/network URIs, inaccessible providers and mixed unsafe selections. Enforce single-selection cardinality when requested and a maximum of 100 files, matching the H5 workspace upload batch limit. Never expose app-private files to the WebView. Do not persist URI permissions, copy files, log selected URIs or request broad storage/media permissions. Browser content/file access settings remain disabled; selected input files are delivered through the callback.

The callback does not identify the requesting frame, so checking the top-level origin does not authenticate an embedded frame. Explicit user selection and restricted URI grants are the security boundary. The H5 remains responsible for upload capability checks, workspace/session destination checks, payload limits and server authorization. Android binds selection to the WebView document; H5 already rotates/reset inputs when its session/workspace target changes within that document.

## Files and decisions

A small native picker controller handles intent/result validation and outstanding-request lifecycle. MainActivity registers the AndroidX activity-result launcher and forwards WebChromeClient and lifecycle events. Focused device tests exercise the controller with real Android URI/Intent APIs; native acceptance uses synthetic local fixture documents. No new production dependency or Android permission is needed.

## Acceptance and limits

1. Existing single/multiple HTML file inputs open a system document chooser and receive only explicitly selected readable documents.
2. Cancel, missing picker, malformed result, unsafe URI and unsupported mode produce one cancellation, without a crash or stuck callback.
3. Profile/document changes discard old results; a second request cannot take over an outstanding picker's callback. Recreation never sends an old file to a new page.
4. Generic files and archive filters work, with no broad storage permission, camera permission or persistent grant.
5. Web Shell upload routing and existing origin isolation remain unchanged. Verify actual Android runtime behavior separately from compilation; report real-daemon/TLS and physical-device coverage honestly.

## References

- [WebChromeClient file chooser security contract](<https://developer.android.com/reference/android/webkit/WebChromeClient#onShowFileChooser(android.webkit.WebView,android.webkit.ValueCallback,android.webkit.WebChromeClient.FileChooserParams)>).
- [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files).
- [Connection profiles](mobile-connection-profiles.md).
