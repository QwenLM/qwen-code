/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';
import { createBrowserBackend } from './sdk-backend.js';

let nodeReplRuntime;
let backendPromise;

function jsonBoundary(value, label) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return JSON.parse(serialized);
  } catch (error) {
    const wrapped = new TypeError(label + ' must be JSON-serializable');
    wrapped.cause = error;
    throw wrapped;
  }
  throw new TypeError(label + ' must be JSON-serializable');
}

const call = async (method, args) => {
  if (!nodeReplRuntime || !backendPromise) {
    throw new Error(
      'Browser SDK is not initialized; call setupBrowserRuntime(nodeRepl)',
    );
  }
  const backend = await backendPromise;
  const result = await backend.dispatch(
    method,
    jsonBoundary(args, 'Browser operation arguments'),
  );
  return jsonBoundary(result, 'Browser operation result');
};

function matcher(value) {
  if (utilTypes.isRegExp(value))
    return { regex: value.source, flags: value.flags };
  if (typeof value !== 'string')
    throw new TypeError('Text matcher must be a string or RegExp');
  return value;
}

async function screenshotCall(method, args) {
  const image = await call(method, args);
  return {
    ...image,
    mimeType: image.mediaType,
    bytes: Buffer.from(image.base64, 'base64'),
  };
}

function timeoutOptions(options) {
  return options && typeof options.timeoutMs === 'number'
    ? { timeoutMs: options.timeoutMs }
    : {};
}

function navigationOptions(options) {
  const result = timeoutOptions(options);
  if (options && typeof options.waitUntil === 'string')
    result.waitUntil = options.waitUntil;
  return result;
}

function actionOptions(options) {
  if (!options) return {};
  return timeoutOptions(options);
}

function evaluateArg(value) {
  if (value === undefined) return 'undefined';
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch (error) {
    const wrapped = new TypeError(
      'playwright.evaluate arg must be JSON-serializable',
    );
    wrapped.cause = error;
    throw wrapped;
  }
  throw new TypeError('playwright.evaluate arg must be JSON-serializable');
}

function pageEvaluateScript(pageFunction, arg) {
  const serializedArg = evaluateArg(arg);
  if (typeof pageFunction === 'string') {
    if (pageFunction.length === 0)
      throw new TypeError('playwright.evaluate requires a pageFunction');
    return 'const arg = ' + serializedArg + ';\nreturn (' + pageFunction + ');';
  }
  if (typeof pageFunction === 'function') {
    return [
      'const arg = ' + serializedArg + ';',
      'const __playwrightEvaluate = (' + pageFunction.toString() + ');',
      'return await __playwrightEvaluate(arg);',
    ].join('\n');
  }
  throw new TypeError('playwright.evaluate requires a string or function');
}

function locatorEvaluateScript(pageFunction, arg, mode) {
  const serializedArg = evaluateArg(arg);
  const method = mode === 'all' ? 'locator.evaluateAll' : 'locator.evaluate';
  if (typeof pageFunction === 'string') {
    if (pageFunction.length === 0)
      throw new TypeError(method + ' requires a pageFunction');
    return 'const arg = ' + serializedArg + ';\nreturn (' + pageFunction + ');';
  }
  if (typeof pageFunction === 'function') {
    return [
      'const arg = ' + serializedArg + ';',
      'const __playwrightEvaluate = (' + pageFunction.toString() + ');',
      'return await __playwrightEvaluate(' +
        (mode === 'all' ? 'elements' : 'element') +
        ', arg);',
    ].join('\n');
  }
  throw new TypeError(method + ' requires a string or function');
}

function clickOptions(options) {
  const result = timeoutOptions(options);
  if (!options) return result;
  if (options.button !== undefined) result.button = options.button;
  if (Array.isArray(options.modifiers))
    result.modifiers = options.modifiers.map(String);
  if (options.force === true) result.force = true;
  return result;
}

function refSteps(nodeId) {
  const raw =
    typeof nodeId === 'number'
      ? 'n' + nodeId
      : String(nodeId == null ? '' : nodeId).trim();
  const ref = /^\d+$/.test(raw) ? 'n' + raw : raw;
  if (!/^n\d+(\/n\d+)*$/.test(ref))
    throw new TypeError(
      'nodeId must be a snapshot ref such as "n12" or "n7/n3" inside a frame',
    );
  return [{ kind: 'ref', ref }];
}

