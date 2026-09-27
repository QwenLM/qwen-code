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
  /**
   * True when the attach-time probe found the renderer already blocked: a
   * dialog open before attach is replayed by neither Chrome nor Playwright,
   * so this is the only signal the dialog gate can honour for it.
   */
  dialogBlocked?: boolean;
  dialogTrace: DialogTraceEntry[];
  fileChoosers: Map<string, FileChooser>;
  navigationWaiters: Map<string, Promise<unknown>>;
  ownership: 'created' | 'claimed';
  /**
   * Refs the latest snapshot on this tab actually emitted. Playwright
   * restarts ref numbering on every new document, so a ref is valid only
   * while the snapshot that issued it is current; navigation clears the set.
   */
  snapshotRefs?: ReadonlySet<string>;
}
