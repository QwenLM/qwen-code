# macOS App observation and input recovery

[English](cua-macos-app-recovery.md) | [简体中文](cua-macos-app-recovery.zh-CN.md)

## Problem

CUA SDK 0.20.6 can report a closed Apple menu instead of the selected app's
window. AppKit can also omit a live window from AXChildren and AXWindows while
AXFocusedWindow and AXMainWindow remain valid. An unavailable NSPasteboard
then makes driver creation panic, preventing recovery after desktop loss.

Input checks reproduce a visible TextArea whose complete document frame places
its center outside the window, and Preview's hosted file panel ignores
host-PID clicks and shortcuts. The hosted controls have a different native
window ID from their app's root; their real AX parent chain connects them.

## Changes

Require a visible submenu before selecting a menu as the App observation root,
including retained menu notifications. When window enumeration cannot resolve
an exact target, supplement it with same-PID focused/main references whose
native window ID matches the requested window. Preserve all existing ownership
and incomplete-read reporting.

Acquire NSPasteboard lazily for each operation and handle nil as a recoverable
error. Clipboard availability must not determine whether the driver can be
created. Preserve Unicode text, PNG, file URLs, and rich-paste transactions.

Choose a pointer location inside the intersection of an element's frame and
its exact window. Use the existing foreground HID implementations for App
pointer clicks and foreground shortcuts. Before a global App click, raise the
exact AX root and require the system hit-test element's bounded AXParent chain
to reach that same root by CFEqual. Also require the exact focused window and
WindowServer foreground process. Unknown ownership, stale coordinates, or an
occluding window must refuse before sending mouse input.

The public App API continues to hide delivery modes. The existing native SDK
process, permissions, installation, serialization, and focus/cursor restoration
remain in use. This change prepares CUA SDK and driver 0.20.7; Node REPL remains
0.1.4. No new dependency, service, public option, or automatic replay is added.

## Validation and limits

Use release/candidate controls on owned documents with independent AX and file
readback. Cover stale selected menus, empty window arrays, nullable pasteboard
creation/reconnection/recovery, long TextArea clicks, hosted panel fields and
shortcuts, occluded targets, scrolling, and lifecycle reuse. Clipboard fault
injection runs in a disposable process and recovers to a private pasteboard.

Passing one action receipt is not proof of input delivery. Require field values,
selection changes, visible scrolling, or exact saved bytes. Run native tests,
SDK tests/build/typecheck, repository build/typecheck/bundle, and package/version
validation before submission. Record environment failures separately.

The archived benchmark's initial WindowServer restart has no available crash
stack or reproducible trigger. These changes do not claim to prevent that
restart or restart a dead desktop session. An earlier truncated path input is
recorded separately: text delivery code is unchanged, and successful fresh-panel
input does not establish its cause. Benchmark score recovery must be measured
after a new version is published.