function frameStep(selector) {
  return { kind: 'frame', selector: String(selector) };
}

function textStep(kind, text, options) {
  const step = { kind, text: matcher(text) };
  if (options && typeof options.exact === 'boolean') step.exact = options.exact;
  return step;
}

function roleStep(role, options) {
  const step = { kind: 'getByRole', role: String(role) };
  if (options && options.name !== undefined) step.name = matcher(options.name);
  if (options && typeof options.exact === 'boolean') step.exact = options.exact;
  return step;
}

class LocatorProxy {
  constructor(tabId, steps) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'steps', {
      value: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
      enumerable: false,
    });
  }

  append(step) {
    return new LocatorProxy(this.tabId, [...this.steps, step]);
  }
  locator(selector, options) {
    const next = this.append({ kind: 'locator', selector: String(selector) });
    return options ? next.filter(options) : next;
  }
  getByRole(role, options) {
    return this.append(roleStep(role, options));
  }
  getByText(text, options) {
    return this.append(textStep('getByText', text, options));
  }
  getByLabel(text, options) {
    return this.append(textStep('getByLabel', text, options));
  }
  getByPlaceholder(text, options) {
    return this.append(textStep('getByPlaceholder', text, options));
  }
  getByTestId(testId) {
    return this.append({ kind: 'getByTestId', testId: String(testId) });
  }
  first() {
    return this.append({ kind: 'first' });
  }
  last() {
    return this.append({ kind: 'last' });
  }
  nth(index) {
    if (!Number.isInteger(index))
      throw new TypeError('nth index must be an integer');
    return this.append({ kind: 'nth', index });
  }
  filter(options = {}) {
    const step = { kind: 'filter' };
    if (options.hasText !== undefined) step.hasText = matcher(options.hasText);
    if (options.hasNotText !== undefined)
      step.hasNotText = matcher(options.hasNotText);
    if (typeof options.visible === 'boolean') step.visible = options.visible;
    if (options.has instanceof LocatorProxy) step.has = [...options.has.steps];
    if (options.hasNot instanceof LocatorProxy)
      step.hasNot = [...options.hasNot.steps];
    return this.append(step);
  }
  and(other) {
    if (!(other instanceof LocatorProxy))
      throw new TypeError('and expects a Locator');
    return this.append({ kind: 'and', steps: [...other.steps] });
  }
  or(other) {
    if (!(other instanceof LocatorProxy))
      throw new TypeError('or expects a Locator');
    return this.append({ kind: 'or', steps: [...other.steps] });
  }
  frameLocator(selector) {
    return new FrameLocatorProxy(this.tabId, [
      ...this.steps,
      frameStep(selector),
    ]);
  }
  async all() {
    const count = await this.count();
    return Array.from({ length: count }, (_, index) => this.nth(index));
  }

  args(extra = {}) {
    return { tabId: this.tabId, steps: this.steps, ...extra };
  }
  count() {
    return call('locator.count', this.args());
  }
  evaluate(pageFunction, arg, options) {
    return call(
      'locator.evaluate',
      this.args({
        script: locatorEvaluateScript(pageFunction, arg, 'one'),
        ...timeoutOptions(options),
      }),
    );
  }
  evaluateAll(pageFunction, arg, options) {
    return call(
      'locator.evaluateAll',
      this.args({
        script: locatorEvaluateScript(pageFunction, arg, 'all'),
        ...timeoutOptions(options),
      }),
    );
  }
  allTextContents(options) {
    return call('locator.allTextContents', this.args(timeoutOptions(options)));
  }
  innerText(options) {
    return call('locator.innerText', this.args(timeoutOptions(options)));
  }
  textContent(options) {
    return call('locator.textContent', this.args(timeoutOptions(options)));
  }
  getAttribute(name, options) {
    return call(
      'locator.getAttribute',
      this.args({ name: String(name), ...timeoutOptions(options) }),
    );
  }
  isEnabled(options) {
    return call('locator.isEnabled', this.args(timeoutOptions(options)));
  }
  isVisible(options) {
    return call('locator.isVisible', this.args(timeoutOptions(options)));
  }
  isChecked(options) {
    return call('locator.isChecked', this.args(timeoutOptions(options)));
  }
  inputValue(options) {
    return call('locator.inputValue', this.args(timeoutOptions(options)));
  }
  boundingBox(options) {
    return call('locator.boundingBox', this.args(timeoutOptions(options)));
  }
  scrollIntoViewIfNeeded(options) {
    return call(
      'locator.scrollIntoViewIfNeeded',
      this.args(timeoutOptions(options)),
    );
  }
  click(options) {
    return call('locator.click', this.args(clickOptions(options)));
  }
  dblclick(options) {
    return call('locator.dblclick', this.args(clickOptions(options)));
  }
  hover(options) {
    const extra = timeoutOptions(options);
    if (options && Array.isArray(options.modifiers))
      extra.modifiers = options.modifiers.map(String);
    return call('locator.hover', this.args(extra));
  }
  scroll(options = {}) {
    return call(
      'locator.scroll',
      this.args({
        scrollX: Number(options.scrollX || 0),
        scrollY: Number(options.scrollY || 0),
        ...timeoutOptions(options),
      }),
    );
  }
  setInputFiles(paths, options) {
    const list = Array.isArray(paths) ? paths : [paths];
    return call(
      'locator.setInputFiles',
      this.args({ paths: list.map(String), ...timeoutOptions(options) }),
    );
  }
  screenshot(options) {
    return screenshotCall(
      'locator.screenshot',
      this.args(timeoutOptions(options)),
    );
  }
  fill(value, options) {
    return call(
      'locator.fill',
      this.args({ value: String(value), ...timeoutOptions(options) }),
    );
  }
  type(value, options) {
    return call(
      'locator.type',
      this.args({ value: String(value), ...timeoutOptions(options) }),
    );
  }
  press(value, options) {
    return call(
      'locator.press',
      this.args({ value: String(value), ...timeoutOptions(options) }),
    );
  }
  selectOption(value, options) {
    return call(
      'locator.selectOption',
      this.args({ value, ...timeoutOptions(options) }),
    );
  }
  check(options) {
    return call('locator.check', this.args(actionOptions(options)));
  }
  uncheck(options) {
    return call('locator.uncheck', this.args(actionOptions(options)));
  }
  setChecked(checked, options) {
    return call(
      'locator.setChecked',
      this.args({ checked: Boolean(checked), ...actionOptions(options) }),
    );
  }
  waitFor(options = {}) {
    return call(
      'locator.waitFor',
      this.args({
        state: options.state || 'visible',
        ...timeoutOptions(options),
      }),
    );
  }
  toJSON() {
    return { type: 'Locator', tabId: this.tabId, steps: this.steps.length };
  }
}

