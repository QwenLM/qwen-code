---
name: browser-use
description: Control the user's Chrome through the existing persistent Node REPL and the Qwen Browser SDK.
---

# Browser Use

Use the existing Node REPL MCP tools. Do not start a separate Browser Use MCP
server.

## Setup

If `node_repl` is unavailable, configure it with:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.1
```

Then tell the user to restart Qwen Code and stop. Do not start a separate
Browser Use MCP server.

Qwen reports the absolute `Base directory for this skill` when loading this
file. Resolve the extension root two directories above it. The supported
installation is the published npm package. Confirm that
`<extension-root>/dist/index.js` and
`<extension-root>/node_modules/playwright-core/package.json` exist. If either
is missing, stop and ask the user to reinstall the npm package instead of
installing dependencies into the workspace. Before the first Node REPL cell,
call `node_repl_add_node_module_dir` once with the absolute
`<extension-root>/node_modules` path. Import the SDK from the same installed
extension, replacing the example root below with that absolute path:

```js
globalThis.browserAgent ??= await (
  await import('/absolute/extension/root/dist/index.js')
).setupBrowserRuntime();
globalThis.browser ??= await browserAgent.browsers.get('chrome');
nodeRepl.write(await browser.documentation());
```

Create a tab or claim an exact result returned by `openTabs()`:

```js
globalThis.tab = await browser.tabs.new();
await tab.goto('https://example.com/');
nodeRepl.write(await tab.playwright.domSnapshot());
```

```js
const candidates = await browser.user.openTabs();
nodeRepl.write(candidates);
globalThis.tab = await browser.user.claimTab(
  candidates.find((candidate) => candidate.url === 'https://example.com/'),
);
```

## Interaction

Observe before acting and observe again after acting. Prefer semantic
Playwright locators. Use `tab.dom_cua.get_visible_dom()` and its `node_id`
values when snapshot refs are clearer, and use `tab.cua` for visual coordinate
targets.

```js
await tab.playwright.getByRole('button', { name: 'Continue' }).click();
await tab.playwright.getByLabel('Email').type('user@example.com');
await tab.dom_cua.click({ node_id: 'e4' });
await tab.dom_cua.type({ text: 'hello' });
```

When an action should navigate, arm the Playwright watcher around it:

```js
await tab.playwright.expectNavigation(
  () => tab.playwright.getByRole('link', { name: 'Next' }).click(),
  { url: '**/next.html' },
);
```

Render screenshots with:

```js
{
  const image = await tab.screenshot();
  const png = new DataView(image.buffer, image.byteOffset, image.byteLength);
  nodeRepl.write({ width: png.getUint32(16), height: png.getUint32(20) });
  await nodeRepl.emitImage(image);
}
```

Coordinate CUA uses the original PNG's CSS-pixel coordinates. If the displayed
preview is resized, scale positions to the reported intrinsic dimensions.

Use `tab.dev.logs()` for bounded console diagnostics. Arm
`tab.playwright.waitForEvent('download' | 'filechooser')` before the action that
triggers it. Handle JavaScript dialogs through `tab.getJsDialog()`. Use a
focused `tab.playwright.evaluate()` only when locators cannot obtain the needed
data.

Use `browser.user.history()` only when the task needs browser history, with a
focused query and bounded result count.

## Finish

Treat `browser.tabs.finalize({ keep })` as the final browser action of the turn.
Omitted agent-created tabs close; omitted claimed tabs are released without
closing. `keep` is the complete set for this call. Keep a user-facing result as
`deliverable`, and keep a live page under control as `handoff`. Repeat a
handoff in each later turn that still needs it; omitting it from the next
finalize call or closing the runtime closes an agent-created tab.

```js
await browser.tabs.finalize({
  keep: [{ tab, status: 'deliverable' }],
});
```

The Node kernel preserves `globalThis` and top-level bindings across cells.
Keep cells short, await every Browser SDK promise, and use `nodeRepl.write()` to
return text or structured data.
