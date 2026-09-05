/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright-core';

import type { ChromeBridge } from '../bridge/index.js';
import { BrowserRuntimeError, staleSessionError } from '../core/errors.js';
import type { BrowserUserTabInfo, TabInfo } from '../core/primitives.js';
import {
  playwrightTransportAdapter,
  QwenPlaywrightTransport,
} from './qwen-playwright-transport.js';
import {
  consoleLevel,
  providerTab,
  providerTabs,
  pushBounded,
  record,
  staleTabError,
} from './runtime-helpers.js';
import type { DiscoveredTab, ProviderTab, TabState } from './runtime-state.js';

export interface PlaywrightSessionOptions {
  bridge: ChromeBridge;
}

export class PlaywrightSession {
  private readonly bridge: ChromeBridge;
  private transport: QwenPlaywrightTransport | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private readonly discoveredTabs = new Map<string, DiscoveredTab>();
  private readonly tabs = new Map<string, TabState>();
  private tabIdPrefix = newTabIdPrefix();
  private selectedTabId: string | undefined;
  private started = false;
  private stopped = false;
  private starting: Promise<void> | undefined;
  private registration = Promise.resolve();

  constructor(options: PlaywrightSessionOptions) {
    this.bridge = options.bridge;
    this.bridge.onEvent((event) => {
      if (event.method === 'qwenBrowser.derivedTabTracked') {
        const parent = record(event.params).openerTabId;
        if (
          typeof parent === 'number' &&
          [...this.tabs.values()].some(
            (tab) => tab.providerTabId === parent && !tab.stale,
          )
        ) {
          void this.bridge
            .request('tabs.get', { tabId: event.tabId })
            .then(async (value) => {
              const provider = providerTab(value);
              await this.registerTab(provider);
            })
            .catch(() => undefined);
        }
      }
    });
    this.bridge.onConnectionChange((connected) => {
      if (connected) return;
      for (const tab of this.tabs.values()) tab.stale = 'session';
      this.tabIdPrefix = newTabIdPrefix();
      this.tabs.clear();
      this.discoveredTabs.clear();
      this.selectedTabId = undefined;
      this.transport = undefined;
      this.browser = undefined;
      this.context = undefined;
      this.started = false;
    });
  }

