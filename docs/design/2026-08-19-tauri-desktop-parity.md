# Tauri desktop parity for host-owned Web Shell surfaces

## Context

Draft PR #9169 demonstrates three host-owned behaviors around the canonical Web Shell: a right-side in-app browser, a title-bar color that is continuous with the sidebar and follows its theme, and a macOS window layout where the content reaches the top instead of sitting below a full-width title bar. The canonical desktop host is now Tauri, so these behaviors should be implemented there without creating a second chat UI or changing browser-hosted Web Shell behavior.

## Principles

- Keep Web Shell React components, state, routes, and stylesheets unchanged.
- Inject only desktop-owned DOM and styling from the Tauri main webview.
- Accept commands only from the main webview at the authenticated runtime origin.
- Keep arbitrary embedded pages in a separate non-persistent child webview with no Qwen capability grants.
- Preserve the Electron interaction contract: ordinary external-link clicks use the system browser; Cmd-click on macOS and Ctrl-click elsewhere opens the in-app browser.

## In-app browser

The Tauri host owns one child webview attached to the native main window. An initialization script in the authenticated Web Shell mounts a resizable panel shell alongside the existing context area, intercepts only the explicit modified external-link gesture, and reports the content rectangle to Rust. The toolbar provides address navigation, back, forward, reload, open in the system browser, and close.

Rust validates the calling webview, URL, and logical bounds before creating or controlling the child. Only HTTP and HTTPS top-level navigation is allowed. Downloads are denied. `mailto:` requests are handed to the system, while other unsafe schemes are rejected. The child uses an incognito data store and receives no Tauri capability entry, preload script, daemon token, or Web Shell bridge.

Tauri does not expose a cross-platform child-webview navigation-history API. The host therefore records finished top-level URLs in a bounded in-memory history and uses direct navigation for back and forward. Page-load events update the toolbar state in the main webview. Closing the panel first hides the child, clears its navigation state, and retains the single child for reuse. Runtime restart or application exit hides and destroys it. This avoids a race between Tauri's asynchronous child-webview close and reopening the same label.

Adding a child webview currently requires Tauri's `unstable` Cargo feature. The use is isolated to the desktop browser module so it can be replaced with a stable API later without changing Web Shell or the interaction contract.

## Integrated title bar

On macOS the main window uses the overlay title-bar style, hides the native title text, and moves traffic lights over the sidebar. The Web Shell itself therefore paints the whole client area: the sidebar background naturally extends behind the traffic lights, while the existing chat header or empty-state context reaches the top on the right.

The host initialization script adds desktop-only top padding and a drag strip inside the sidebar, marks the populated chat header as draggable except for interactive descendants, and injects a narrow right-side drag strip when no chat header exists. It observes Web Shell DOM changes so SPA navigation and empty/populated session transitions keep the drag regions correct. No full-width spacer is introduced.

The same script observes the Web Shell theme and reports light or dark plus the computed sidebar color to a narrowly gated Tauri command. The native window theme and fallback background follow those values, while the visible title-bar color remains the Web Shell `--sidebar-background` itself.

Other platforms keep their existing native title bar because macOS overlay and traffic-light behavior have no direct cross-platform equivalent. The in-app browser remains available on supported desktop platforms.

## Lifecycle and security

Runtime restart, recovery navigation, or application exit closes the browser child. Browser commands fail closed when the main webview is not at the recorded runtime origin. Browser state is process-local and is not persisted. The injected interface is not a page-visible generic host API; it invokes only the explicit Tauri commands needed by these two desktop surfaces.

## Verification

- Rust unit tests cover URL, bounds, history, and caller-origin rules.
- The desktop release helper verifies the initialization script and capability isolation.
- Cargo tests and checks cover native integration.
- A packaged macOS build verifies ordinary versus Cmd-click behavior, browser controls and resizing, theme changes, populated and empty-session drag regions, traffic-light placement, and close-versus-quit lifecycle.
- Standalone browser Web Shell is checked to confirm that neither surface appears without the Tauri host.
