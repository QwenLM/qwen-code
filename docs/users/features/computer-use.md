# Computer Use

Computer Use runs through the standalone Node REPL MCP server. Its first `js` call loads global `cua` and displays documentation for the current platform. Computer Use and Browser Use no longer require bundled skills.

```text
Qwen Code / any MCP client
  -> @qwen-code/node-repl-mcp (js, js_reset)
  -> @qwen-code/cua-sdk/runtime
     -> native Qwen CUA Driver (desktop applications)
     -> @qwen-code/browser-use (Qwen browser extension)
```

## Setup

Node.js 22 or later and npm are required. Register the MCP server, then restart Qwen Code:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.26.0
```

The server installs the matching SDK and browser SDK as dependencies. The native SDK payload is downloaded for the current platform and verified against the matching release's SHA-256 checksums. It is cached outside the npm package; no workspace SDK bootstrap command is needed. Version 0.26.0 is a local development target until its release is published.

## Application tasks

```js
var app = await cua.getApp('Microsoft Excel');
// Use a short ID from the automatically displayed AX state.
await app.click(37);
await app.typeText('hello');
await app.getAXState();
```

`getApp` displays full AX text without an image. `getAXState` displays subsequent diffs. `getScreenshot` captures only the current window; `getAXStateAndScreenshot` captures both. Observations return strings and display themselves; `{emit:false}` suppresses output. Request a screenshot before using `{x,y}` coordinates, which are pixels in that window's current screenshot.

The driver resolves applications/windows, owns current short IDs and coordinates, and chooses input delivery. macOS uses accessibility and directed events. Windows and Linux try background delivery first and use foreground input only after a refusal that proves nothing was sent. Foreground input stops when physical user activity is detected; it restores the prior application only if the user has not switched elsewhere. A dispatch acknowledgement does not prove the UI changed: observe before retrying.

Linux supports X11, including X11 applications under XWayland. Native Wayland applications are unsupported. Pass DISPLAY, XAUTHORITY and the desktop accessibility session bus to the server.

## Desktop and browser tasks

Use the explicit desktop interface for full-screen tasks:

```js
await cua.desktop.getScreenshot();
await cua.desktop.click({ x: 300, y: 200 }, { key: 'shift' });
```

Desktop coordinates are pixels in the latest primary-display screenshot. Desktop input controls the visible foreground desktop and can move the real pointer. For held keys, always use `try/finally` with `cua.desktop.keyDown(key)` and `keyUp(key)`. Held keys belong to the calling session and are released on graceful reset/end. While holding keys, use `keyDown/keyUp` for chords and desktop pointer actions without explicit modifiers; release them before text, ordinary shortcuts or application input. Abrupt OS process termination cannot guarantee cleanup.

```js
var browser = await cua.getBrowser('Chrome');
// Browser documentation and tabs are displayed on first selection.
var tab = await cua.getTab('TAB_ID', { browser: 'Chrome' });
await tab.playwright.domSnapshot();
```

`getBrowser`, `getTab`, and `createBrowserTab` return the existing repository browser-use SDK handles. Follow the selected browser's runtime documentation and connect the Qwen browser extension as before. The integration adds no browser windows API, DOM diff or new Windows support.

## Permissions and lifecycle

The server executes JavaScript with ordinary Node.js permissions and follows the client's MCP approval flow. On macOS, Accessibility is required for input/AX observation and Screen Recording for screenshots; Automation may be requested for document save/Finder rename. Grants belong to the host process's OS responsibility chain. On Windows, the normal installed daemon uses the existing UAC/logon-task path; applications it launches use a token derived from its own token at normal-user integrity. UIAccess is optional: explicitly setting `CUA_DRIVER_USE_UIACCESS=1` requires a trusted signed worker under Program Files and fails if unavailable. Default npm installation does not stage that worker or require its signature.

`js` completes in one call and defaults to a 30-second timeout. A timeout can leave external effects; observe before retrying. `js_reset` discards bindings and gracefully closes the owning native/browser session. After context compaction call `cua.rewriteDocumentation()` before continuing.

## Remote desktop relay

For an existing macOS desktop relay setup, install its matching server:

```bash
npx -y @qwen-code/node-repl-mcp@0.26.0 desktop-relay install
```

This uses the existing local launchd socket at `127.0.0.1:47821`. In a secure Web Shell, choose **Use this computer**, then **Connect this computer**. The desktop prompts for each connection. The remote daemon must enable `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`.

## Direct MCP and troubleshooting

`qwen-cua-driver mcp` exposes the same 19 native Computer Use operations directly. App calls use `app`; desktop-capable calls use `scope:"desktop"` instead. `key_down/key_up` are desktop-only. Advanced native tools remain available through the host opt-in `CUA_DRIVER_EXTRA_TOOLS=1`.

If the server is unavailable, check `qwen mcp list` and restart the client after adding it. If capture fails, check the current desktop session and OS permissions. If native download fails, check the exact release version/checksum asset or supply a locally built matching payload through `QWEN_CUA_SDK_NATIVE_DIR`. A locked desktop cannot provide GUI acceptance evidence.

See [MCP servers](./mcp.md), [Approval Mode](./approval-mode.md) and [Sandboxing](./sandbox.md).
