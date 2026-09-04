/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { Dialog } from 'playwright-core';
import { ZodError } from 'zod';

import {
  ChromeExtensionTransport,
  type ChromeBridge,
  type ChromeExtensionTransportOptions,
} from '../bridge/index.js';
import { DEFAULT_CHROME_DOCUMENTATION } from '../core/chrome-runtime-documentation.js';
import {
  BrowserRuntimeError,
  invalidArguments,
  sanitizeOperationError,
  staleSessionError,
} from '../core/errors.js';
import type {
  BrowserHistoryEntry,
  BrowserInfo,
  DispatchResult,
  LogEntry,
} from '../core/primitives.js';
import { commandSchemas, type SupportedCommand } from '../core/schemas.js';
import {
  executeCuaOperation,
  executeDomCuaOperation,
} from './input-operations.js';
import {
  evaluateScript,
  executeLocatorOperation,
} from './locator-operations.js';
import {
  isoTimestamp,
  jsonResult,
  loadState,
  navigationOptions,
  numberArg,
  record,
  stringArg,
  stringArray,
  timeoutArg,
  timeoutOption,
} from './runtime-helpers.js';
import type { Args, TabState } from './runtime-state.js';
import { captureTabScreenshot } from './screenshot.js';
import { PlaywrightSession } from './playwright-session.js';
import { snapshotTab } from './snapshot.js';

const BROWSER_ID = 'chrome';
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_TAB_RESOURCES = 100;
const LOCATOR_INPUT_METHODS: ReadonlySet<SupportedCommand> = new Set([
  'locator.click',
  'locator.dblclick',
  'locator.downloadMedia',
  'locator.fill',
  'locator.type',
  'locator.press',
  'locator.selectOption',
  'locator.check',
  'locator.uncheck',
  'locator.setChecked',
]);

export interface PlaywrightRuntimeOptions
  extends ChromeExtensionTransportOptions {
  documentation?: string;
  bridge?: ChromeBridge;
}

export class PlaywrightRuntime {
  readonly browserId = BROWSER_ID;

  private readonly bridge: ChromeBridge;
  private readonly documentationText: string;
  private readonly session: PlaywrightSession;
  private sessionName: string | undefined;

  constructor(options: PlaywrightRuntimeOptions = {}) {
    this.bridge = options.bridge ?? new ChromeExtensionTransport(options);
    this.documentationText =
      options.documentation ?? DEFAULT_CHROME_DOCUMENTATION;
    this.session = new PlaywrightSession({ bridge: this.bridge });
  }

  async start(): Promise<void> {
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session.stop();
  }

  async dispatch(method: string, input: unknown): Promise<DispatchResult> {
    const schema = commandSchemas[method as SupportedCommand];
    if (schema === undefined)
      throw new BrowserRuntimeError(
        'UNKNOWN_METHOD',
        `Unknown browser method: ${method}`,
      );
    let args: Args;
    try {
      args = schema.parse(input) as Args;
    } catch (error) {
      if (error instanceof ZodError) throw invalidArguments(method, error);
      throw error;
    }
    let tab: TabState | undefined;
    try {
      if (
        typeof args.tabId === 'string' &&
        this.session.isSessionStale(args.tabId)
      )
        throw staleSessionError();
      await this.start();
      tab =
        typeof args.tabId === 'string'
          ? this.session.claimed(args.tabId)
          : undefined;
      if (tab !== undefined) assertDialogAllows(method, tab);
      const result = await this.execute(method as SupportedCommand, args);
      return result;
    } catch (error) {
      if (tab?.stale === 'session') throw staleSessionError();
      throw sanitizeOperationError(method, error);
    }
  }

