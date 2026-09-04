/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LogEntry, TabInfo } from '../core/primitives.js';
import type { BrowserSdkContext } from './context.js';
import {
  FrameLocatorProxy,
  LocatorProxy,
  frameStep,
  navigationOptions,
  pageEvaluateScript,
  snapshotRef,
  roleStep,
  textStep,
  timeoutOptions,
} from './locator.js';
import type {
  BrowserCUA,
  BrowserDev,
  BrowserDialog,
  BrowserDomCUA,
  BrowserDownload,
  BrowserFileChooser,
  BrowserFrameLocator,
  BrowserLocator,
  BrowserPlaywright,
  BrowserTab,
  LoadStateOptions,
  LocatorRoleOptions,
  LocatorTextOptions,
  NavigationExpectationOptions,
  PageWaitForURLOptions,
  TabScreenshotOptions,
  TimeoutOptions,
} from './types.js';

type Args = Record<string, unknown>;

class PlaywrightFileChooser implements BrowserFileChooser {
  declare readonly tabId: string;
  declare readonly chooserId: string;
  declare readonly multiple: boolean;
  declare private readonly context: BrowserSdkContext;

  constructor(
    context: BrowserSdkContext,
    tabId: string,
    descriptor: { chooserId: string; multiple: boolean },
  ) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
    Object.defineProperty(this, 'chooserId', {
      value: descriptor.chooserId,
      enumerable: false,
    });
    Object.defineProperty(this, 'multiple', {
      value: descriptor.multiple === true,
      enumerable: false,
    });
  }
  isMultiple(): boolean {
    return this.multiple;
  }
  setFiles(
    files: string | readonly string[],
    options: TimeoutOptions = {},
  ): Promise<void> {
    const list = Array.isArray(files) ? files : [files];
    return this.context.call<void>('fileChooser.setFiles', {
      tabId: this.tabId,
      chooserId: this.chooserId,
      files: list,
      ...timeoutOptions(options),
    });
  }
  toJSON(): Args {
    return { type: 'PlaywrightFileChooser', multiple: this.multiple };
  }
}

