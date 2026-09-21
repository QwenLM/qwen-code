# macOS overlay title bar

## Problem

The desktop shell creates its window programmatically with Tauri's default
visible title bar. On macOS that title bar occupies a separate row above the
Web Shell, leaving an empty full-width strip that does not match the integrated
layout used by apps such as Codex.

## Design

Keep the native decorated window and traffic-light controls, but configure the
macOS window with `TitleBarStyle::Overlay` and hide its title text. The WebView
then paints behind the native title bar without relying on transparent-window
private APIs.

The native shell injects a boolean marker before either the bootstrap page or
the daemon-served Web Shell runs. The Web Shell uses that marker to add a
macOS-only drag region and a 38 px content inset. The sidebar and main surface
continue painting beneath the inset, so each surface reaches the top edge while
interactive content stays clear of the traffic lights. The bootstrap page adds
the same drag region but needs no content inset because its status card is
centered.

Window dragging is granted to both the local bootstrap origin and the remote
loopback Web Shell capability. Browser-hosted Web Shell, mobile layouts, and
Windows/Linux desktop windows never receive the marker and retain their current
geometry.

## Verification

- Compare fixed-size macOS screenshots during bootstrap and after the Web Shell
  loads in both themes.
- Confirm the sidebar and main surface paint behind the traffic lights, the
  native title text is absent, and no controls overlap the traffic lights.
- Drag the window from the blank top region and exercise close, minimize, zoom,
  fullscreen, and restored-window behavior.
- Run the focused Web Shell tests plus desktop shell tests/build validation.
