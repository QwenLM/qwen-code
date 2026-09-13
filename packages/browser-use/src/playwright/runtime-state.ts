/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dialog, FileChooser, Page } from 'playwright-core';

import type { BrowserUserTabInfo, LogEntry } from '../core/primitives.js';

export type Args = Record<string, unknown>;
export interface ProviderTab {
  providerTabId: number;
  title: string | null;
  url: string | null;
  active?: boolean;
  lastOpened?: string;
  tabGroup?: string;
  derivedFromProviderTabId?: number;
}

export interface DiscoveredTab extends BrowserUserTabInfo {
  providerTabId: number;
}

/**
 * One dialog the bridge reported opening, marked when the bridge reports it
 * closed and when Playwright delivers it; see PlaywrightSession's dialog
 * observers for the pairing rule.
 */
export interface DialogTraceEntry {
  closed: boolean;
  delivered: boolean;
}

export interface TabState {
  id: string;
  providerTabId: number;
  page: Page;
  stale: false | 'tab' | 'session';
  logs: LogEntry[];
  dialog?: Dialog;
  dialogTrace: DialogTraceEntry[];
  fileChoosers: Map<string, FileChooser>;
  navigationWaiters: Map<string, Promise<unknown>>;
}
