/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_CHROME_DOCUMENTATION = `# Qwen Browser Use

This runtime controls the user's existing Chrome through an explicitly installed extension and a local Native Messaging bridge.

## Control boundary

- Installing the extension is the user's consent. browser.user.openTabs() lists every open top-level http(s) tab across the user's Chrome windows, ordered by lastOpened descending.
- To take over an already-open tab, call browser.user.openTabs(), choose the matching returned object by its visible title, url, lastOpened and tabGroup, then pass that exact object to browser.user.claimTab().
- Claiming controls the chosen tab in place, without moving it into an agent tab group, and returns a normal controllable Tab.
- A claim fails closed if the tab title or URL changed after discovery; list open tabs again instead of claiming a different tab.
- Do not guess tab ids. Only claim ids that came from the current openTabs() result.
- tabs.new() creates a new agent tab in the user's Chrome; it shares the profile's cookies and signed-in state.
- browser.user.history({ queries?, from?, to?, limit? }) lists recent browsing history ordered by dateVisited descending.
- Kernel reset loses JavaScript handles but does not close Chrome or erase its profile. Re-run setup and claim the tab again.

## API

- Tab: goto, url, title, back, forward, reload, close, screenshot (viewport, clip, or fullPage).
- Coordinate CUA (tab.cua): click, double_click, drag, keypress, move, scroll and type act on viewport CSS-pixel coordinates, i.e. positions read from a screenshot; use it when the target exists only in pixels. click button values are 1=left, 2=middle, 3=right, 4=back and 5=forward.
- goto waits for Playwright's default load state and tolerates redirects; read tab.url() afterwards for the final address.
- Semantic locator: CSS, role, text, label, placeholder, test id, filter, first/last/nth, and/or. getByText resolves to the innermost matching element.
- Locator reads: count, allTextContents, innerText, textContent, getAttribute, isEnabled and isVisible. Reads other than count accept timeoutMs where the SDK signature provides it.
- Evaluation: tab.playwright.evaluate(pageFunction, arg?, options?), locator.evaluate(pageFunction, arg?, options?) and locator.evaluateAll(pageFunction, arg?, options?). Use these for inspection and use action APIs for page changes. Page functions may be JavaScript functions or expression strings and must use JSON-serializable arguments and results.
- Locator actions: click, dblclick, downloadMedia, fill, type, press, selectOption, check, uncheck and setChecked. downloadMedia triggers a download for the matched media or file link. Playwright provides strict locator matching, actionability checks, auto-waiting, and a default 30s timeout.
- click/dblclick/check scroll the element into view and send real input events (options: button, modifiers, force where applicable). A covered element is reported instead of clicked unless force is set.
- press("Enter"), press("Control+a") and type("text") send real keyboard events. type() inserts at the current selection without clearing existing text; use fill() to replace a value.
- For uploads, arm playwright.waitForEvent("filechooser") before clicking, then call chooser.isMultiple() and chooser.setFiles(paths). Paths must name existing absolute files and each call is limited to 100 MB.
- playwright.domSnapshot() returns Playwright's AI accessibility snapshot. tab.dom_cua.get_visible_dom() returns a filtered listing of interactable elements with node ids such as [ref=e12]. Use dom_cua.click({ node_id: "e12" }) or double_click() for a listed node, then dom_cua.type({ text }) or keypress({ keys }) at the current focus. dom_cua.scroll({ node_id?, x, y }) scrolls the page or a listed node. Take a new snapshot after navigation or when a node id becomes stale.
- iframes: snapshots expand same-origin and cross-origin iframes beneath their "iframe" line; elements inside a frame use Playwright refs such as [ref=f1e3], which dom_cua accepts. tab.playwright.frameLocator(selector), chainable on frame locators, scopes getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/locator to that frame's document.
- Waits live on tab.playwright (not on tab): locator.waitFor({ state }), tab.playwright.expectNavigation(action, options), tab.playwright.waitForEvent("filechooser" | "download"), tab.playwright.waitForURL(url), tab.playwright.waitForLoadState(options), tab.playwright.waitForTimeout(ms). Arm event waiters before the triggering action. A download event confirms that the browser started a download but does not expose its local path. expectNavigation arms its waiter before invoking the action, so fast click-triggered navigations are not missed.
- tab.dev.logs({ filter?, levels?, limit? }) returns console messages and uncaught exceptions captured since the tab was claimed.
- JavaScript dialogs: call tab.getJsDialog() to read the dialog type and message. While a dialog is open, page operations fail with DIALOG_OPEN instead of waiting for a timeout. Alerts and before-unload dialogs can be dismissed, confirms can be accepted or dismissed, and prompts require text when accepted.
- A claimed tab that is closed, crashed, or whose debugger the user revoked reports STALE_TAB on the next command; claim a tab again to continue.
- Screenshots return PNG bytes as Uint8Array. They use CSS pixels so coordinate CUA can act on positions read from the image.
- Clipboard and raw CDP are not exposed.

- Browser transport, serialization, snapshot truncation and screenshot budgets are runtime details rather than model-facing controls.`;
