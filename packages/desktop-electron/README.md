# Qwen Code Electron desktop

This package is an independent Electron host for the existing standalone Qwen
Code Web Shell. It lives alongside the retained Tauri implementation in
`packages/desktop-shell` with a separate application identity, dependency
graph, build output, and CI workflow.

## Architecture

Electron starts the same authenticated loopback `qwen serve` runtime used by
Tauri and navigates its single `BrowserWindow` directly to the daemon-served
Web Shell URL. The bearer token travels once in the URL fragment and is then
handled by the standalone Web Shell entry.

Electron does not build or maintain another React renderer. The HTML, CSS,
providers, routing, settings, plugins, sessions, tools, permissions, MCP, and
all other product UI come from `lib/web-shell` in the bundled Qwen runtime.
This keeps product rendering parity as a build invariant; Electron-owned CSS
is limited to macOS window drag regions, the sidebar window-control inset, and
a Chromium tooltip hit-testing workaround.

The main process also follows Web Shell's standard `theme-color` metadata so
the operating-system appearance and window background switch between light and
dark with the page. On macOS, Electron keeps the native traffic-light controls
over an inset inside Web Shell's sidebar while the main Web Shell header reaches
the top edge and doubles as a drag region. The page remains sandboxed and does
not receive Electron APIs, a preload bridge, or desktop-owned theme state.

The preview intentionally provides one Web Shell window only. It does not add
an embedded browser, Voice overlay, additional chat windows, renderer IPC, or
a preload bridge. Safe external HTTP(S) links are handed to the operating
system browser.

## Local development

From this directory:

```bash
npm install --workspaces=false
npm run build:runtime --workspaces=false
npm run build:app --workspaces=false
QWEN_DESKTOP_WORKSPACE=/absolute/path npm start --workspaces=false
```

The runtime build compiles the selected Qwen source tree, including the
standalone Web Shell. Set `QWEN_CODE_ROOT` when that source tree is elsewhere.

## Verification

```bash
npm run typecheck --workspaces=false
npm test --workspaces=false
npm run smoke:runtime --workspaces=false
npm run test:release --workspaces=false
```

The packaged smoke accepts an application executable or macOS `.app` path:

```bash
npm run smoke:packaged --workspaces=false -- /path/to/application
```

## Preview builds

`npm run build` prepares the selected Qwen runtime, bundles the Electron main
process, and invokes electron-builder. Runtime executables and the standalone
Web Shell are shipped as application resources rather than inside ASAR.

The dedicated preview-build workflow produces unsigned Actions artifacts only;
it cannot publish a GitHub release or update the Tauri `desktop-latest` feed.
The preview uses `com.alibaba.qwen-code.electron-preview` and the product name
`Qwen Code Desktop Electron Preview`, so it can be installed beside Tauri.
