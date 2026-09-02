/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { BrowserRuntimeError } from './errors.js';
import type {
  BrowserDownloadEvent,
  DialogInfo,
  DispatchResult,
  LogEntry,
  NetworkEntry,
} from './primitives.js';
import { originOf, urlMatches } from './chrome-runtime-values.js';

export interface FrameRecord {
  frameId: string;
  sessionId: string | undefined;
  contextId: number | undefined;
  url: string;
}

export interface ChildSession {
  sessionId: string;
  targetId: string;
  ready: Promise<void>;
  setupError: Error | undefined;
}

export interface NavigationExpectation {
  id: string;
  afterSequence: number;
  deadline: number;
  expectedUrl: string | undefined;
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle';
  matchedUrl: string | undefined;
  interrupted: string | undefined;
  signals: Set<() => void>;
}

export type PlaywrightPageEvent = 'download' | 'filechooser';

export interface PageEventWaiter {
  event: PlaywrightPageEvent;
  resolve(value: DispatchResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface FileChooserRecord {
  id: string;
  backendNodeId: number;
  frameId: string;
  multiple: boolean;
}

export interface DownloadRecord {
  id: string;
  guid: string;
  url: string;
  suggestedFilename: string;
  startedAt: number;
  state: 'inProgress' | 'completed' | 'canceled';
  filePath: string | undefined;
  signals: Set<() => void>;
}

/** Bounded state derived from Chrome events for one claimed tab. */
export interface TabState {
  logs: LogEntry[];
  network: Map<string, NetworkEntry>;
  hiddenNetworkEntries: Set<string>;
  inflight: Map<string, number | undefined>;
  dialog: DialogInfo | undefined;
  dialogWaiters: Set<(dialog: DialogInfo) => void>;
  navigationSequence: number;
  documentId: string;
  navigationExpectations: Map<string, NavigationExpectation>;
  pageEventWaiters: Set<PageEventWaiter>;
  fileChoosers: Map<string, FileChooserRecord>;
  downloads: Map<string, DownloadRecord>;
  downloadEvents: BrowserDownloadEvent[];
  downloadEventsEnabled: boolean;
  mainFrameId: string | undefined;
  loader: { domContentLoaded: boolean; load: boolean };
  origin: string | undefined;
  stale: string | undefined;
  needsResync: boolean;
  resyncPromise: Promise<void> | undefined;
  frames: Map<string, FrameRecord>;
  sessions: Map<string, ChildSession>;
}

export function newTabState(url: string | null): TabState {
  return {
    logs: [],
    network: new Map(),
    hiddenNetworkEntries: new Set(),
    inflight: new Map(),
    dialog: undefined,
    dialogWaiters: new Set(),
    navigationSequence: 0,
    documentId: newDocumentIdentity(),
    navigationExpectations: new Map(),
    pageEventWaiters: new Set(),
    fileChoosers: new Map(),
    downloads: new Map(),
    downloadEvents: [],
    downloadEventsEnabled: false,
    mainFrameId: undefined,
    loader: { domContentLoaded: false, load: false },
    origin: originOf(url ?? ''),
    stale: undefined,
    needsResync: false,
    resyncPromise: undefined,
    frames: new Map(),
    sessions: new Map(),
  };
}

function newDocumentIdentity(): string {
  return `document-${randomUUID()}`;
}

export function renewDocumentIdentity(state: TabState): void {
  state.documentId = newDocumentIdentity();
}

export function staleDocumentError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'INVALID_LOCATOR',
    'The referenced browser document is stale; take a new DOM snapshot',
  );
}

export function recordNavigation(state: TabState, url: string): void {
  state.navigationSequence += 1;
  for (const expectation of state.navigationExpectations.values()) {
    if (
      expectation.matchedUrl === undefined &&
      state.navigationSequence > expectation.afterSequence &&
      (expectation.expectedUrl === undefined ||
        urlMatches(url, expectation.expectedUrl))
    ) {
      expectation.matchedUrl = url;
      signalNavigationExpectation(expectation);
    }
  }
}

export function interruptNavigationExpectations(
  state: TabState,
  reason: string,
): void {
  for (const expectation of state.navigationExpectations.values()) {
    expectation.interrupted = reason;
    signalNavigationExpectation(expectation);
  }
}

export function resolvePageEventWaiters(
  state: TabState,
  event: PlaywrightPageEvent,
  value: DispatchResult,
): void {
  for (const waiter of [...state.pageEventWaiters]) {
    if (waiter.event !== event) continue;
    state.pageEventWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }
}

export function rejectPageEventWaiters(
  state: TabState,
  event: PlaywrightPageEvent,
  error: Error,
): void {
  for (const waiter of [...state.pageEventWaiters]) {
    if (waiter.event !== event) continue;
    state.pageEventWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

export function interruptPageEventWaiters(
  state: TabState,
  reason: string,
): void {
  for (const event of ['download', 'filechooser'] as const) {
    rejectPageEventWaiters(
      state,
      event,
      new BrowserRuntimeError(
        'BROWSER_DISCONNECTED',
        `Page event observation was interrupted: ${reason}`,
      ),
    );
  }
}

export function signalDownload(download: DownloadRecord): void {
  for (const signal of download.signals) signal();
  download.signals.clear();
}

export function interruptDownloads(state: TabState): void {
  for (const download of state.downloads.values()) {
    if (download.state === 'inProgress') download.state = 'canceled';
    signalDownload(download);
  }
}

export async function waitForDownloadSignal(
  download: DownloadRecord,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout: { timer?: NodeJS.Timeout } = {};
    const signal = (): void => {
      if (timeout.timer !== undefined) clearTimeout(timeout.timer);
      download.signals.delete(signal);
      resolve();
    };
    download.signals.add(signal);
    timeout.timer = setTimeout(signal, timeoutMs);
  });
}

export function trimOldestMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function signalNavigationExpectation(
  expectation: NavigationExpectation,
): void {
  for (const signal of expectation.signals) signal();
  expectation.signals.clear();
}

export async function waitForNavigationSignal(
  expectation: NavigationExpectation,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout: { timer?: NodeJS.Timeout } = {};
    const signal = (): void => {
      if (timeout.timer !== undefined) clearTimeout(timeout.timer);
      expectation.signals.delete(signal);
      resolve();
    };
    expectation.signals.add(signal);
    timeout.timer = setTimeout(signal, timeoutMs);
  });
}

export function navigationExpectationTimeout(
  expectation: NavigationExpectation,
): BrowserRuntimeError {
  const target =
    expectation.expectedUrl === undefined
      ? 'a navigation'
      : `a navigation matching ${expectation.expectedUrl}`;
  return new BrowserRuntimeError(
    'OPERATION_TIMEOUT',
    `Timed out waiting for ${target}`,
  );
}
