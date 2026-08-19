# Electron Computer Use surfaces

## Context

Qwen Code already executes `computer_use__*` tools through the Core Computer
Use client. Tool screenshots are preserved for the model, while the generic
ACP/Web Shell projection intentionally exposes only human-readable tool text.
The Electron preview currently loads the canonical Web Shell unchanged and
does not present any desktop activity outside the chat transcript.

The reference ChatGPT desktop build uses three separate surfaces:

1. a small always-on-top status overlay while a Computer Use turn is active;
2. a roughly 250 by 250 picture-in-picture surface for the latest activity;
3. a control in the thread summary surface that shows or hides picture in
   picture. The summary control is not the screenshot renderer.

The native host writes theme and localized strings for the status overlay,
tracks the active thread, positions picture in picture around host obstacles,
and cancels the active turn when Escape is pressed. The screenshot surface is
desktop-owned rather than part of the conversation renderer.

## Decision

Implement the equivalent interaction without changing Web Shell, the Tauri
desktop, or the generic ACP transcript projection. Keep the desktop surfaces in
`packages/desktop-electron`, and add only the narrow private transport needed
to reuse the exact raw cua-driver image before model-specific vision
postprocessing.

The CLI copies the first image from a successful `computer_use__*` tool result
before vision postprocessing and places it in private ACP update metadata. The
bridge validates a bounded raster payload, removes that metadata before any
event publication, and stores only the latest frame on the owning live session.
It is never replayed or persisted. A token-protected, loopback-only daemon route
serves that frame as binary image data with `Cache-Control: no-store` and a
version ETag.

The Electron main process observes the existing authenticated session event
stream for the session in the main window. It recognizes the lifecycle of
`computer_use__*` tool calls and the enclosing turn. While that turn is active,
it polls the private frame route and renders the exact image the model received.
An unchanged ETag returns `304`, so the image bytes move only when the driver
produces a new frame.

Two isolated Electron windows render the desktop surfaces:

- a compact, non-focusable status overlay with an Escape-to-stop hint;
- a draggable picture-in-picture window with the latest thumbnail, current
  action, hide, and stop controls, anchored with a 24-pixel margin to the
  upper-right of the main desktop window and clamped to the active display.

The existing main-window preload mounts an Electron-owned visibility control
over the Web Shell. It does not expose a page-visible API and does not alter
Web Shell source. The control mirrors the reference thread-summary behavior:
it identifies Computer Use and allows picture in picture to be shown or hidden.
The show/hide override follows the session for the current app lifetime, while
the global always-hide preference is persisted in Electron desktop state.

Escape is registered as a global shortcut only for the duration of an active
Computer Use turn. Cancellation uses the daemon's existing authenticated
`POST /session/:id/cancel` route. Screenshots are kept only in memory and are
never added to the transcript, written to disk, or sent to a remote service by
the desktop host.

## Lifecycle

1. Main-window navigation selects the current session id.
2. Electron opens a second read-only SSE subscription for that session.
3. Replay reconstructs state without showing stale historical activity.
4. Starting a new prompt clears the previous turn's in-memory frame.
5. An approved Computer Use permission, or an auto-approved `in_progress`
   Computer Use tool, starts the status overlay, picture in picture, frame poll,
   and temporary Escape shortcut. A pending permission alone never starts the
   desktop surface.
6. Successful Computer Use results replace the in-memory frame and advance its
   version while the same turn keeps the surfaces stable.
7. `turn_complete`, `turn_error`, or `prompt_cancelled` stops polling, removes
   the global shortcut, and hides both native surfaces.
8. Closing the main window tears down the subscription and surfaces; quitting
   also stops the bundled daemon through the existing application lifecycle.

## Security and privacy

- The observer connects only to the bundled loopback runtime with its
  in-memory bearer token.
- IPC senders are restricted to the main Web Shell window or the two known
  Computer Use surface windows.
- Surface windows use context isolation, sandboxing, no Node integration, a
  strict local content security policy, and content protection to avoid
  recursively capturing themselves.
- The bridge accepts only PNG, JPEG, or WebP frames up to 8 MiB, strips their
  bytes before EventBus/SSE publication, and keeps no replay or disk copy.
- The frame route requires the daemon bearer token even in loopback development,
  rejects non-loopback peers, disables caching, and resolves the unique live
  session owner without falling back to another workspace runtime.
- Electron polls only while the current turn is active and picture in picture
  is visible. The renderer receives a data URL only through its isolated native
  surface preload.
- The global Escape shortcut exists only during that active interval and is
  always unregistered during teardown.

## Tradeoffs

Reusing the driver result adds one bounded private image transfer across the ACP
child boundary and a small live-session route to the daemon. In return, the
preview is byte-identical to the raw cua-driver image, does not need a second
operating-system screen-capture permission, cannot accidentally capture Qwen's
overlays, and remains correct for occluded windows and other Spaces whenever
cua-driver can capture them. The generic transcript and browser Web Shell
continue to see only their existing text and structured tool result.

This implementation follows the reference interaction rather than copying its
proprietary code or assets.
