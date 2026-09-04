/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { types as utilTypes } from 'node:util';

import {
  SNAPSHOT_REF_PATTERN,
  type BrowserSelectOption,
  type LocatorMatcher,
  type LocatorStep,
} from '../core/primitives.js';
import type { BrowserSdkContext } from './context.js';
import type {
  BrowserFrameLocator,
  BrowserLocator,
  LocatorCheckOptions,
  LocatorClickOptions,
  LocatorFilterOptions,
  LocatorLocatorOptions,
  LocatorRoleOptions,
  LocatorTextOptions,
  LocatorWaitOptions,
  PageWaitForURLOptions,
  TimeoutOptions,
} from './types.js';

type Args = Record<string, unknown>;

function optionRecord(value: unknown, label: string): Args {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Args;
}

function matcher(value: unknown): LocatorMatcher {
  if (utilTypes.isRegExp(value))
    return { regex: value.source, flags: value.flags };
  if (typeof value !== 'string')
    throw new TypeError('Text matcher must be a string or RegExp');
  return value;
}

export function timeoutOptions(options?: TimeoutOptions): Args {
  const value = optionRecord(options, 'options');
  return value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs };
}

export function navigationOptions(options?: PageWaitForURLOptions): Args {
  const value = optionRecord(options, 'navigation options');
  const result: Args = timeoutOptions(options);
  if (value.waitUntil !== undefined) result.waitUntil = value.waitUntil;
  return result;
}

function actionOptions(options?: LocatorCheckOptions): Args {
  const value = optionRecord(options, 'action options');
  const result = timeoutOptions(options);
  if (value.force !== undefined) result.force = value.force;
  return result;
}

