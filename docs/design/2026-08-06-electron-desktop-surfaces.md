# Electron Desktop Surfaces

## Summary

Build the new `packages/desktop-electron` product around one daemon and several
narrowly scoped Electron windows, alongside the retained Tauri shell. Chat
windows continue to render the public
`WebShellWithProviders` entry. An embedded browser uses a separate Chromium
session and a `WebContentsView`. A voice overlay uses the daemon's Live
Host protocol, and existing Computer Use remains owned by Core.

This design does not read, import, or adapt the legacy Electron application.

## Ownership

- The Electron main process owns windows, application shortcuts, browser views,
  native permissions, and application lifecycle.
- The preload bridge exposes typed desktop actions only. It never exposes
  Electron objects, Node APIs, or raw IPC.
- Every chat window is an independent Web Shell client connected to the same
  authenticated daemon and locked to the desktop workspace.
- The daemon and Core continue to own sessions, approvals, tools, Computer Use,
  voice conversations, and workspace state.
- The embedded browser owns only web navigation state. It is not a second chat
  or agent runtime.

## Window model

The desktop uses three visible window kinds:

1. Chat windows render the complete Web Shell. Opening another chat window
   creates another client of the same daemon, so session writer leases and
   server-side session ownership continue to be authoritative.
2. A browser window renders trusted desktop chrome at
   `qwen-desktop://app`. Its untrusted page content lives in a
   `WebContentsView` below that chrome and uses a dedicated persistent Electron
   session partition.
3. A frameless always-on-top Voice overlay projects the existing daemon Live
   session and controls it without creating a second conversation owner.

Window bounds and the browser's last safe HTTP(S) URL are restored. A bounded
number of chat windows is restored to avoid corrupted state creating an
unbounded number of renderers.

## Embedded browser boundary

The browser chrome can navigate, go back, go forward, reload, and focus its
address field. Navigation accepts only HTTP(S) URLs; a bare hostname is
normalized to HTTPS. Page content has Node integration disabled, is sandboxed,
cannot navigate the trusted desktop renderer, and cannot create unmanaged
windows. Browser permissions are denied until a product requirement defines a
specific allow policy.

Links opened from Web Shell are routed into the embedded browser. This keeps
research beside the conversation without granting page content access to the
daemon token or preload bridge.

## Computer Use

Core's `computer_use__*` tools remain the only agent-facing system automation
implementation. The Electron preview does not add status routes, emergency
stop state, ACP methods, or other Electron-specific behavior to shared Core or
daemon packages. The embedded browser remains visible to the existing driver
like any other desktop window.

A future dedicated Computer Use control surface requires a separate shared
protocol proposal. It must not be smuggled into the isolated desktop host.

## Voice overlay

The overlay is a small always-on-top Electron renderer sharing the same daemon
and Live conversation. It projects and controls the daemon's existing Live
Host session; microphone input, playback, global shortcut, permission state,
and Appshot capture continue through the signed Live Host installed and
launched by the existing setup flow. The Web Shell Live controls and overlay
therefore observe one daemon-owned status instead of maintaining parallel
calls. A future in-process Electron host may implement that same protocol, but
is not required for Web Shell parity.

## Security invariants

- Only chat renderers receive the daemon bearer token. Browser chrome and the
  Voice overlay receive surface identity plus allowlisted desktop IPC only.
- Untrusted browser page contents never receive the daemon URL token pair.
- IPC authorization checks both the sending `webContents` and its frame URL.
- Browser navigation is HTTP(S)-only and uses its own session partition.
- Every renderer remains sandboxed with context isolation on and Node
  integration off.
- Renderer media permission remains limited to trusted chat surfaces.
  Browser-page and overlay media permission is denied by default.

## Delivery order

1. Multi-window Web Shell and isolated embedded browser.
2. Existing Live Host integration and always-on-top voice overlay.
3. Cross-surface session targeting, restoration, and packaged E2E.

Each delivery must keep the Web Shell import public and preserve the Phase 1
packaged runtime smoke test.