// Scopes locators to an iframe's document: the steps before the frame step
// identify the <iframe>; steps after it run inside that frame.
class FrameLocatorProxy {
  constructor(tabId, steps) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'steps', {
      value: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
      enumerable: false,
    });
  }
  inner(step) {
    return new LocatorProxy(this.tabId, [...this.steps, step]);
  }
  locator(selector, options) {
    const next = this.inner({ kind: 'locator', selector: String(selector) });
    return options ? next.filter(options) : next;
  }
  getByRole(role, options) {
    return this.inner(roleStep(role, options));
  }
  getByText(text, options) {
    return this.inner(textStep('getByText', text, options));
  }
  getByLabel(text, options) {
    return this.inner(textStep('getByLabel', text, options));
  }
  getByPlaceholder(text, options) {
    return this.inner(textStep('getByPlaceholder', text, options));
  }
  getByTestId(testId) {
    return this.inner({ kind: 'getByTestId', testId: String(testId) });
  }
  frameLocator(selector) {
    return new FrameLocatorProxy(this.tabId, [
      ...this.steps,
      frameStep(selector),
    ]);
  }
  toJSON() {
    return {
      type: 'FrameLocator',
      tabId: this.tabId,
      steps: this.steps.length,
    };
  }
}

class PlaywrightFileChooser {
  constructor(tabId, descriptor) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'chooserId', {
      value: String(descriptor.chooserId),
      enumerable: false,
    });
    Object.defineProperty(this, 'multiple', {
      value: descriptor.multiple === true,
      enumerable: false,
    });
  }
  isMultiple() {
    return this.multiple;
  }
  setFiles(files, options = {}) {
    const list = Array.isArray(files) ? files : [files];
    return call('fileChooser.setFiles', {
      tabId: this.tabId,
      chooserId: this.chooserId,
      files: list.map(String),
      ...timeoutOptions(options),
    });
  }
  toJSON() {
    return { type: 'PlaywrightFileChooser', multiple: this.multiple };
  }
}

