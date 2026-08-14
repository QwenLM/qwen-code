# Tauri desktop pet experiment

## Summary

Add the same Qwen desktop companion experiment to the existing Tauri shell so
its implementation can be compared directly with the separate Electron
experiment. The original Tauri desktop remains the release implementation;
this work lives only on an experiment branch.

The experiment reuses the existing Qwen spritesheet verbatim. Web Shell gains
the same generic host-settings extension used by the Electron experiment, but
contains no pet assets, Tauri APIs, persistence, or pet state.

## Ownership

- Web Shell renders optional application-owned boolean and numeric settings
  with its existing settings components.
- The Tauri Rust process owns pet settings, the companion window, persisted
  position, session-to-animation mapping, and application lifecycle.
- A bundled local renderer owns only spritesheet animation and direct pet
  interaction.
- The daemon and Qwen Core are unchanged.

Desktop-only state is stored in the Tauri shell's existing
`desktop-state.json`, alongside workspace and main-window bounds. Browser Web
Shell sessions receive no host bridge and therefore retain their existing UI
and behavior.

## Bridge and security boundary

The main Tauri webview injects a narrow `window.qwenCodeHost` adapter. This is
the same Web Shell-facing contract as the Electron preload adapter, but its
methods invoke Rust commands through Tauri IPC.

Because the canonical Web Shell is served from the daemon's dynamic loopback
port, the capability explicitly grants event subscription to
`http://127.0.0.1:*`. Every Rust command independently requires both the
`main` window label and exact equality with the active runtime origin. The
local pet commands independently require the `pet` label and a bundled Tauri
origin.

## Window behavior

The pet is a second frameless, transparent, always-on-top Tauri webview window.
It stays visible when the main window is hidden on macOS, while Cmd+Q still
exits the application and bundled runtime. Tauri's native `start_dragging`
operation moves the pet, and window move events persist its position.

On macOS, transparent Tauri windows require the private macOS webview API flag.
That is a packaging and Mac App Store consideration that does not apply to the
Electron implementation in the same form.

Electron can combine mouse-event passthrough with forwarded mouse movement,
allowing transparent pixels to click through while the renderer detects entry
back onto the sprite. Tauri exposes ignore-cursor-events but not Electron's
cross-platform forwarding option. This first comparison keeps the transparent
pet window interactive and does not claim pixel-level click-through parity.

## Activity mapping

| Web Shell signal               | Pet state          |
| ------------------------------ | ------------------ |
| idle                           | idle               |
| waiting                        | waiting            |
| responding or prompt submitted | running            |
| turn complete                  | jumping, then idle |
| turn error                     | failed, then idle  |

## Verification

- Test Tauri state migration, size bounds, and activity mapping.
- Test Web Shell rendering and mutation of application-owned settings.
- Build and typecheck Web Shell, then run the Tauri Rust test suite and build.
- Manually verify animation, drag persistence, settings, main-window close,
  reopen, and Cmd+Q cleanup on macOS.