  async start(): Promise<void> {
    if (this.stopped)
      throw new BrowserRuntimeError(
        'NOT_RUNNING',
        'A stopped Browser Use runtime cannot be restarted',
      );
    if (this.started && this.browser?.isConnected()) return;
    const attempt = (this.starting ??= this.startInternal());
    try {
      await attempt;
    } finally {
      if (this.starting === attempt) this.starting = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const tabIdPrefix = this.tabIdPrefix;
    await this.bridge.start();
    const transport = new QwenPlaywrightTransport(this.bridge);
    try {
      const browser = await chromium.connectOverCDP(
        playwrightTransportAdapter(transport),
        {
          noDefaults: true,
          timeout: 10_000,
        },
      );
      const context = browser.contexts()[0];
      if (context === undefined)
        throw new BrowserRuntimeError(
          'OPERATION_FAILED',
          'Playwright did not expose the Chrome default context',
        );
      if (this.stopped)
        throw new BrowserRuntimeError(
          'NOT_RUNNING',
          'Browser Use stopped while Playwright was connecting',
        );
      if (tabIdPrefix !== this.tabIdPrefix)
        throw new BrowserRuntimeError(
          'BROWSER_DISCONNECTED',
          'Chrome extension disconnected while Playwright was connecting',
        );
      this.transport = transport;
      this.browser = browser;
      this.context = context;
      this.started = true;
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.starting?.catch(() => undefined);
    if (this.bridge.isConnected()) {
      await Promise.allSettled(
        [...this.tabs.values()].map(async (tab) =>
          this.bridge.request(
            'tabs.detach',
            { tabId: tab.providerTabId },
            2_000,
          ),
        ),
      );
    }
    this.tabs.clear();
    this.discoveredTabs.clear();
    this.transport?.close();
    await this.bridge.stop();
  }

  isSessionStale(id: string): boolean {
    return id.startsWith('tab-') && !id.startsWith(this.tabIdPrefix);
  }

  async newTab(): Promise<TabInfo> {
    const provider = providerTab(await this.bridge.request('tabs.create'));
    return await this.registerTab(provider);
  }

  async listTabs(): Promise<TabInfo[]> {
    await this.syncDerivedTabs();
    return await Promise.all(
      [...this.tabs.values()]
        .filter((tab) => !tab.stale)
        .map(async (tab) => await this.tabInfo(tab)),
    );
  }

  async getTabInfo(id: string): Promise<TabInfo> {
    return await this.tabInfo(this.claimed(id));
  }

  async selectedTabInfo(): Promise<TabInfo | null> {
    const selected =
      this.selectedTabId === undefined
        ? undefined
        : this.tabs.get(this.selectedTabId);
    return selected === undefined || selected.stale
      ? null
      : await this.tabInfo(selected);
  }

  async openTabs(): Promise<BrowserUserTabInfo[]> {
    const providers = providerTabs(await this.bridge.request('tabs.queryOpen'));
    this.discoveredTabs.clear();
    return providers.map((provider) => {
      const tab: DiscoveredTab = {
        id: `open-${randomUUID()}`,
        providerTabId: provider.providerTabId,
        title: provider.title,
        url: provider.url,
        ...(provider.lastOpened === undefined
          ? {}
          : { lastOpened: provider.lastOpened }),
        ...(provider.tabGroup === undefined
          ? {}
          : { tabGroup: provider.tabGroup }),
      };
      this.discoveredTabs.set(tab.id, tab);
      return {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        ...(tab.lastOpened === undefined ? {} : { lastOpened: tab.lastOpened }),
        ...(tab.tabGroup === undefined ? {} : { tabGroup: tab.tabGroup }),
      };
    });
  }

  async claimTab(value: unknown): Promise<TabInfo> {
    const supplied = typeof value === 'string' ? { id: value } : record(value);
    const id = typeof supplied.id === 'string' ? supplied.id : '';
    const discovered = this.discoveredTabs.get(id);
    if (discovered === undefined)
      throw new BrowserRuntimeError(
        'TAB_NOT_GRANTED',
        'The tab must come from a fresh browser.user.openTabs() result',
      );
    if (
      ('title' in supplied && supplied.title !== discovered.title) ||
      ('url' in supplied && supplied.url !== discovered.url)
    )
      throw new BrowserRuntimeError(
        'STALE_TAB',
        'The supplied tab no longer matches the discovery result',
      );
    const current = providerTab(
      await this.bridge.request('tabs.get', {
        tabId: discovered.providerTabId,
      }),
    );
    if (current.title !== discovered.title || current.url !== discovered.url)
      throw new BrowserRuntimeError(
        'STALE_TAB',
        'The Chrome tab changed after discovery; list open tabs again',
      );
    return await this.registerTab(current);
  }

  private async registerTab(provider: ProviderTab): Promise<TabInfo> {
    const tabIdPrefix = this.tabIdPrefix;
    const existing = [...this.tabs.values()].find(
      (tab) => tab.providerTabId === provider.providerTabId && !tab.stale,
    );
    if (existing !== undefined) {
      this.selectedTabId = existing.id;
      const info = await this.tabInfo(existing);
      if (tabIdPrefix !== this.tabIdPrefix) throw staleSessionError();
      return info;
    }
    return await this.serializeRegistration(async () => {
      if (tabIdPrefix !== this.tabIdPrefix) throw staleSessionError();
      const registered = [...this.tabs.values()].find(
        (tab) => tab.providerTabId === provider.providerTabId && !tab.stale,
      );
      if (registered !== undefined) {
        this.selectedTabId = registered.id;
        const info = await this.tabInfo(registered);
        if (tabIdPrefix !== this.tabIdPrefix) throw staleSessionError();
        return info;
      }
      const context = this.requireContext();
      const transport = this.requireTransport();
      const targetIdPromise = transport.registerTab(provider.providerTabId);
      const pagePromise = context.waitForEvent('page', {
        timeout: 10_000,
        predicate: async (candidate) =>
          (await pageTargetId(candidate)) === (await targetIdPromise),
      });
      let page: Page;
      try {
        [, page] = await Promise.all([targetIdPromise, pagePromise]);
        // noDefaults skips Playwright's focus emulation for background pages.
        await this.bridge.request('cdp.send', {
          tabId: provider.providerTabId,
          method: 'Emulation.setFocusEmulationEnabled',
          params: { enabled: true },
        });
      } catch (error) {
        await this.bridge
          .request('tabs.detach', { tabId: provider.providerTabId })
          .catch(() => undefined);
        await transport.unregisterTab(provider.providerTabId);
        throw error;
      }
      if (tabIdPrefix !== this.tabIdPrefix) {
        await this.bridge
          .request('tabs.detach', { tabId: provider.providerTabId })
          .catch(() => undefined);
        await transport
          .unregisterTab(provider.providerTabId)
          .catch(() => undefined);
        throw staleSessionError();
      }
      const tab: TabState = {
        id: `${tabIdPrefix}${randomUUID()}`,
        providerTabId: provider.providerTabId,
        page,
        stale: false,
        logs: [],
        fileChoosers: new Map(),
        navigationWaiters: new Map(),
      };
      this.installPageObservers(tab);
      this.tabs.set(tab.id, tab);
      this.selectedTabId = tab.id;
      const info = await this.tabInfo(tab);
      if (tabIdPrefix !== this.tabIdPrefix) throw staleSessionError();
      return info;
    });
  }

  private async serializeRegistration<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.registration;
    let release: (() => void) | undefined;
    this.registration = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private installPageObservers(tab: TabState): void {
    const { page } = tab;
    page.on('close', () => {
      if (tab.stale === false) tab.stale = 'tab';
      tab.dialog = undefined;
      tab.fileChoosers.clear();
      tab.navigationWaiters.clear();
      this.tabs.delete(tab.id);
      if (this.selectedTabId === tab.id) this.selectedTabId = undefined;
      const transport = this.transport;
      if (transport !== undefined)
        void transport.unregisterTab(tab.providerTabId).catch(() => undefined);
    });
    page.on('crash', () => {
      if (tab.stale === false) tab.stale = 'tab';
      tab.dialog = undefined;
      tab.fileChoosers.clear();
      tab.navigationWaiters.clear();
    });
    page.on('dialog', (dialog) => {
      tab.dialog = dialog;
    });
    page.on('console', (message) => {
      const location = message.location();
      pushBounded(tab.logs, {
        level: consoleLevel(message.type()),
        message: message.text().slice(0, 20_000),
        timestamp: new Date().toISOString(),
        ...(location.url === '' ? {} : { url: location.url }),
      });
    });
    page.on('pageerror', (error) => {
      pushBounded(tab.logs, {
        level: 'error',
        message: error.message.slice(0, 20_000),
        timestamp: new Date().toISOString(),
      });
    });
  }

  private async syncDerivedTabs(): Promise<void> {
    const controlledProviders = new Set(
      [...this.tabs.values()].map((tab) => tab.providerTabId),
    );
    const derived = providerTabs(
      await this.bridge.request('tabs.queryDerived'),
    );
    for (const provider of derived) {
      if (
        !controlledProviders.has(provider.providerTabId) &&
        provider.derivedFromProviderTabId !== undefined &&
        controlledProviders.has(provider.derivedFromProviderTabId)
      ) {
        await this.registerTab(provider);
        controlledProviders.add(provider.providerTabId);
      }
    }
  }

  private async tabInfo(tab: TabState): Promise<TabInfo> {
    if (tab.stale === 'session') throw staleSessionError();
    if (tab.stale === 'tab' || tab.page.isClosed()) throw staleTabError();
    return {
      id: tab.id,
      title:
        tab.dialog === undefined
          ? await tab.page.title().catch(() => null)
          : null,
      url: tab.page.url() || null,
    };
  }

  async closeTab(tab: TabState): Promise<void> {
    await this.bridge.request('tabs.close', { tabId: tab.providerTabId });
    tab.stale = 'tab';
    this.tabs.delete(tab.id);
    await this.transport?.unregisterTab(tab.providerTabId);
    if (this.selectedTabId === tab.id) this.selectedTabId = undefined;
  }

  claimed(id: string): TabState {
    const tab = this.tabs.get(id);
    if (tab?.stale === 'session') throw staleSessionError();
    if (tab === undefined || tab.stale === 'tab' || tab.page.isClosed())
      throw staleTabError();
    this.selectedTabId = id;
    return tab;
  }

  private requireContext(): BrowserContext {
    if (this.context !== undefined) return this.context;
    throw new BrowserRuntimeError(
      'NOT_RUNNING',
      'The Playwright browser context is unavailable',
    );
  }

  private requireTransport(): QwenPlaywrightTransport {
    if (this.transport !== undefined) return this.transport;
    throw new BrowserRuntimeError(
      'NOT_RUNNING',
      'The Playwright transport is unavailable',
    );
  }
}

function newTabIdPrefix(): string {
  return `tab-${randomUUID()}-`;
}

async function pageTargetId(page: Page): Promise<string | undefined> {
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const result = record(await session.send('Target.getTargetInfo'));
    const info = record(result.targetInfo);
    return typeof info.targetId === 'string' ? info.targetId : undefined;
  } catch {
    return undefined;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}
