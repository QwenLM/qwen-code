# Computer Use runtime

Register `@qwen-code/node-repl-mcp` as an MCP server. Its `js` tool preloads the global `cua` object and displays the current platform's documentation. Use `cua.rewriteDocumentation()` after context compaction.

```js
var app = await cua.getApp('TextEdit'); // full AX text, no image
await app.click(3);
await app.typeText('Hello');
await app.getAXState(); // driver-rendered diff
```

`getAXState`, `getScreenshot` and `getAXStateAndScreenshot` return strings and display their output automatically. `{emit:false}` suppresses display. `{forceFull:true,maxTextChars:20000}` requests a larger complete AX view. Screenshot-only calls skip accessibility walking. Coordinates use the latest screenshot of that window. Actions return void; observe their result in the same JavaScript call. A dispatched action is never automatically replayed.

The native driver owns application/window resolution, short IDs, snapshot cursors, rendering, text budgets, delivery and errors. Each app operation uses one SDK call. IDs are scoped to the current app window and authenticated session. Errors preserve `code`, `reason`, `sent` and `next` across direct MCP and JavaScript. An unconfirmed dispatch displays an advisory before returning.

The direct `qwen-cua-driver mcp` entry point exposes the same app operations and parameters, using snake_case names. `computer-use/interface.json` is generated from the Rust contract with `cargo run -p cua-driver-contract --bin cua-contract-gen -- computer-use`; the same source supplies MCP descriptions and runtime documentation. Set the host environment `CUA_DRIVER_EXTRA_TOOLS=1` to also list advanced native tools. The underlying typed SDK remains available from `@qwen-code/cua-sdk` for native integrations.

`ComputerUse.create()` owns an embedded native runtime and its authenticated session. Standalone daemon clients use the low-level `CuaDriver.connect(socketPath)` transport. The compatibility `ComputerUse.connect()` factory cannot bind a trusted facade session to an ordinary `serve` daemon. Close the owning transport when finished. Node REPL supplies cancellation barriers and waits for native cleanup after dispatch.

Linux supports X11 applications, including X11 apps under XWayland. Inherit DISPLAY, XAUTHORITY and the desktop accessibility session bus. Native Wayland targets are unsupported.


## Explicit desktop and browser interfaces

`cua.desktop.getScreenshot()` displays the primary display. Desktop point actions use pixels from that session's latest image; changed display geometry invalidates it. `click({x,y},{key:'shift'})` holds modifiers around one click. `keyDown/keyUp` are session-owned desktop operations; use try/finally and release keys before app input or ordinary text/chords. Normal reset, session end and runtime shutdown release held keys; abrupt process termination cannot promise release.

`cua.getBrowser('Chrome')` displays that browser's documentation and tabs. `getTab(id,{browser:'Chrome'})` or an unambiguous `{url}` displays its DOM snapshot; `createBrowserTab('Chrome',url)` opens and displays a tab. These return the existing browser-use SDK objects without changing their methods or behavior. Browser extension setup remains required. The browser SDK is a same-version npm dependency, separate from the native driver.

Direct MCP uses the same operation names with `scope:'desktop'` instead of `app`. The default manifest contains 19 operations. Internal start/end lifecycle calls remain callable without enlarging the default inventory.
