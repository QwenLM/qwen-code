# Qwen Code Electron desktop

This package is the Electron host for the existing Qwen Code Web Shell. The
renderer imports `WebShellWithProviders`; it does not maintain a second chat or
session implementation.

It lives alongside the retained Tauri implementation in
`packages/desktop-shell`; the two packages have independent application
identities, dependencies, build output, and CI workflows.

The package is intentionally isolated from the root npm workspace so Electron
and electron-builder do not enter the root dependency graph.

## Architecture

- Electron main owns windows, workspace selection, desktop state, and the
  bundled runtime process.
- The sandboxed preload exposes a typed, allowlisted desktop bridge.
- The renderer runs at `qwen-desktop://app` and mounts the public Web Shell
  component.
- The renderer connects directly to the authenticated loopback daemon through
  the existing daemon React SDK.
- Daemon/Core continues to own models, sessions, tools, permissions, MCP,
  filesystem access, Computer Use, and voice services.

Multiple chat windows share one daemon while retaining their own current
session. The embedded browser uses an isolated `WebContentsView` session and
never receives the daemon token or preload bridge. Existing Core Computer Use
tools remain available to agents without adding Electron-specific routes or
changing shared daemon behavior. The Voice overlay controls the same signed
Live Host session already exposed by Web Shell.

The bundled daemon listens on an ephemeral `127.0.0.1` port, requires a random
per-launch bearer token, and allows browser API requests only from
`qwen-desktop://app`.

## Local development

From this directory:

```bash
npm install --workspaces=false
npm run build:runtime --workspaces=false
npm run build:app --workspaces=false
QWEN_DESKTOP_WORKSPACE=/absolute/path npm start --workspaces=false
```

`npm run dev` rebuilds the Electron application processes and starts the same
packaged renderer. Use the explicit build/start commands when debugging one
stage.

The renderer resolves Web Shell, Web UI, and SDK sources from the repository
root. Set `QWEN_CODE_ROOT` when the Qwen source tree is elsewhere, as the
Electron preview-build workflow does.

## Verification

```bash
npm run typecheck --workspaces=false
npm test --workspaces=false
npm run smoke:runtime --workspaces=false
```

The packaged smoke accepts an application executable or macOS `.app` path:

```bash
npm run smoke:packaged --workspaces=false -- /path/to/application
```

## Preview builds

`npm run build` prepares the selected Qwen runtime, builds the Electron
main/preload/renderer, and invokes electron-builder. Runtime executables are
shipped as application resources rather than inside ASAR.

The dedicated preview-build workflow produces unsigned Actions artifacts only;
it cannot publish a GitHub release or update the Tauri `desktop-latest` feed.
The preview uses the separate application identifier
`com.alibaba.qwen-code.electron-preview` and product name
`Qwen Code Desktop Electron Preview`, so it can be installed beside Tauri.