class PlaywrightProxy implements BrowserPlaywright {
  declare readonly tabId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, tabId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId });
  }
  locator(selector: string): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      { kind: 'locator', selector },
    ]);
  }
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      roleStep(role, options),
    ]);
  }
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      textStep('getByText', text, options),
    ]);
  }
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      textStep('getByLabel', text, options),
    ]);
  }
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      textStep('getByPlaceholder', text, options),
    ]);
  }
  getByTestId(testId: string): BrowserLocator {
    return new LocatorProxy(this.context, this.tabId, [
      { kind: 'getByTestId', testId },
    ]);
  }
  frameLocator(selector: string): BrowserFrameLocator {
    return new FrameLocatorProxy(this.context, this.tabId, [
      frameStep(selector),
    ]);
  }
  evaluate<Result = unknown, Arg = unknown>(
    pageFunction: string | ((arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result> {
    return this.context.call<Result>('playwright.evaluate', {
      tabId: this.tabId,
      script: pageEvaluateScript(pageFunction, arg),
      ...timeoutOptions(options),
    });
  }
  domSnapshot(): Promise<string> {
    return this.context.call<string>('playwright.domSnapshot', {
      tabId: this.tabId,
    });
  }
  waitForEvent(
    event: 'download',
    options?: TimeoutOptions,
  ): Promise<BrowserDownload>;
  waitForEvent(
    event: 'filechooser',
    options?: TimeoutOptions,
  ): Promise<BrowserFileChooser>;
  waitForEvent(
    event: 'download' | 'filechooser',
    options: TimeoutOptions = {},
  ): Promise<BrowserDownload | BrowserFileChooser> {
    if (event !== 'download' && event !== 'filechooser') {
      throw new TypeError(
        'waitForEvent supports only "download" and "filechooser"',
      );
    }
    const args = {
      tabId: this.tabId,
      event,
      ...timeoutOptions(options),
    };
    if (event === 'filechooser') {
      return this.context
        .call<{
          chooserId: string;
          multiple: boolean;
        }>('playwright.waitForEvent', args)
        .then(
          (descriptor) =>
            new PlaywrightFileChooser(this.context, this.tabId, descriptor),
        );
    }
    return this.context.call<BrowserDownload>('playwright.waitForEvent', args);
  }
  waitForURL(url: string, options: PageWaitForURLOptions = {}): Promise<void> {
    if (typeof url !== 'string')
      throw new TypeError('waitForURL expects a string');
    return this.context.call<void>('playwright.waitForURL', {
      tabId: this.tabId,
      url,
      ...navigationOptions(options),
    });
  }
  async expectNavigation<Result>(
    action: () => Result | Promise<Result>,
    options: NavigationExpectationOptions = {},
  ): Promise<Awaited<Result>> {
    if (typeof action !== 'function')
      throw new TypeError('expectNavigation expects an action function');
    const args: Args = {
      tabId: this.tabId,
      ...navigationOptions(options),
    };
    if (options.url !== undefined) args.url = options.url;
    const waiterId = await this.context.call<string>(
      'playwright.expectNavigation.begin',
      args,
    );
    let value: Awaited<Result>;
    try {
      value = await action();
    } catch (error) {
      try {
        await this.context.call<void>('playwright.expectNavigation.cancel', {
          tabId: this.tabId,
          waiterId,
        });
      } catch {
        // Preserve the original action failure when waiter cleanup also fails.
      }
      throw error;
    }
    await this.context.call<void>('playwright.expectNavigation.wait', {
      tabId: this.tabId,
      waiterId,
    });
    return value;
  }
  waitForLoadState(options: LoadStateOptions = {}): Promise<void> {
    const args: Args = { tabId: this.tabId, ...timeoutOptions(options) };
    if (options.state !== undefined) args.state = options.state;
    return this.context.call<void>('playwright.waitForLoadState', args);
  }
  waitForTimeout(timeoutMs: number): Promise<void> {
    return this.context.call<void>('playwright.waitForTimeout', {
      tabId: this.tabId,
      timeoutMs,
    });
  }
}

class CUAProxy implements BrowserCUA {
  declare readonly tabId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, tabId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  click(options: Parameters<BrowserCUA['click']>[0]): Promise<void> {
    return this.context.call<void>('cua.click', {
      tabId: this.tabId,
      ...options,
    });
  }
  double_click(
    options: Parameters<BrowserCUA['double_click']>[0],
  ): Promise<void> {
    return this.context.call<void>('cua.double_click', {
      tabId: this.tabId,
      ...options,
    });
  }
  drag(options: Parameters<BrowserCUA['drag']>[0]): Promise<void> {
    return this.context.call<void>('cua.drag', {
      tabId: this.tabId,
      ...options,
    });
  }
  keypress(options: Parameters<BrowserCUA['keypress']>[0]): Promise<void> {
    return this.context.call<void>('cua.keypress', {
      tabId: this.tabId,
      ...options,
    });
  }
  move(options: Parameters<BrowserCUA['move']>[0]): Promise<void> {
    return this.context.call<void>('cua.move', {
      tabId: this.tabId,
      ...options,
    });
  }
  scroll(options: Parameters<BrowserCUA['scroll']>[0]): Promise<void> {
    return this.context.call<void>('cua.scroll', {
      tabId: this.tabId,
      ...options,
    });
  }
  type(options: Parameters<BrowserCUA['type']>[0]): Promise<void> {
    return this.context.call<void>('cua.type', {
      tabId: this.tabId,
      ...options,
    });
  }
}

// DOM CUA keeps its own command identity while the backend delegates each ref
// action to the matching locator primitive.
class DomCUAProxy implements BrowserDomCUA {
  declare readonly tabId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, tabId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  get_visible_dom(): Promise<unknown> {
    return this.context.call<unknown>('dom_cua.get_visible_dom', {
      tabId: this.tabId,
    });
  }
  click(options: Parameters<BrowserDomCUA['click']>[0]): Promise<void> {
    return this.context.call<void>('dom_cua.click', {
      tabId: this.tabId,
      node_id: snapshotRef(options.node_id),
    });
  }
  double_click(
    options: Parameters<BrowserDomCUA['double_click']>[0],
  ): Promise<void> {
    return this.context.call<void>('dom_cua.double_click', {
      tabId: this.tabId,
      node_id: snapshotRef(options.node_id),
    });
  }
  type(options: Parameters<BrowserDomCUA['type']>[0]): Promise<void> {
    return this.context.call<void>('dom_cua.type', {
      tabId: this.tabId,
      text: options.text,
    });
  }
  keypress(options: Parameters<BrowserDomCUA['keypress']>[0]): Promise<void> {
    return this.context.call<void>('dom_cua.keypress', {
      tabId: this.tabId,
      keys: options.keys,
    });
  }
  scroll(options: Parameters<BrowserDomCUA['scroll']>[0]): Promise<void> {
    return this.context.call<void>('dom_cua.scroll', {
      tabId: this.tabId,
      ...(options.node_id === undefined
        ? {}
        : { node_id: snapshotRef(options.node_id) }),
      x: options.x,
      y: options.y,
    });
  }
}

class DevProxy implements BrowserDev {
  declare readonly tabId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, tabId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'tabId', { value: tabId, enumerable: false });
  }
  logs(options: Parameters<BrowserDev['logs']>[0] = {}): Promise<LogEntry[]> {
    const args: Args = { tabId: this.tabId };
    if (options.filter !== undefined) args.filter = options.filter;
    if (options.levels !== undefined) args.levels = options.levels;
    if (options.limit !== undefined) args.limit = options.limit;
    return this.context.call<LogEntry[]>('dev.logs', args);
  }
}