  private async execute(
    method: SupportedCommand,
    args: Args,
  ): Promise<DispatchResult> {
    switch (method) {
      case 'browsers.list':
        try {
          await this.bridge.request('ping', {}, 1_500);
          return [this.browserInfo()];
        } catch (error) {
          if (
            error instanceof BrowserRuntimeError &&
            error.code === 'BROWSER_DISCONNECTED'
          )
            return [];
          throw error;
        }
      case 'browsers.get':
        this.assertBrowserSelector(stringArg(args, 'id'));
        await this.bridge.request('ping');
        return this.browserInfo();
      case 'browser.documentation':
        this.assertBrowser(stringArg(args, 'browserId'));
        return this.documentation();
      case 'browser.nameSession': {
        this.assertBrowser(stringArg(args, 'browserId'));
        const name = stringArg(args, 'name');
        await this.bridge.request('session.name', { name });
        this.sessionName = name;
        return null;
      }
      case 'browser.user.openTabs':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.openTabs();
      case 'browser.user.claimTab':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.claimTab(args.tab);
      case 'browser.user.history':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.history(args.options);
      case 'tabs.new':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.newTab();
      case 'tabs.list':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.listTabs();
      case 'tabs.get':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.getTabInfo(stringArg(args, 'tabId'));
      case 'tabs.selected':
        this.assertBrowser(stringArg(args, 'browserId'));
        return await this.session.selectedTabInfo();
      case 'tab.goto': {
        const tab = this.tab(args);
        const url = stringArg(args, 'url');
        await tab.page.goto(url);
        return null;
      }
      case 'tab.url':
        return this.tab(args).page.url();
      case 'tab.title':
        return await this.tab(args).page.title();
      case 'tab.back':
        await this.tab(args).page.goBack();
        return null;
      case 'tab.forward':
        await this.tab(args).page.goForward();
        return null;
      case 'tab.reload':
        await this.tab(args).page.reload();
        return null;
      case 'tab.close':
        await this.session.closeTab(this.tab(args));
        return null;
      case 'tab.screenshot':
        return await captureTabScreenshot(this.tab(args), args);
      case 'tab.getJsDialog': {
        const dialog = this.tab(args).dialog;
        return dialog === undefined
          ? null
          : {
              type: dialog.type(),
              message: dialog.message(),
              defaultPrompt: dialog.defaultValue(),
            };
      }
      case 'tab.dialog.accept': {
        const tab = this.tab(args);
        const dialog = this.requireDialog(tab);
        await dialog.accept(
          typeof args.promptText === 'string' ? args.promptText : undefined,
        );
        tab.dialog = undefined;
        return null;
      }
      case 'tab.dialog.dismiss': {
        const tab = this.tab(args);
        await this.requireDialog(tab).dismiss();
        tab.dialog = undefined;
        return null;
      }
      case 'dev.logs':
        return jsonResult(this.readLogs(this.tab(args), args));
      case 'playwright.domSnapshot':
        return await snapshotTab(this.tab(args));
      case 'playwright.evaluate':
        return jsonResult(
          await evaluateScript(
            this.tab(args).page,
            stringArg(args, 'script'),
            timeoutArg(args),
          ),
        );
      case 'playwright.waitForEvent':
        return await this.waitForEvent(this.tab(args), args);
      case 'fileChooser.setFiles':
        await this.setChooserFiles(this.tab(args), args);
        return null;
      case 'playwright.waitForURL':
        await this.tab(args).page.waitForURL(
          stringArg(args, 'url'),
          navigationOptions(args),
        );
        return null;
      case 'playwright.expectNavigation.begin':
        return this.beginNavigationWait(this.tab(args), args);
      case 'playwright.expectNavigation.wait':
        await this.finishNavigationWait(this.tab(args), args);
        return null;
      case 'playwright.expectNavigation.cancel':
        this.tab(args).navigationWaiters.delete(stringArg(args, 'waiterId'));
        return null;
      case 'playwright.waitForLoadState':
        await this.tab(args).page.waitForLoadState(
          loadState(args.state),
          timeoutOption(args),
        );
        return null;
      case 'playwright.waitForTimeout':
        await this.tab(args).page.waitForTimeout(numberArg(args, 'timeoutMs'));
        return null;
      default:
        if (method.startsWith('locator.')) {
          const tab = this.tab(args);
          return LOCATOR_INPUT_METHODS.has(method)
            ? await this.executeInput(tab, async () =>
                executeLocatorOperation(method, args, tab),
              )
            : await executeLocatorOperation(method, args, tab);
        }
        if (method.startsWith('dom_cua.')) {
          const tab = this.tab(args);
          return method === 'dom_cua.get_visible_dom'
            ? await executeDomCuaOperation(method, args, tab)
            : await this.executeInput(tab, async () =>
                executeDomCuaOperation(method, args, tab),
              );
        }
        if (method.startsWith('cua.')) {
          const tab = this.tab(args);
          return await this.executeInput(tab, async () =>
            executeCuaOperation(method, args, tab),
          );
        }
        throw new BrowserRuntimeError(
          'UNKNOWN_METHOD',
          `Unknown browser method: ${method}`,
        );
    }
  }

  private async executeInput(
    tab: TabState,
    action: () => Promise<DispatchResult>,
  ): Promise<DispatchResult> {
    await tab.page.bringToFront();
    const result = await action();
    if (tab.dialog !== undefined || tab.page.isClosed()) return result;
    try {
      await tab.page.evaluate(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      );
    } catch (error) {
      if (tab.dialog === undefined && !tab.page.isClosed()) throw error;
    }
    return result;
  }