function evaluateArg(value: unknown): string {
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

export function pageEvaluateScript(
  pageFunction: unknown,
  arg: unknown,
): string {
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

function locatorEvaluateScript(
  pageFunction: unknown,
  arg: unknown,
  mode: 'one' | 'all',
): string {
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

function clickOptions(options?: LocatorClickOptions): Args {
  const value = optionRecord(options, 'click options');
  const result: Args = { ...timeoutOptions(options) };
  if (value.button !== undefined) result.button = value.button;
  if (value.modifiers !== undefined) result.modifiers = value.modifiers;
  if (value.force !== undefined) result.force = value.force;
  return result;
}

export function snapshotRef(nodeId: string): string {
  if (typeof nodeId !== 'string')
    throw new TypeError('node_id must be a string');
  const ref = nodeId.trim();
  if (!SNAPSHOT_REF_PATTERN.test(ref))
    throw new TypeError(
      'node_id must be a Playwright snapshot ref such as "e12" or "f1e3" inside a frame',
    );
  return ref;
}

export function frameStep(selector: string): LocatorStep {
  return { kind: 'frame', selector };
}

export function textStep(
  kind: 'getByText' | 'getByLabel' | 'getByPlaceholder',
  text: string | RegExp,
  options?: LocatorTextOptions,
): LocatorStep {
  optionRecord(options, 'text locator options');
  const step: Extract<LocatorStep, { kind: typeof kind }> = {
    kind,
    text: matcher(text),
  };
  if (options?.exact !== undefined) step.exact = options.exact;
  return step;
}

export function roleStep(
  role: string,
  options?: LocatorRoleOptions,
): LocatorStep {
  optionRecord(options, 'role locator options');
  const step: Extract<LocatorStep, { kind: 'getByRole' }> = {
    kind: 'getByRole',
    role,
  };
  if (options && options.name !== undefined) step.name = matcher(options.name);
  if (options?.exact !== undefined) step.exact = options.exact;
  return step;
}

export class LocatorProxy implements BrowserLocator {
  declare readonly tabId: string;
  declare readonly steps: readonly LocatorStep[];
  declare private readonly context: BrowserSdkContext;

  constructor(
    context: BrowserSdkContext,
    tabId: string,
    steps: readonly LocatorStep[],
  ) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'steps', {
      value: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
      enumerable: false,
    });
  }

  private append(step: LocatorStep): LocatorProxy {
    return new LocatorProxy(this.context, this.tabId, [...this.steps, step]);
  }
  locator(selector: string, options?: LocatorLocatorOptions): BrowserLocator {
    const next = this.append({ kind: 'locator', selector });
    return options === undefined ? next : next.filter(options);
  }
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator {
    return this.append(roleStep(role, options));
  }
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.append(textStep('getByText', text, options));
  }
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.append(textStep('getByLabel', text, options));
  }
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.append(textStep('getByPlaceholder', text, options));
  }
  getByTestId(testId: string): BrowserLocator {
    return this.append({ kind: 'getByTestId', testId });
  }
  first(): BrowserLocator {
    return this.append({ kind: 'first' });
  }
  last(): BrowserLocator {
    return this.append({ kind: 'last' });
  }
  nth(index: number): BrowserLocator {
    if (!Number.isInteger(index))
      throw new TypeError('nth index must be an integer');
    return this.append({ kind: 'nth', index });
  }
  filter(options: LocatorFilterOptions = {}): BrowserLocator {
    optionRecord(options, 'filter options');
    const step: Extract<LocatorStep, { kind: 'filter' }> = { kind: 'filter' };
    if (options.hasText !== undefined) step.hasText = matcher(options.hasText);
    if (options.hasNotText !== undefined)
      step.hasNotText = matcher(options.hasNotText);
    if (options.visible !== undefined) step.visible = options.visible;
    if (options.has !== undefined) {
      if (!(options.has instanceof LocatorProxy))
        throw new TypeError('filter has expects a Locator');
      step.has = [...options.has.steps];
    }
    if (options.hasNot !== undefined) {
      if (!(options.hasNot instanceof LocatorProxy))
        throw new TypeError('filter hasNot expects a Locator');
      step.hasNot = [...options.hasNot.steps];
    }
    return this.append(step);
  }
  and(other: BrowserLocator): BrowserLocator {
    if (!(other instanceof LocatorProxy))
      throw new TypeError('and expects a Locator');
    return this.append({ kind: 'and', steps: [...other.steps] });
  }
  or(other: BrowserLocator): BrowserLocator {
    if (!(other instanceof LocatorProxy))
      throw new TypeError('or expects a Locator');
    return this.append({ kind: 'or', steps: [...other.steps] });
  }
  async all(): Promise<BrowserLocator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_, index) => this.nth(index));
  }

  private args(extra: object = {}): Args {
    return { tabId: this.tabId, steps: this.steps, ...extra };
  }
  count(): Promise<number> {
    return this.context.call<number>('locator.count', this.args());
  }
  evaluate<Result = unknown, Arg = unknown>(
    pageFunction:
      | string
      | ((element: Element, arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result> {
    return this.context.call<Result>(
      'locator.evaluate',
      this.args({
        script: locatorEvaluateScript(pageFunction, arg, 'one'),
        ...timeoutOptions(options),
      }),
    );
  }
  evaluateAll<Result = unknown, Arg = unknown>(
    pageFunction:
      | string
      | ((elements: Element[], arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result> {
    return this.context.call<Result>(
      'locator.evaluateAll',
      this.args({
        script: locatorEvaluateScript(pageFunction, arg, 'all'),
        ...timeoutOptions(options),
      }),
    );
  }
  allTextContents(options?: TimeoutOptions): Promise<string[]> {
    return this.context.call<string[]>(
      'locator.allTextContents',
      this.args(timeoutOptions(options)),
    );
  }
  innerText(options?: TimeoutOptions): Promise<string> {
    return this.context.call<string>(
      'locator.innerText',
      this.args(timeoutOptions(options)),
    );
  }
  textContent(options?: TimeoutOptions): Promise<string | null> {
    return this.context.call<string | null>(
      'locator.textContent',
      this.args(timeoutOptions(options)),
    );
  }
  getAttribute(name: string, options?: TimeoutOptions): Promise<string | null> {
    return this.context.call<string | null>(
      'locator.getAttribute',
      this.args({ name, ...timeoutOptions(options) }),
    );
  }
  isEnabled(): Promise<boolean> {
    return this.context.call<boolean>('locator.isEnabled', this.args());
  }
  isVisible(): Promise<boolean> {
    return this.context.call<boolean>('locator.isVisible', this.args());
  }
  click(options?: LocatorClickOptions): Promise<void> {
    return this.context.call<void>(
      'locator.click',
      this.args(clickOptions(options)),
    );
  }
  dblclick(options?: LocatorClickOptions): Promise<void> {
    return this.context.call<void>(
      'locator.dblclick',
      this.args(clickOptions(options)),
    );
  }
  downloadMedia(options: TimeoutOptions = {}): Promise<void> {
    return this.context.call<void>(
      'locator.downloadMedia',
      this.args(timeoutOptions(options)),
    );
  }
  fill(value: string, options?: TimeoutOptions): Promise<void> {
    return this.context.call<void>(
      'locator.fill',
      this.args({ value, ...timeoutOptions(options) }),
    );
  }
  type(value: string, options?: TimeoutOptions): Promise<void> {
    return this.context.call<void>(
      'locator.type',
      this.args({ value, ...timeoutOptions(options) }),
    );
  }
  press(value: string, options?: TimeoutOptions): Promise<void> {
    return this.context.call<void>(
      'locator.press',
      this.args({ value, ...timeoutOptions(options) }),
    );
  }
  selectOption(
    value: BrowserSelectOption | readonly BrowserSelectOption[],
    options?: TimeoutOptions,
  ): Promise<void> {
    return this.context.call<void>(
      'locator.selectOption',
      this.args({ value, ...timeoutOptions(options) }),
    );
  }
  check(options?: LocatorCheckOptions): Promise<void> {
    return this.context.call<void>(
      'locator.check',
      this.args(actionOptions(options)),
    );
  }
  uncheck(options?: LocatorCheckOptions): Promise<void> {
    return this.context.call<void>(
      'locator.uncheck',
      this.args(actionOptions(options)),
    );
  }
  setChecked(checked: boolean, options?: LocatorCheckOptions): Promise<void> {
    return this.context.call<void>(
      'locator.setChecked',
      this.args({ checked, ...actionOptions(options) }),
    );
  }
  waitFor(options: LocatorWaitOptions): Promise<void> {
    return this.context.call<void>(
      'locator.waitFor',
      this.args({
        state: options.state,
        ...timeoutOptions(options),
      }),
    );
  }
  toJSON(): Args {
    return { type: 'Locator', tabId: this.tabId, steps: this.steps.length };
  }
}

// Scopes locators to an iframe's document: the steps before the frame step
// identify the <iframe>; steps after it run inside that frame.
export class FrameLocatorProxy implements BrowserFrameLocator {
  declare readonly tabId: string;
  declare readonly steps: readonly LocatorStep[];
  declare private readonly context: BrowserSdkContext;

  constructor(
    context: BrowserSdkContext,
    tabId: string,
    steps: readonly LocatorStep[],
  ) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'steps', {
      value: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
      enumerable: false,
    });
  }
  private inner(step: LocatorStep): LocatorProxy {
    return new LocatorProxy(this.context, this.tabId, [...this.steps, step]);
  }
  locator(selector: string): BrowserLocator {
    return this.inner({ kind: 'locator', selector });
  }
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator {
    return this.inner(roleStep(role, options));
  }
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.inner(textStep('getByText', text, options));
  }
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.inner(textStep('getByLabel', text, options));
  }
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return this.inner(textStep('getByPlaceholder', text, options));
  }
  getByTestId(testId: string): BrowserLocator {
    return this.inner({ kind: 'getByTestId', testId });
  }
  frameLocator(selector: string): BrowserFrameLocator {
    return new FrameLocatorProxy(this.context, this.tabId, [
      ...this.steps,
      frameStep(selector),
    ]);
  }
  toJSON(): Args {
    return {
      type: 'FrameLocator',
      tabId: this.tabId,
      steps: this.steps.length,
    };
  }
}