export class TabProxy implements BrowserTab {
  declare readonly browserId: string;
  declare readonly id: string;
  declare readonly playwright: BrowserPlaywright;
  declare readonly cua: BrowserCUA;
  declare readonly dom_cua: BrowserDomCUA;
  declare readonly dev: BrowserDev;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, browserId: string, info: TabInfo) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'browserId', {
      value: browserId,
      enumerable: false,
    });
    Object.defineProperty(this, 'id', { value: info.id, enumerable: true });
    Object.defineProperty(this, 'playwright', {
      value: new PlaywrightProxy(context, info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'cua', {
      value: new CUAProxy(context, info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'dom_cua', {
      value: new DomCUAProxy(context, info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'dev', {
      value: new DevProxy(context, info.id),
      enumerable: true,
    });
  }
  goto(url: string): Promise<void> {
    return this.context.call<void>('tab.goto', {
      tabId: this.id,
      url,
    });
  }
  url(): Promise<string | null> {
    return this.context.call<string | null>('tab.url', { tabId: this.id });
  }
  title(): Promise<string | null> {
    return this.context.call<string | null>('tab.title', { tabId: this.id });
  }
  back(): Promise<void> {
    return this.context.call<void>('tab.back', { tabId: this.id });
  }
  forward(): Promise<void> {
    return this.context.call<void>('tab.forward', { tabId: this.id });
  }
  reload(): Promise<void> {
    return this.context.call<void>('tab.reload', { tabId: this.id });
  }
  close(): Promise<void> {
    return this.context.call<void>('tab.close', { tabId: this.id });
  }
  screenshot(options: TabScreenshotOptions = {}): Promise<Uint8Array> {
    return this.context.screenshotCall('tab.screenshot', {
      tabId: this.id,
      ...options,
    });
  }
  async getJsDialog(): Promise<BrowserDialog | undefined> {
    const info = await this.context.call<{
      type: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
      message: string;
      defaultPrompt: string;
    } | null>('tab.getJsDialog', { tabId: this.id });
    if (info == null) return undefined;
    const tabId = this.id;
    const context = this.context;
    const dismiss = (): Promise<void> =>
      context.call<void>('tab.dialog.dismiss', { tabId });
    const base = {
      type: info.type,
      message: info.message,
      dismiss,
    };
    if (info.type === 'confirm') {
      return Object.freeze({
        ...base,
        type: info.type,
        accept: (): Promise<void> =>
          context.call<void>('tab.dialog.accept', { tabId }),
      });
    }
    if (info.type === 'prompt') {
      return Object.freeze({
        ...base,
        type: info.type,
        defaultValue: info.defaultPrompt,
        accept: (text: string): Promise<void> => {
          if (typeof text !== 'string')
            throw new TypeError('Prompt dialog accept expects text');
          return context.call<void>('tab.dialog.accept', {
            tabId,
            promptText: text,
          });
        },
      });
    }
    return Object.freeze({ ...base, type: info.type });
  }
  toJSON(): Args {
    return { type: 'Tab', id: this.id };
  }
}
