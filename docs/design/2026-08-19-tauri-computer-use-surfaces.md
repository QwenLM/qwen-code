# Tauri Computer Use activity surfaces

## Context

Qwen Code already runs Computer Use through `cua-driver`, and the Web Shell
already renders the ordinary tool timeline. A desktop host needs an additional
trust surface while an agent is controlling the computer: an always-visible
activity indicator, a live screenshot preview, and a stop control that remains
available even when the main window is behind another application.

The canonical desktop host is the Tauri shell. The feature must not fork the
Web Shell React application or place raw screenshots in session events,
transcripts, replay buffers, or telemetry.

## Design

### Live frame boundary

The CLI extracts the first raster image from a successful `computer_use__*`
tool result before the normal ACP projection removes inline image data. It adds
that image to private metadata on the child-to-daemon notification. The bridge
removes the metadata before publishing or recording the update.

The bridge stores only the latest frame in the existing session-owned media
store. The reference is held only on the live `SessionEntry`; it is never
placed in an event. Replacing a frame deletes the previous media object. A new
prompt, a terminal turn, and session teardown delete the live frame.

An authenticated loopback-only endpoint returns the current frame. It is
resolved against the session's owning runtime and supports an ETag so a desktop
host can poll without retransmitting unchanged images. It returns `204` before
the first frame and `304` when the version is unchanged.

This intentionally reuses `SessionMediaStore` for byte ownership and limits,
but not its transcript/reference projection. The dedicated endpoint is needed
because the desktop host knows the live session ID but must not receive a media
reference through the replayable event stream.

### Tauri host controller

The Rust host owns the desktop-only behavior:

- observe the active session's authenticated SSE stream;
- recognize Computer Use permission acceptance and tool activity;
- create and position a non-focusable status panel and a picture-in-picture
  preview as native Tauri webview windows;
- poll the private frame endpoint only while the preview is visible;
- register Escape as a global shortcut while Computer Use is active;
- cancel the active session through the existing daemon cancel route;
- persist the "always hide picture in picture" preference in desktop state;
- protect both native surfaces from screen capture where the platform supports
  it and keep them above ordinary windows.

The main Web Shell window receives a Tauri initialization script. It only adds
a small desktop control and reports SPA URL changes to the Rust controller.
The script is host-owned and runs only on the loopback Web Shell origin. No
Web Shell React component, reducer, route, or stylesheet changes.

The status and preview documents are local Tauri assets with a restrictive
CSP. They receive sanitized state through Tauri events and invoke only the
three desktop commands they need: stop, show/hide preview, and update the
desktop preference.

## Lifecycle

1. The main Web Shell navigates to `/session/:id`; the host script reports the
   URL to Rust.
2. Rust starts one generation-scoped SSE observer and one idle frame poller for
   that session.
3. A permitted or in-progress `computer_use__*` event activates the surfaces
   and registers Escape.
4. Successful Computer Use results replace the session's private live frame;
   the visible preview fetches it at most every 500 ms.
5. A turn terminal, session navigation, runtime restart, or application exit
   hides the surfaces and unregisters Escape. Terminal/new-prompt/session-close
   paths also delete the private media object.

Generation numbers make old observer threads inert after navigation or runtime
restart. Network reads use bounded timeouts so those threads exit without
retaining a runtime indefinitely.

## Security and privacy

- The frame endpoint requires the daemon bearer token and rejects non-loopback
  requests.
- Session ownership is resolved before reading a frame; there is no fallback to
  another runtime.
- Only PNG, JPEG, and WebP frames up to the session media limit are accepted.
- Raw frame metadata is stripped before event publication and transcript
  recording.
- The desktop event sent to the main window and status panel omits screenshot
  data; only the dedicated preview window receives it.
- Surface windows load local assets, do not navigate externally, and expose no
  Node.js runtime.

## Non-goals

- Changing the Web Shell's normal tool rendering.
- Persisting or replaying Computer Use screenshots.
- Implementing Computer Use itself; this design visualizes and controls the
  existing core capability.
- Adding a generic desktop extension framework.
