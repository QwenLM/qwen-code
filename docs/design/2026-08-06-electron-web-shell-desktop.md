# Electron Web Shell Desktop

## Summary

Add a new Electron application in `packages/desktop-electron` alongside the
existing Tauri implementation in `packages/desktop-shell`. The Electron
renderer embeds the public
`WebShellWithProviders` component and connects to the existing authenticated
loopback daemon. Web Shell remains the single implementation of chat,
sessions, tools, permissions, MCP, settings, voice, and transcript rendering.

The first milestone is behavioral parity with the standalone Web Shell. Later
desktop surfaces—embedded browser, voice overlay, and multi-window
workflows—must compose around the same Web Shell rather than fork or copy it.

No desktop-shell source, UI, or runtime from the legacy Electron application
under `packages/desktop` is imported or adapted. Shared daemon/Core behavior
that already belongs to standalone Web Shell remains authoritative.

## Goals

- Use Electron for the new desktop host without changing the existing Tauri
  runtime or release path.
- Do not add Electron-only routes, capabilities, or lifecycle behavior to
  shared Core, CLI, daemon, or ACP packages.
- Render `WebShellWithProviders` directly in the Electron renderer.
- Preserve the complete standalone Web Shell feature configuration.
- Keep daemon/Core as the owner of sessions, tools, permissions, filesystem,
  models, MCP, Computer Use, and voice services.
- Keep Node integration disabled in every renderer.
- Give the renderer a stable, non-opaque application origin and allow only that
  origin through the daemon CORS policy.
- Package an authenticated, loopback-only Qwen runtime with the application.
- Provide a host boundary that can later support embedded browser views,
  overlays, and multiple windows without changing Web Shell internals.

## Non-goals for the parity milestone

- Reimplementing Web Shell screens from internal `components/ui` primitives.
- Moving daemon APIs to Electron IPC.
- Importing or adapting the legacy Electron desktop implementation.
- Adding browser automation, overlay, or multi-window product behavior before
  single-window Web Shell parity is verified.
- Granting arbitrary filesystem, process, or Electron APIs to the renderer.

## Architecture

```text
Electron main process
  - owns application/window lifecycle
  - starts bundled qwen serve
  - owns workspace selection and persisted desktop state
  - serves renderer assets at qwen-desktop://app
  - exposes immutable launch configuration through a narrow preload bridge

Electron renderer (qwen-desktop://app)
  - mounts WebShellWithProviders
  - owns only presentation preferences and current session selection
  - calls daemon HTTP/SSE/WebSocket APIs through @qwen-code/webui

Bundled qwen serve (http://127.0.0.1:<ephemeral>)
  - requires a per-launch bearer token
  - allows only Origin: qwen-desktop://app
  - owns all Qwen application behavior through daemon/Core
```

The daemon is started with:

```text
serve --port 0 --hostname 127.0.0.1 --require-auth
      --allow-origin qwen-desktop://app --workspace <cwd> --no-open
```

The bearer token is generated in the main process and passed to the renderer
through one read-only preload method. It is never placed in a query string,
fragment, local storage, log line, or renderer HTML.

## Renderer integration

The renderer imports the public package entry rather than deep-importing Web
Shell internals:

```tsx
<WebShellWithProviders
  baseUrl={launchConfig.daemonBaseUrl}
  token={launchConfig.daemonToken}
  lockWorkspaceCwd={launchConfig.workspace}
  sidebar
  header={{ items: ['title', 'environment', 'rightPanel'] }}
  rightPanel={{ items: ['review', 'sideTask'] }}
  environmentPanel={{
    items: ['environment', 'subagents', 'backgroundTasks'],
  }}
  compactThinking
  markdownTableMode="advanced"
/>
```

Those product options mirror the standalone Web Shell entry. Theme and
language continue to use the same storage keys so future migrations between
the web and desktop surfaces remain predictable.

The renderer build aliases `@qwen-code/web-shell`, `@qwen-code/webui`, and
`@qwen-code/sdk` to the selected Qwen source tree. This keeps the desktop shell
release checkout isolated from the Qwen revision being bundled while ensuring
the renderer and daemon come from the same revision.

## Security boundary

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- no remote module
- no raw `ipcRenderer` exposure
- navigation restricted to `qwen-desktop://app`
- new windows denied; trusted `http:` and `https:` links open in the isolated
  embedded browser
- daemon listens only on loopback and requires bearer authentication
- daemon CORS admits only `qwen-desktop://app`
- microphone permission is limited to the trusted renderer origin
- renderer CSP denies objects, framing, arbitrary navigation, and unlisted
  network destinations

The preload API exposes only explicit typed methods for the current desktop
surfaces. New native capabilities require another typed method, main-process
validation, and a test proving that untrusted contents cannot invoke it.

## Runtime and lifecycle

The existing runtime preparation format remains useful: a private Node runtime
and bundled Qwen distribution are copied into `runtime/qwen-code`. Electron
main starts that Node binary as a detached process group, captures bounded
startup output, appends runtime logs, waits for authenticated health, and kills
the full group during application shutdown.

Desktop state stores the selected workspace and last normal window bounds.
Invalid or missing workspaces return to a native folder picker. Window bounds
are clamped to a visible display before restoration.

## Packaging

`electron-builder` produces:

- macOS architecture-specific app/DMG/ZIP artifacts,
- Windows NSIS artifacts,
- Linux AppImage and DEB artifacts.

The preview application identifier is
`com.alibaba.qwen-code.electron-preview`, and its product/executable names are
also distinct from Tauri. The Qwen runtime is shipped as an unpacked resource
because it contains executables and native dependencies.

Packaged smoke tests and unsigned Actions artifacts live in a dedicated
Electron preview-build workflow. It has read-only repository permissions and
contains no GitHub release or updater-feed publishing step. The existing Tauri
workflow remains unchanged.

## Phased delivery

### Phase 1: Web Shell parity

- Electron main/preload/renderer skeleton.
- Direct `WebShellWithProviders` integration.
- Bundled daemon startup, authentication, CORS, logs, and shutdown.
- Workspace selection and window-state persistence.
- Theme, language, session, tools, permissions, MCP, settings, review, agents,
  tasks, artifacts, and voice behavior inherited from Web Shell.
- Unit tests and packaged desktop smoke test.

### Phase 2: Desktop product surfaces

- Multi-window workspace/session ownership.
- Embedded browser surface with isolated sessions and explicit navigation
  policy.
- Existing Core Computer Use tools remain available through normal agent
  sessions; a dedicated desktop status/control surface requires a separate
  cross-product design and is not part of the isolated preview.
- Voice overlay window sharing the owning daemon session.

Each surface must use a typed host adapter and must not add a second chat or
session implementation.

## Acceptance criteria

- No Tauri dependency, Cargo project, Tauri configuration, or Tauri release
  command exists in `packages/desktop-electron`; `packages/desktop-shell`
  remains the intact Tauri implementation.
- No production import from `packages/desktop` exists.
- No production or protocol change exists in shared Core, CLI, daemon, ACP, or
  Tauri packages for the Electron preview.
- Renderer source imports `WebShellWithProviders` from the public Web Shell
  entry.
- All daemon browser traffic originates from `qwen-desktop://app` and succeeds
  only with the per-launch bearer token.
- The Web Shell smoke suite passes against the Electron-backed daemon.
- A packaged application starts from a clean profile, chooses a workspace,
  reaches a usable composer, and shuts down its daemon process tree.