class PlaywrightDownload {
  constructor(tabId, descriptor) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'downloadId', {
      value: String(descriptor.downloadId),
      enumerable: false,
    });
  }
  path(options = {}) {
    return call('download.path', {
      tabId: this.tabId,
      downloadId: this.downloadId,
      ...timeoutOptions(options),
    });
  }
  toJSON() {
    return { type: 'PlaywrightDownload' };
  }
}

class PlaywrightProxy {
  constructor(tabId) {
    Object.defineProperty(this, 'tabId', { value: tabId });
  }
  locator(selector, options) {
    const locator = new LocatorProxy(this.tabId, [
      { kind: 'locator', selector: String(selector) },
    ]);
    return options ? locator.filter(options) : locator;
  }
  getByRole(role, options) {
    return new LocatorProxy(this.tabId, [roleStep(role, options)]);
  }
  getByText(text, options) {
    return new LocatorProxy(this.tabId, [textStep('getByText', text, options)]);
  }
  getByLabel(text, options) {
    return new LocatorProxy(this.tabId, [
      textStep('getByLabel', text, options),
    ]);
  }
  getByPlaceholder(text, options) {
    return new LocatorProxy(this.tabId, [
      textStep('getByPlaceholder', text, options),
    ]);
  }
  getByTestId(testId) {
    return new LocatorProxy(this.tabId, [
      { kind: 'getByTestId', testId: String(testId) },
    ]);
  }
  frameLocator(selector) {
    return new FrameLocatorProxy(this.tabId, [frameStep(selector)]);
  }
  evaluate(pageFunction, arg, options) {
    return call('playwright.evaluate', {
      tabId: this.tabId,
      script: pageEvaluateScript(pageFunction, arg),
      ...timeoutOptions(options),
    });
  }
  domSnapshot(options = {}) {
    const args = { tabId: this.tabId };
    if (typeof options.filter === 'string') args.filter = options.filter;
    if (typeof options.maxChars === 'number') args.maxChars = options.maxChars;
    if (typeof options.root === 'string') args.root = options.root;
    return call('playwright.domSnapshot', args);
  }
  waitForEvent(event, options = {}) {
    const eventName = String(event);
    if (eventName !== 'download' && eventName !== 'filechooser') {
      throw new TypeError(
        'waitForEvent supports only "download" and "filechooser"',
      );
    }
    return call('playwright.waitForEvent', {
      tabId: this.tabId,
      event: eventName,
      ...timeoutOptions(options),
    }).then((descriptor) =>
      eventName === 'filechooser'
        ? new PlaywrightFileChooser(this.tabId, descriptor)
        : new PlaywrightDownload(this.tabId, descriptor),
    );
  }
  waitForURL(url, options = {}) {
    if (typeof url !== 'string')
      throw new TypeError('waitForURL expects a string');
    return call('playwright.waitForURL', {
      tabId: this.tabId,
      url,
      ...navigationOptions(options),
    });
  }
  async expectNavigation(action, options = {}) {
    if (typeof action !== 'function')
      throw new TypeError('expectNavigation expects an action function');
    const args = { tabId: this.tabId, ...timeoutOptions(options) };
    if (typeof options.url === 'string') args.url = options.url;
    if (typeof options.waitUntil === 'string')
      args.waitUntil = options.waitUntil;
    const waiterId = await call('playwright.expectNavigation.begin', args);
    let value;
    try {
      value = await action();
    } catch (error) {
      try {
        await call('playwright.expectNavigation.cancel', {
          tabId: this.tabId,
          waiterId,
        });
      } catch {
        // Preserve the original action failure when waiter cleanup also fails.
      }
      throw error;
    }
    await call('playwright.expectNavigation.wait', {
      tabId: this.tabId,
      waiterId,
    });
    return value;
  }
  waitForLoadState(options = {}) {
    const args = { tabId: this.tabId, ...timeoutOptions(options) };
    if (typeof options.state === 'string') args.state = options.state;
    return call('playwright.waitForLoadState', args);
  }
  waitForTimeout(timeoutMs) {
    return call('playwright.waitForTimeout', { tabId: this.tabId, timeoutMs });
  }
}

