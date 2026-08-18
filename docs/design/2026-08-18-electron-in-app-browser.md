# Electron-owned in-app browser panel

## Status

Draft implementation for Issue #9412, stacked into the isolated Electron Web Shell preview in Draft PR #9169.

## Goal

Add one docked browser panel to `packages/desktop-electron` while preserving the canonical Web Shell as an unmodified product surface.

- Normal HTTP(S) clicks continue to open in the operating-system browser.
- Cmd-click on macOS, and Ctrl-click on Windows/Linux, opens the URL in the in-app panel.
- Tauri, browser-hosted Web Shell, daemon protocols, Core, CLI, public desktop releases, and the updater remain unchanged.

## Ownership boundary

Electron owns the complete feature. A sandboxed preload runs in the main Web Shell window's isolated world. It captures only modified external-anchor clicks, mounts the host-owned toolbar and resize placeholder beside the Web Shell content, and exchanges fixed browser-panel messages with the main process. It does not expose an API in the page's JavaScript world.

The main process owns one `WebContentsView`. The view uses a separate in-memory session, has Node integration disabled, receives no preload or daemon token, denies permissions and downloads, and accepts only HTTP(S) top-level navigation. New-window requests reuse the same managed view. The explicit toolbar action may hand the current HTTP(S) URL to the operating system.

No Web Shell source file is changed. The host currently locates the existing sidebar shell and mounts its panel as a sibling in the same flex row. This follows the Electron title-bar integration's existing use of Web Shell data attributes without adding an Electron concept to the shared product renderer.

## Link routing

| Interaction                 | Electron preview | Browser Web Shell       | Tauri desktop  |
| --------------------------- | ---------------- | ----------------------- | -------------- |
| Normal HTTP(S) click        | System browser   | Native browser behavior | System browser |
| Cmd-click on macOS          | In-app panel     | Native browser behavior | System browser |
| Ctrl-click on Windows/Linux | In-app panel     | Native browser behavior | System browser |

The preload uses a capture-phase listener so it can cancel a qualifying modified click before Chromium creates a new window. All other clicks remain on the existing path, where the Electron main window denies unmanaged windows and calls `shell.openExternal` for safe external URLs.

## Panel behavior

The Electron-owned toolbar provides back, forward, reload, address navigation, open in system browser, close, and a draggable left resize edge. A `ResizeObserver` keeps the native view aligned to the renderer placeholder. Closing the panel removes the native child view but leaves the Web Shell session untouched.

The panel is also destroyed when the main renderer navigates, crashes, closes, or the application quits. Window close/reopen therefore never preserves an orphaned browser surface.

## Security properties

- The main Web Shell renderer remains sandboxed with context isolation and no Node integration.
- The preload does not use `contextBridge` or create a page-visible global.
- IPC handlers verify that the sender is the current main Web Shell renderer.
- Browser URLs and bounds are normalized in the main process.
- The embedded page has a separate non-persistent Electron session.
- Permissions and downloads are denied.
- Non-HTTP(S) top-level navigation is blocked; `mailto:` requests originating
  inside the embedded page are handed to the operating system.
- The embedded page has no preload, Node integration, Qwen daemon token, or Qwen page session.

## Known limitation

`WebContentsView` is composited above the Web Shell renderer. While the browser is open, a Web Shell dialog cannot paint over the native page rectangle. This preview documents that tradeoff rather than adding dialog coupling to Web Shell.

## Superseded experiment

Draft PR #9232 proved the `WebContentsView` approach but made ordinary clicks open in-app, made Cmd/Ctrl-click open externally, added a persistent preference, and modified Web Shell components, settings, i18n, and link hooks. Issue #9412 deliberately reverses the click policy and moves all desktop-only UI and behavior into `packages/desktop-electron`.