  private async history(value: unknown): Promise<BrowserHistoryEntry[]> {
    const options = record(value);
    const entries = await this.bridge.request('history.query', {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.queries === undefined ? {} : { queries: options.queries }),
      ...(options.from === undefined
        ? {}
        : { from: isoTimestamp(options.from) }),
      ...(options.to === undefined ? {} : { to: isoTimestamp(options.to) }),
    });
    if (!Array.isArray(entries))
      throw new BrowserRuntimeError(
        'OPERATION_FAILED',
        'Chrome extension returned an invalid history list',
      );
    return entries.map((entry) => {
      const item = record(entry);
      return {
        url: typeof item.url === 'string' ? item.url : '',
        title: typeof item.title === 'string' ? item.title : null,
        dateVisited:
          typeof item.dateVisited === 'string' ? item.dateVisited : '',
      };
    });
  }

  private readLogs(tab: TabState, args: Args): LogEntry[] {
    const levels = Array.isArray(args.levels)
      ? new Set(
          args.levels.map((level) => (level === 'warning' ? 'warn' : level)),
        )
      : undefined;
    const filter = typeof args.filter === 'string' ? args.filter : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 100;
    const result = tab.logs
      .filter(
        (entry) =>
          (levels === undefined || levels.has(entry.level)) &&
          (filter === undefined ||
            entry.message.includes(filter) ||
            entry.url?.includes(filter) === true),
      )
      .slice(-limit);
    return result;
  }

  private requireDialog(tab: TabState): Dialog {
    if (tab.dialog !== undefined) return tab.dialog;
    throw new BrowserRuntimeError(
      'NOT_FOUND',
      'No JavaScript dialog is open on this tab',
    );
  }

  private async waitForEvent(
    tab: TabState,
    args: Args,
  ): Promise<DispatchResult> {
    const timeout = timeoutArg(args);
    if (args.event === 'filechooser') {
      const chooser = await tab.page.waitForEvent('filechooser', { timeout });
      const chooserId = `chooser-${randomUUID()}`;
      setBounded(
        tab.fileChoosers,
        chooserId,
        chooser,
        MAX_PENDING_TAB_RESOURCES,
      );
      return { chooserId, multiple: chooser.isMultiple() };
    }
    await tab.page.waitForEvent('download', { timeout });
    return {};
  }

  private async setChooserFiles(tab: TabState, args: Args): Promise<void> {
    const chooserId = stringArg(args, 'chooserId');
    const chooser = tab.fileChoosers.get(chooserId);
    if (chooser === undefined)
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The file chooser is stale or unknown',
      );
    await chooser.setFiles(await this.uploadFiles(args.files), {
      timeout: timeoutArg(args),
    });
    tab.fileChoosers.delete(chooserId);
  }

  private beginNavigationWait(tab: TabState, args: Args): string {
    const id = `navigation-${randomUUID()}`;
    const options = {
      timeout: timeoutArg(args),
      waitUntil: loadState(args.waitUntil),
      ...(typeof args.url === 'string' ? { url: args.url } : {}),
    } as const;
    const waiter = tab.page.waitForNavigation(options);
    waiter.catch(() => undefined);
    setBounded(tab.navigationWaiters, id, waiter, MAX_PENDING_TAB_RESOURCES);
    return id;
  }

  private async finishNavigationWait(tab: TabState, args: Args): Promise<void> {
    const id = stringArg(args, 'waiterId');
    const waiter = tab.navigationWaiters.get(id);
    if (waiter === undefined)
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The navigation waiter is stale or unknown',
      );
    try {
      await waiter;
    } finally {
      tab.navigationWaiters.delete(id);
    }
  }

  private async uploadFiles(value: unknown): Promise<string[]> {
    const paths = stringArray(value);
    let totalBytes = 0;
    const files: string[] = [];
    for (const path of paths) {
      if (!isAbsolute(path))
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          'Upload paths must be absolute',
        );
      const resolved = await realpath(path).catch(() => undefined);
      if (resolved === undefined)
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          `Upload path does not exist: ${path}`,
        );
      const info = await stat(resolved);
      if (!info.isFile())
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          `Upload path is not a file: ${path}`,
        );
      totalBytes += info.size;
      if (totalBytes > MAX_UPLOAD_BYTES)
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          `Uploads are limited to ${MAX_UPLOAD_BYTES} bytes per call`,
        );
      files.push(resolved);
    }
    return files;
  }

  private tab(args: Args): TabState {
    return this.session.claimed(stringArg(args, 'tabId'));
  }

  private assertBrowser(id: string): void {
    if (id !== this.browserId)
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'No Chrome browser exists for the supplied id',
      );
  }

  private assertBrowserSelector(id: string): void {
    if (id !== this.browserId && id !== 'extension')
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'No Chrome browser exists for the supplied id',
      );
  }

  private browserInfo(): BrowserInfo {
    return {
      id: this.browserId,
      name:
        this.sessionName === undefined
          ? 'Chrome'
          : `Chrome · ${this.sessionName}`,
      type: 'extension',
      family: 'chrome',
    };
  }

  private documentation(): string {
    return this.documentationText;
  }
}

function assertDialogAllows(method: string, tab: TabState): void {
  if (
    tab.dialog === undefined ||
    method === 'tab.getJsDialog' ||
    method === 'tab.dialog.accept' ||
    method === 'tab.dialog.dismiss' ||
    method === 'tab.close' ||
    method === 'tab.url' ||
    method === 'dev.logs' ||
    method === 'playwright.expectNavigation.cancel'
  )
    return;
  throw new BrowserRuntimeError(
    'DIALOG_OPEN',
    'A JavaScript dialog is open; call tab.getJsDialog() and accept or dismiss it before continuing',
  );
}

function setBounded<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  limit: number,
): void {
  map.set(key, value);
  if (map.size <= limit) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}