class CUAProxy {
  constructor(tabId) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  click(options) {
    return call('cua.click', { tabId: this.tabId, ...options });
  }
  double_click(options) {
    return call('cua.double_click', { tabId: this.tabId, ...options });
  }
  drag(options) {
    return call('cua.drag', { tabId: this.tabId, ...options });
  }
  keypress(options) {
    return call('cua.keypress', { tabId: this.tabId, ...options });
  }
  move(options) {
    return call('cua.move', { tabId: this.tabId, ...options });
  }
  scroll(options) {
    return call('cua.scroll', { tabId: this.tabId, ...options });
  }
  type(options) {
    return call('cua.type', { tabId: this.tabId, ...options });
  }
}

// DOM CUA keeps its own command identity for trusted audit/telemetry while the
// backend delegates each ref action to the matching locator primitive.
class DomCUAProxy {
  constructor(tabId) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  get_visible_dom(options = {}) {
    const args = { tabId: this.tabId };
    if (options.filter !== undefined) args.filter = options.filter;
    if (options.maxChars !== undefined) args.maxChars = options.maxChars;
    if (options.root !== undefined) args.root = options.root;
    return call('dom_cua.get_visible_dom', args);
  }
  click(options = {}) {
    const extra = {};
    if (options.button !== undefined) extra.button = options.button;
    if (Array.isArray(options.keypress))
      extra.modifiers = options.keypress.map(String);
    if (options.force === true) extra.force = true;
    return call('dom_cua.click', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      ...extra,
      ...timeoutOptions(options),
    });
  }
  double_click(options = {}) {
    const extra = {};
    if (Array.isArray(options.keypress))
      extra.modifiers = options.keypress.map(String);
    if (options.force === true) extra.force = true;
    return call('dom_cua.double_click', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      ...extra,
      ...timeoutOptions(options),
    });
  }
  hover(options = {}) {
    return call('dom_cua.hover', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      ...timeoutOptions(options),
    });
  }
  type(options = {}) {
    return call('dom_cua.type', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      text: String(options.text == null ? '' : options.text),
      ...timeoutOptions(options),
    });
  }
  keypress(options = {}) {
    const keys = Array.isArray(options.keys)
      ? options.keys.map(String)
      : [String(options.keys)];
    return call('dom_cua.keypress', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      keys,
      ...timeoutOptions(options),
    });
  }
  scroll(options = {}) {
    return call('dom_cua.scroll', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      scrollX: Number(options.scrollX || 0),
      scrollY: Number(options.scrollY || 0),
      ...timeoutOptions(options),
    });
  }
  screenshot(options = {}) {
    return screenshotCall('dom_cua.screenshot', {
      tabId: this.tabId,
      nodeId: refSteps(options.nodeId)[0].ref,
      ...timeoutOptions(options),
    });
  }
}

