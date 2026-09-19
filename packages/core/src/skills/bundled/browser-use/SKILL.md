---
name: browser-use
description: Control the user's Chrome through the existing persistent Node REPL and the Qwen Browser SDK.
---

# Browser Use

Browser Use is bundled with Qwen Code and uses the generic Node REPL MCP tools
and the Qwen Chrome extension. Do not install a separate Qwen extension or
start a separate Browser Use MCP server.

## Setup

Install and enable the Qwen Code Chrome extension in the profile the user wants
to use. On macOS and Linux, first use of this SDK automatically registers the
shared Native Messaging host in the user's installation directory. A browser
task opts into this local setup, which can finish before the extension connects.
The SDK checks the actual connection and protocol instead of reading Chrome's
extension preferences.

If the extension does not connect, ask the user to open Chrome and check the
extension in the intended profile. There is no store listing yet: build the
extension from `packages/chrome-extension` in the Qwen Code repository (its
README) and load `dist/extension` through `chrome://extensions` (Developer mode
→ Load unpacked). After installation or enabling it, retry the connection.

A usable Host of the same protocol is reused. A Host installed by a newer Qwen
Code is never downgraded: if setup reports one, tell the user to update Qwen
Code and stop. The Host files persist after Qwen exits. The user can inspect or
remove them with `node <skill-base>/runtime/scripts/native-host-setup.js status`
or `uninstall`; `install` explicitly switches the Host to this Qwen Code's copy
from the next time Chrome starts it. A later Browser Use initialization can
register the Host again. If required Host files cannot be read or written,
report the failing action and path so the user can resolve access and retry.

Multiple Qwen sessions can use the same profile, each controlling its own tabs.
A tab held by another session reports `TAB_OWNERSHIP_CONFLICT`. Use another tab
or wait for that session to release it. The setup below binds the runtime to
the default profile through `browserAgent.browsers.get('chrome')`. Only when the
user names a specific Chrome profile, call `browserAgent.browsers.list()` before
that line and pass the returned ID to `browserAgent.browsers.get(id)` instead.
The runtime stays bound to the first profile it connects to; to switch profiles,
call `node_repl_reset` and run the setup again.

If `node_repl` is unavailable, configure it with:

```bash
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@0.1.6
```

Then tell the user to restart Qwen Code and stop. Do not start a separate
Browser Use MCP server. Screenshot metadata requires `@qwen-code/node-repl-mcp`
0.1.6 or later, so keep this exact pin.

Qwen reports the absolute `Base directory for this skill` when loading this
file. Use that directory as `<skill-base>`. Confirm that
`<skill-base>/runtime/index.js` and
`<skill-base>/runtime/node_modules/playwright-core/package.json` exist. If
either is missing, stop and report an incomplete Browser Use runtime instead
of installing dependencies into the workspace. Before the first Node REPL
cell, call `node_repl_add_node_module_dir` once with the absolute
`<skill-base>/runtime/node_modules` path. Import the bundled SDK, replacing the
example skill base below with that absolute path:

```js
globalThis.browserAgent ??= await (
  await import('/absolute/skill/base/runtime/index.js')
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

Render screenshots with their metadata:

```js
await nodeRepl.emitImage(await tab.screenshot());
```

The metadata reaches the model only through `@qwen-code/node-repl-mcp` 0.1.6
or later; an older server accepts the call and silently drops it. If
`node_repl` was registered before this skill existed, check its command with
`qwen mcp list`, and when it pins an older version, re-register it with the
`qwen mcp add` command from Setup above and ask the user to restart Qwen Code.

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
