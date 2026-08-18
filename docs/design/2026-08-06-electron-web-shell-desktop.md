# Electron Web Shell Desktop

## Summary

Add an isolated Electron application in `packages/desktop-electron` alongside
the existing Tauri implementation in `packages/desktop-shell`. Electron starts
the authenticated loopback daemon and loads the daemon-served standalone Web
Shell directly in one sandboxed `BrowserWindow`.

This is the same rendering mechanism used by Tauri. Electron does not compile
a separate React entry, wrap `WebShellWithProviders`, or add desktop CSS. The
daemon runtime owns the exact Web Shell HTML, CSS, assets, entry logic,
providers, and routes displayed by both desktop hosts.

## Goals

- Keep the existing Tauri runtime and public release path unchanged.
- Keep Electron independent from the root npm workspace and Tauri package.
- Display the complete standalone Web Shell without a second renderer entry.
- Keep daemon/Core authoritative for sessions, tools, permissions, filesystem,
  models, MCP, Computer Use, voice, settings, and plugins.
- Use a single desktop window with narrowly scoped Electron-only host surfaces.
- Package an authenticated, loopback-only Qwen runtime with the application.

## Non-goals

- Rebuilding Web Shell screens from UI primitives.
- Replacing or restyling Web Shell product UI from Electron.
- Adding Voice overlay or multiple chat windows.
- Moving daemon APIs to Electron IPC or exposing Electron APIs to page JavaScript.
- Importing the legacy Electron implementation under `packages/desktop`.
- Changing shared Core, CLI, daemon, ACP, or Tauri behavior.

## Architecture

```text
Electron main process
  - owns one BrowserWindow and application lifecycle
  - starts bundled qwen serve
  - selects and persists one workspace
  - navigates to http://127.0.0.1:<port>/#token=<launch-token>

Bundled qwen serve
  - listens on ephemeral loopback
  - requires the per-launch bearer token for APIs
  - serves lib/web-shell/index.html and its assets

Standalone Web Shell
  - reads the token from the URL fragment and removes it
  - mounts the canonical standalone providers and UI
  - owns theme, language, routing, settings, plugins, and chat presentation
  - publishes the active theme through standard theme-color metadata
```

The daemon is started with:

```text
serve --port 0 --hostname 127.0.0.1 --require-auth
      --workspace <cwd> --no-open
```

The token is placed in the fragment, which is not sent to the HTTP server. The
standalone entry persists it in tab-scoped session storage and removes it from
the visible URL, matching the Tauri flow.

## Rendering parity invariant

Electron packages the selected Qwen build under `runtime/qwen-code`. Runtime
preparation builds `packages/web-shell`, copies the root distribution including
`dist/web-shell`, and records checksums for every runtime file. Electron then
loads that server-owned document; there is no Electron HTML, React root,
Tailwind pipeline, theme state, or product CSS capable of diverging from
standalone Web Shell. Injected host CSS is limited to native window chrome and
the optional Electron-owned browser panel; it uses Web Shell's existing theme
tokens and does not restyle product content.

Therefore settings, plugins, navigation, dialogs, portals, fonts, semantic
tokens, and responsive behavior use the same generated assets as Web Shell.
Visual fixes belong in Web Shell itself and automatically reach both Tauri and
Electron.

## Native boundary

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- a sandboxed preload owns fixed desktop-host messages but exposes no global or
  Electron API to page JavaScript
- the main process maps Web Shell's standard `theme-color` metadata to
  Electron's native theme and window background
- on macOS, native traffic-light controls remain visible over a host drag strip
  colored by Web Shell's sidebar theme token
- navigation restricted to the active daemon origin
- new windows denied
- normal external HTTP(S) clicks open in the operating-system browser; an
  explicit Cmd-click on macOS or Ctrl-click on Windows/Linux may open the
  isolated in-app browser panel described in Issue #9412
- daemon bound to `127.0.0.1` with bearer authentication

## Runtime and lifecycle

The main process starts a private Node runtime and bundled Qwen distribution,
waits for deep authenticated health, loads Web Shell, captures logs, and stops
the full process group during application quit. Desktop state stores only the
workspace and one window's normal bounds. Older multi-window state migrates by
retaining the first saved window and discarding removed surfaces.

## Packaging and release isolation

`electron-builder` produces preview installers under the separate application
identifier `com.alibaba.qwen-code.electron-preview`. The dedicated workflow
uploads unsigned Actions artifacts with read-only repository permissions. It
does not publish a GitHub release or updater feed. The existing Tauri release
workflow remains unchanged.

## Acceptance criteria

- Electron contains one Web Shell window, an optional isolated browser panel,
  and no Voice overlay or additional chat window action.
- The loaded page URL uses the authenticated loopback daemon origin.
- The packaged page is `lib/web-shell/index.html` from the selected Qwen build.
- No Electron-owned replacement renderer, React entry, Tailwind/Vite build,
  theme state, or product style override exists. Host CSS is limited to native
  window chrome and explicitly Electron-owned surfaces.
- Settings, plugins, dialogs, and chat surfaces match standalone Web Shell at
  the same viewport and theme.
- The macOS title bar and Web Shell sidebar form one continuous color surface
  in both light and dark themes.
- Packaged startup and shutdown smoke tests pass, including daemon cleanup.
- Shared Core, CLI, daemon, ACP, Tauri, and public release files have no diff.