class DevProxy {
  constructor(tabId) {
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  logs(options = {}) {
    const args = { tabId: this.tabId };
    if (typeof options.filter === 'string') args.filter = options.filter;
    if (Array.isArray(options.levels)) args.levels = options.levels.map(String);
    if (typeof options.limit === 'number') args.limit = options.limit;
    if (options.clear === true) args.clear = true;
    return call('dev.logs', args);
  }
  network(options = {}) {
    const args = { tabId: this.tabId };
    if (typeof options.urlPattern === 'string')
      args.urlPattern = options.urlPattern;
    if (typeof options.limit === 'number') args.limit = options.limit;
    if (options.clear === true) args.clear = true;
    return call('dev.network', args);
  }
}

class TabProxy {
  constructor(browserId, info) {
    Object.defineProperty(this, 'browserId', {
      value: browserId,
      enumerable: false,
    });
    Object.defineProperty(this, 'id', { value: info.id, enumerable: true });
    Object.defineProperty(this, 'playwright', {
      value: new PlaywrightProxy(info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'cua', {
      value: new CUAProxy(info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'dom_cua', {
      value: new DomCUAProxy(info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'dev', {
      value: new DevProxy(info.id),
      enumerable: true,
    });
  }
  goto(url, options = {}) {
    return call('tab.goto', {
      tabId: this.id,
      url: String(url),
      ...navigationOptions(options),
    });
  }
  url() {
    return call('tab.url', { tabId: this.id });
  }
  title() {
    return call('tab.title', { tabId: this.id });
  }
  back(options = {}) {
    return call('tab.back', { tabId: this.id, ...navigationOptions(options) });
  }
  forward(options = {}) {
    return call('tab.forward', {
      tabId: this.id,
      ...navigationOptions(options),
    });
  }
  reload(options = {}) {
    return call('tab.reload', {
      tabId: this.id,
      ...navigationOptions(options),
    });
  }
  close() {
    return call('tab.close', { tabId: this.id });
  }
  screenshot(options = {}) {
    return screenshotCall('tab.screenshot', { tabId: this.id, ...options });
  }
  async getJsDialog() {
    const info = await call('tab.getJsDialog', { tabId: this.id });
    if (info == null) return undefined;
    const tabId = this.id;
    return Object.freeze({
      type: info.type,
      message: info.message,
      defaultValue: info.defaultPrompt,
      accept(promptText) {
        return call(
          'tab.dialog.accept',
          promptText === undefined
            ? { tabId }
            : { tabId, promptText: String(promptText) },
        );
      },
      dismiss() {
        return call('tab.dialog.dismiss', { tabId });
      },
    });
  }
  toJSON() {
    return { type: 'Tab', id: this.id };
  }
}

class TabsProxy {
  constructor(browserId) {
    Object.defineProperty(this, 'browserId', { value: browserId });
  }
  async new() {
    return new TabProxy(
      this.browserId,
      await call('tabs.new', { browserId: this.browserId }),
    );
  }
  list() {
    return call('tabs.list', { browserId: this.browserId });
  }
  async get(tabId) {
    return new TabProxy(
      this.browserId,
      await call('tabs.get', { browserId: this.browserId, tabId }),
    );
  }
  async selected() {
    const info = await call('tabs.selected', { browserId: this.browserId });
    return info == null ? undefined : new TabProxy(this.browserId, info);
  }
}

class BrowserUserProxy {
  constructor(browserId) {
    Object.defineProperty(this, 'browserId', { value: browserId });
  }
  openTabs() {
    return call('browser.user.openTabs', { browserId: this.browserId });
  }
  async claimTab(tab) {
    if (typeof tab !== 'string' && (!tab || typeof tab !== 'object')) {
      throw new TypeError(
        'claimTab expects a tab returned by browser.user.openTabs()',
      );
    }
    return new TabProxy(
      this.browserId,
      await call('browser.user.claimTab', {
        browserId: this.browserId,
        tab,
      }),
    );
  }
  history(options) {
    return call('browser.user.history', {
      browserId: this.browserId,
      ...(options === undefined ? {} : { options }),
    });
  }
}

class BrowserProxy {
  constructor(info) {
    Object.defineProperty(this, 'browserId', {
      value: info.id,
      enumerable: true,
    });
    Object.defineProperty(this, 'tabs', {
      value: new TabsProxy(info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'user', {
      value: new BrowserUserProxy(info.id),
      enumerable: true,
    });
  }
  documentation() {
    return call('browser.documentation', { browserId: this.browserId });
  }
  nameSession(name) {
    return call('browser.nameSession', {
      browserId: this.browserId,
      name: String(name),
    });
  }
  toJSON() {
    return { type: 'Browser', browserId: this.browserId };
  }
}

class BrowsersProxy {
  list() {
    return call('browsers.list', {});
  }
  async get(id) {
    return new BrowserProxy(await call('browsers.get', { id: String(id) }));
  }
}

class AgentProxy {
  constructor() {
    Object.defineProperty(this, 'browsers', {
      value: new BrowsersProxy(),
      enumerable: true,
    });
  }
  toJSON() {
    return { type: 'Agent' };
  }
}

let singletonAgent;
export async function setupBrowserRuntime(runtime) {
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    typeof runtime.emitImage !== 'function'
  ) {
    throw new TypeError(
      'setupBrowserRuntime requires the Qwen nodeRepl object',
    );
  }
  if (nodeReplRuntime && nodeReplRuntime !== runtime) {
    throw new Error(
      'Browser SDK is already bound to another Node REPL runtime',
    );
  }
  nodeReplRuntime = runtime;
  backendPromise ??= createBrowserBackend();
  const pending = backendPromise;
  try {
    await pending;
  } catch (error) {
    if (backendPromise === pending) {
      backendPromise = undefined;
      nodeReplRuntime = undefined;
    }
    throw error;
  }
  if (!singletonAgent) singletonAgent = new AgentProxy();
  return singletonAgent;
}

export async function closeBrowserRuntime() {
  const pending = backendPromise;
  backendPromise = undefined;
  singletonAgent = undefined;
  nodeReplRuntime = undefined;
  const backend = await pending;
  await backend?.close();
}
