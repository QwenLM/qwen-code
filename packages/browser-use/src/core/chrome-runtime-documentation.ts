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
- The user's open tabs and history are private data. Read only what the task needs and do not repeat unrelated entries back to the user.
- Kernel reset loses JavaScript handles but does not close Chrome or erase its profile. Re-run setup and claim the tab again.

## API

- Tab: goto, url, title, back, forward, reload, close, screenshot (viewport, clip, or fullPage).
- Coordinate CUA (tab.cua): click, double_click, drag, keypress, move, scroll and type act on viewport CSS-pixel coordinates, i.e. positions read from a screenshot; use it when the target exists only in pixels.
- goto waits for the requested load state (default "load") and tolerates redirects; read tab.url() afterwards for the final address.
- Semantic locator: CSS, role, text, label, placeholder, test id, filter, first/last/nth, and/or. getByText resolves to the innermost matching element.
- Locator reads: count, allTextContents, innerText, textContent, inputValue, getAttribute, isEnabled, isVisible, isChecked, boundingBox. Reads wait at most 1s by default; pass timeoutMs explicitly, or use timeoutMs: 0 for one immediate check.
- Page evaluation: tab.playwright.evaluate(pageFunction, arg?, options?), locator.evaluate(pageFunction, arg?, options?) and locator.evaluateAll(pageFunction, arg?, options?). Page functions may be JavaScript functions or expression strings; arguments and results must be JSON-serializable.
- Locator actions: click, dblclick, hover, fill, type, press, selectOption, check, uncheck, setChecked, scroll, scrollIntoViewIfNeeded, setInputFiles, screenshot. Actions wait (default 30s, timeoutMs option) until the locator matches exactly one visible, enabled element; an ambiguous locator fails immediately with LOCATOR_NOT_UNIQUE.
- Locator resolution/actionability failures may expose error.details.kind (invalid_selector, stale_ref, no_matches, multiple_matches, no_visible_match, intercepted or action_failed) plus bounded match/visibility diagnostics.
- click/dblclick/hover/check scroll the element into view and send real mouse events at its centre (options: button, modifiers, force). A covered element is reported instead of clicked unless force is set.
- press("Enter"), press("Control+a") and type("text") send real keyboard events to the focused element. type() verifies that the text arrived and raises INPUT_BLOCKED when a browser-level dialog (for example Chrome's password warning after a login) is swallowing input on the tab; ask the user to dismiss it or continue in a new tab.
- setInputFiles(paths) attaches local files to a known <input type=file>. For custom upload controls, arm playwright.waitForEvent("filechooser") before clicking, then call chooser.isMultiple() and chooser.setFiles(paths). Only absolute paths inside the configured upload directories are accepted (UPLOAD_BLOCKED otherwise).
- playwright.domSnapshot({ filter?: "interactive" | "all", maxChars?, root? }) lists visible elements with stable refs such as [n12]. tab.dom_cua.get_visible_dom() returns the same listing; dom_cua.click/double_click/hover/type/keypress/scroll({ nodeId: "n12", ... }) act on a listed element directly. Refs stay valid until the document navigates.
- iframes: the snapshot expands same-origin and cross-origin iframes beneath their "iframe" line; elements inside a frame carry path refs such as [n7/n3] (element n3 inside iframe n7), which ref steps, dom_cua and root accept. tab.playwright.frameLocator(selector) (chainable, also on locators) scopes getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/locator to that frame's document; every read and action works inside frames with real input events at the correct viewport coordinates.
- Waits live on tab.playwright (not on tab): locator.waitFor(), tab.playwright.expectNavigation(action, options), tab.playwright.waitForEvent("filechooser" | "download"), tab.playwright.waitForURL(url), tab.playwright.waitForLoadState(state), tab.playwright.waitForTimeout(ms). Arm event waiters before the triggering action. A download handle exposes path({ timeoutMs? }), which waits for completion and returns Chrome's local path when available. expectNavigation arms its waiter before invoking the action, so fast click-triggered navigations are not missed. waitForLoadState("networkidle") waits until no request has been in flight for 500ms (responses the page never finishes reading stop counting after one second).
- tab.dev.logs({ filter?, levels?, limit?, clear? }) returns console messages and uncaught exceptions captured since the tab was claimed (a cross-origin navigation clears them); tab.dev.network({ urlPattern?, limit?, clear? }) returns requests with method, status and mime type (no bodies).
- JavaScript dialogs: while an alert/confirm/prompt/beforeunload dialog is open every page command fails immediately with DIALOG_OPEN. Call tab.getJsDialog() to read its type and message, then accept(promptText?) or dismiss() it.
- A claimed tab that is closed, crashed, or whose debugger the user revoked reports STALE_TAB on the next command; claim a tab again to continue.
- Screenshots are PNG images in CSS pixels: one image pixel equals one viewport pixel; the envelope reports width, height, viewport and devicePixelRatio. locator.screenshot() captures one element and adds its box.
- Clipboard and raw CDP are not exposed.

- Log entries include source location and a bounded exception stack when Chrome provides them.

The compatibility facade is used by the Qwen Node Kernel Browser SDK. New protocol adapters should call the model-neutral executePrimitive() contract.`;
