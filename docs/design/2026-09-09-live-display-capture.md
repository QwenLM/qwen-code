# Selected-display capture for Live

[English](2026-09-09-live-display-capture.md) | [简体中文](2026-09-09-live-display-capture.zh-CN.md)

## Scope and baseline

Screen currently routes every frame through Appshot's foreground-window/AX
capture. The user wants Proactive monitors and Screen Live Feed to see an entire
selected display. Keep the foreground Appshot tool's existing window behavior;
do not widen On Demand visual-memory observation as an incidental change.
Existing uncommitted subagent controls are the baseline and must be preserved.

## Design

- Add a native display-only path alongside Appshot, sharing the serial capture
  queue. Enumerate active displays with UUID, label, dimensions and primary
  status. Persist a display UUID in `visualInput.screenDisplayId`; default
  `primary` means the system's primary display. Explicit unavailable UUIDs fail
  closed without selecting another display or falling back to a window.
- The native screenshot covers the whole selected display, including desktop,
  menu bar, Dock and other apps, excluding Live Host's own windows. Use a
  display ScreenCaptureKit filter on macOS 14+ and selected-display bounds with
  a composed window list on macOS 12/13. Display capture does not read AX.
  Bound native output to the existing realtime 1920x1080 envelope, preserving
  the whole image/aspect ratio; retain current FPS, JPEG and transport limits.
- Add a Display selector beneath Video Source in Settings. Show primary and
  connected displays; retain an unavailable selected entry with an explicit
  error. New fixed text stays in the bilingual catalogue. No new init question.
  Use the existing authenticated visual-settings/config persistence channel.
- Extend protocol v9 additively: `displayCaptureV1` advertises support;
  `host.capture_visual` requests an explicit `screenScope: display`, and
  display results/frames carry the resolved `displayId`. New full-display
  requests must never silently downgrade against an old Host. Normal Appshot
  requests omit the scope and retain the window result/asset/AX semantics.
  Mirror the ten optional type fields in the canonical CLI protocol file to
  retain the existing byte-identity check; CLI runtime/parser behavior and
  capability advertisement remain unchanged.
- Monitor On Demand capture explicitly requests display scope. Memory's
  existing On Demand window capture remains separate. Live Feed always uses
  display capture for Screen; Camera behavior stays unchanged. Display-setting
  changes invalidate pending capture and reset monitor visual buffers just as
  source changes do. Host capture-generation fences discard old in-flight frames
  on settings/topology changes; incoming explicit display IDs are validated.
- Preserve the existing Appshot-related permission flow for On Demand tools.
  Full-display capture itself only requires Screen Recording; never ask for AX
  from the new native display operation, and do not broaden OS permissions.

## Verification and boundaries

Baseline: first try global qwen, then a safe source/mock fixture if unavailable.
Verify split capture routing, missing display rejection, display identity and
stale frames, original Appshot/Camera/memory behavior, native API availability,
config migration/defaults, picker persistence and bilingual layout. Build both
native architectures; serialize heavy builds/tests. Never capture the user's
private desktop or invoke a model merely for verification. A physical multi-
display/lock-screen test remains explicitly unverified unless performed safely
with user-visible fixture content. No commit/push is requested in this turn.

## Summary

Add a separate full-display capture path for monitors and Screen Live Feed;
preserve window capture for the user's Appshot tool and On Demand visual memory.
Settings selects a display, with its UUID persisted and the primary display as
the default. If an explicitly selected display disconnects, stop capture with an
error rather than silently switching displays. Retain frame-rate, dimension and
transport limits: full coverage does not mean native resolution. Clear old
visual buffers and discard stale frames when the display changes. Fail explicitly
when an old Host lacks support; never substitute a window image for a display
image. Continue on top of the existing uncommitted changes without automatic push.
