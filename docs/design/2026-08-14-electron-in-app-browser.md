# Electron In-App Browser Panel

## Summary

Add one docked browser panel to the Electron Web Shell preview. Clicking an
HTTP(S) link in Web Shell opens it in a resizable panel on the right side of
the existing window by default. Users can instead choose the default system
browser, while Cmd/Ctrl-click and `mailto:` always go to the system. Plain-
browser Web Shell and the Tauri desktop shell keep their current behavior.

The Web Shell owns the trusted browser chrome and layout. Electron owns a
sandboxed `WebContentsView` that renders the untrusted page inside the bounds
reserved by Web Shell.

## Goals

- Open existing Web Shell HTTP(S) link surfaces in one reusable right panel.
- Let the user resize and close the panel and use back, forward, reload, an
  address field, and an explicit system-browser action.
- Persist an Electron-wide default of in-app or system-browser opening.
- Preserve Cmd/Ctrl-click's new-tab expectation by forcing the system browser.
- Always hand `mailto:` URLs to the operating system.
- Keep the canonical daemon-served Web Shell as the only product renderer.
- Isolate browser content from the daemon token, Node.js, Electron APIs, and
  the Web Shell preload bridge.
- Keep browser state and cookies in a dedicated Electron session partition.

## Non-goals

- Multiple browser tabs or browser windows.
- Browser automation, CDP, Computer Use, downloads, permission prompts, or
  persisted browser pages, history, or cookies across application restarts.
- Restoring the legacy Electron desktop surfaces.
- Changing Tauri behavior or opening non-HTTP(S) schemes in the panel.

## Architecture

```text
Standalone Web Shell
  - intercepts HTTP(S)/mailto link clicks only when the Electron bridge exists
  - forwards the URL and Cmd/Ctrl modifier to the desktop link API
  - renders the Electron-only opening preference in Settings > UI
  - renders trusted toolbar, resize handle, and a page-content placeholder
  - sends URL, navigation, close, and placeholder bounds through the preload

Electron preload
  - exposes fixed browser-panel and desktop-link methods and subscriptions
  - does not expose raw ipcRenderer

Electron main process
  - validates the sender, URL, and numeric bounds
  - applies mailto, modifier, and persisted-preference routing policy
  - owns one WebContentsView in a dedicated in-memory partition
  - denies browser permissions and non-HTTP(S) top-level navigation
  - redirects target=_blank navigation into the same managed view
  - publishes URL, loading, and history state to the trusted Web Shell
```

The existing `BrowserWindow` remains the Web Shell owner. Its `contentView`
gets one child `WebContentsView`; Web Shell reserves the same rectangle in its
flex layout so the native view covers only the page-content placeholder. A
`ResizeObserver` resends bounds after panel dragging and window layout changes.

The opening preference is stored in Electron's existing `desktop-state.json`,
not Web Shell `localStorage`: the bundled daemon listens on a random port, so
its renderer origin can change between launches. Normal HTTP(S) clicks call the
main-process link router; it either asks the renderer to reveal the panel or
uses `shell.openExternal`. The panel's explicit external-open button uses the
same router with `forceExternal`.

## Interaction policy

| Input                      | In-app preference | Default-browser preference |
| -------------------------- | ----------------- | -------------------------- |
| Normal HTTP(S) click       | Right panel       | System browser             |
| Cmd/Ctrl + HTTP(S) click   | System browser    | System browser             |
| `mailto:`                  | System handler    | System handler             |
| Panel external-open button | System browser    | System browser             |

## Security boundary

- Browser page: `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, `webSecurity: true`, no preload.
- Browser session: dedicated `qwen-browser-panel` partition with all
  permission requests and downloads denied.
- Browser URL: only normalized `http:` and `https:` URLs are accepted.
- System URL: only normalized `http:`, `https:`, and `mailto:` URLs are
  accepted.
- Browser popups: denied; safe HTTP(S) targets navigate the existing panel.
- Host IPC: only the main Web Shell `webContents.id` may invoke browser-panel
  handlers.
- Browser pages never receive the daemon URL fragment or bearer token.

## Failure behavior

An invalid URL or failed Electron operation is surfaced through the existing
Web Shell error toast. If the Electron bridge is absent, links retain their
current native `_blank` behavior. Closing the application destroys the browser
view explicitly before stopping the daemon.

## Known limitation

Electron composites a child `WebContentsView` above the Web Shell renderer, so
Web Shell dialogs cannot cover the native page rectangle while the panel is
open. This first version keeps the browser toolbar outside that rectangle; a
follow-up should hide the view while full-window dialogs are active.

## Tauri comparison

Tauri keeps the current external-only policy. Web Shell invokes the scoped
opener plugin for ordinary links, while Rust navigation/new-window guards deny
embedded cross-origin navigation and hand safe URLs to the OS. Its capability
file limits opener schemes to HTTP(S) and `mailto:`.

Electron needs more host code because the right panel is a native
`WebContentsView`: it owns bounds synchronization, navigation history, a
dedicated session, permissions, downloads, and IPC. In return, it can provide a
real in-window browser with stronger isolation than an iframe and without CSP
or `X-Frame-Options` compatibility problems. Tauri's external-only route is
smaller, uses the user's full browser profile and accessibility stack, and has
less lifecycle/security surface, but cannot provide the requested docked page.

## Acceptance criteria

- Clicking a conversation HTTP(S) link in Electron opens the right panel and
  does not launch the system browser.
- The panel resizes by dragging its left edge and closes without affecting the
  chat session.
- Address navigation, back, forward, and reload operate on the embedded page.
- The explicit external-open action launches the current URL in the system
  browser.
- Cmd/Ctrl-click and `mailto:` launch through the system; a persisted Settings
  choice can make normal HTTP(S) clicks do the same.
- Plain Web Shell and Tauri link behavior are unchanged.
- The embedded page cannot access Node.js, the Electron preload bridge, or the
  daemon token, and cannot navigate to a non-HTTP(S) top-level URL.
