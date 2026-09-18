/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BrowserHistoryEntry,
  BrowserInfo,
  BrowserUserTabInfo,
  TabInfo,
} from '../core/primitives.js';
import type { BrowserSdkContext } from './context.js';
import { TabProxy } from './tab.js';
import type {
  Browser,
  BrowserAgent,
  BrowserHistoryOptions,
  BrowserTab,
  Browsers,
  BrowserTabs,
  BrowserUser,
} from './types.js';

type Args = Record<string, unknown>;

class TabsProxy implements BrowserTabs {
  declare readonly browserId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, browserId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'browserId', { value: browserId });
  }
  async new(): Promise<BrowserTab> {
    return new TabProxy(
      this.context,
      this.browserId,
      await this.context.call<TabInfo>('tabs.new', {
        browserId: this.browserId,
      }),
    );
  }
  list(): Promise<TabInfo[]> {
    return this.context.call<TabInfo[]>('tabs.list', {
      browserId: this.browserId,
    });
  }
  async get(tabId: string): Promise<BrowserTab> {
    return new TabProxy(
      this.context,
      this.browserId,
      await this.context.call<TabInfo>('tabs.get', {
        browserId: this.browserId,
        tabId,
      }),
    );
  }
  async selected(): Promise<BrowserTab | undefined> {
    const info = await this.context.call<TabInfo | null>('tabs.selected', {
      browserId: this.browserId,
    });
    return info == null
      ? undefined
      : new TabProxy(this.context, this.browserId, info);
  }
}

class BrowserUserProxy implements BrowserUser {
  declare readonly browserId: string;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, browserId: string) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'browserId', { value: browserId });
  }
  openTabs(): Promise<BrowserUserTabInfo[]> {
    return this.context.call<BrowserUserTabInfo[]>('browser.user.openTabs', {
      browserId: this.browserId,
    });
  }
  async claimTab(tab: string | BrowserUserTabInfo): Promise<BrowserTab> {
    if (typeof tab !== 'string' && (!tab || typeof tab !== 'object')) {
      throw new TypeError(
        'claimTab expects a tab returned by browser.user.openTabs()',
      );
    }
    return new TabProxy(
      this.context,
      this.browserId,
      await this.context.call<TabInfo>('browser.user.claimTab', {
        browserId: this.browserId,
        tab,
      }),
    );
  }
  history(options?: BrowserHistoryOptions): Promise<BrowserHistoryEntry[]> {
    return this.context.call<BrowserHistoryEntry[]>('browser.user.history', {
      browserId: this.browserId,
      ...(options === undefined ? {} : { options }),
    });
  }
}

class BrowserProxy implements Browser {
  declare readonly browserId: string;
  declare readonly tabs: BrowserTabs;
  declare readonly user: BrowserUser;
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext, info: BrowserInfo) {
    Object.defineProperty(this, 'context', { value: context });
    Object.defineProperty(this, 'browserId', {
      value: info.id,
      enumerable: true,
    });
    Object.defineProperty(this, 'tabs', {
      value: new TabsProxy(context, info.id),
      enumerable: true,
    });
    Object.defineProperty(this, 'user', {
      value: new BrowserUserProxy(context, info.id),
      enumerable: true,
    });
  }
  documentation(): Promise<string> {
    return this.context.call<string>('browser.documentation', {
      browserId: this.browserId,
    });
  }
  nameSession(name: string): Promise<void> {
    return this.context.call<void>('browser.nameSession', {
      browserId: this.browserId,
      name,
    });
  }
  toJSON(): Args {
    return { type: 'Browser', browserId: this.browserId };
  }
}

class BrowsersProxy implements Browsers {
  declare private readonly context: BrowserSdkContext;

  constructor(context: BrowserSdkContext) {
    Object.defineProperty(this, 'context', { value: context });
  }
  list(): Promise<BrowserInfo[]> {
    return this.context.call<BrowserInfo[]>('browsers.list', {});
  }
  async get(id: string): Promise<Browser> {
    return new BrowserProxy(
      this.context,
      await this.context.call<BrowserInfo>('browsers.get', { id }),
    );
  }
}

export class AgentProxy implements BrowserAgent {
  declare readonly browsers: Browsers;

  constructor(context: BrowserSdkContext) {
    Object.defineProperty(this, 'browsers', {
      value: new BrowsersProxy(context),
      enumerable: true,
    });
  }
  toJSON(): Args {
    return { type: 'Agent' };
  }
}
