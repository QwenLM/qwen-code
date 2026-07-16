/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const CDP_VERSION = '1.3';
const COMMAND_TIMEOUT_MS = 20_000;

export type DebuggerEventListener = (
  method: string,
  params: Record<string, unknown>,
) => void;

export interface DebuggerSession {
  ensureAttached(): Promise<{ tabId: number; changed: boolean }>;
  withAttached<T>(operation: () => Promise<T>): Promise<T>;
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onEvent(listener: DebuggerEventListener): () => void;
  getTab(): Promise<chrome.tabs.Tab>;
  detach(): Promise<void>;
}

export class ChromeDebuggerSession implements DebuggerSession {
  private tabId: number | null = null;
  private pinnedTabId: number | null = null;
  private attaching: Promise<{ tabId: number; changed: boolean }> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private attachGeneration = 0;
  private readonly listeners = new Set<DebuggerEventListener>();
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor() {
    chrome.debugger.onEvent.addListener(this.handleEvent);
    chrome.debugger.onDetach.addListener(this.handleDetach);
  }

  async ensureAttached(): Promise<{ tabId: number; changed: boolean }> {
    if (this.tabId !== null) {
      return { tabId: this.tabId, changed: false };
    }
    if (this.pinnedTabId !== null) {
      return { tabId: this.pinnedTabId, changed: false };
    }
    if (this.attaching) return this.attaching;
    this.attaching = this.attachActiveTab(this.attachGeneration);
    try {
      return await this.attaching;
    } finally {
      this.attaching = null;
    }
  }

  async withAttached<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const { tabId } = await this.ensureAttached();
      this.pinnedTabId = tabId;
      return await operation();
    } finally {
      this.pinnedTabId = null;
      release();
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const tabId = this.pinnedTabId ?? (await this.ensureAttached()).tabId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`Chrome debugger command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      chrome.debugger.sendCommand(
        { tabId },
        method,
        params,
        (result?: object) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message ?? `${method} failed`));
          } else {
            resolve((result ?? {}) as Record<string, unknown>);
          }
        },
      );
    });
  }

  onEvent(listener: DebuggerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getTab(): Promise<chrome.tabs.Tab> {
    const tabId = this.pinnedTabId ?? (await this.ensureAttached()).tabId;
    return chrome.tabs.get(tabId);
  }

  async detach(): Promise<void> {
    this.attachGeneration += 1;
    if (this.attaching) {
      try {
        await this.attaching;
      } catch {
        // A canceled or failed attachment still needs normal cleanup below.
      }
    }
    await this.operationTail;
    await this.detachCurrent();
  }

  private async detachCurrent(): Promise<void> {
    const tabId = this.tabId;
    this.tabId = null;
    this.stopKeepalive();
    if (tabId === null) return;
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  private async attachActiveTab(generation: number): Promise<{
    tabId: number;
    changed: boolean;
  }> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id === undefined) {
      await this.detachCurrent();
      throw new Error('No active Chrome tab');
    }
    if (!tab.url || (!/^https?:/i.test(tab.url) && tab.url !== 'about:blank')) {
      await this.detachCurrent();
      throw new Error(`Chrome does not allow debugging this page: ${tab.url}`);
    }
    if (this.tabId === tab.id) return { tabId: tab.id, changed: false };
    await this.detachCurrent();

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId: tab.id! }, CDP_VERSION, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(
            new Error(
              `Unable to attach Chrome debugger: ${error.message ?? 'unknown error'}. Close DevTools or another debugger attached to this tab.`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
    this.tabId = tab.id;
    if (generation !== this.attachGeneration) {
      await this.detachCurrent();
      throw new Error('Chrome debugger attachment canceled');
    }
    this.startKeepalive();
    return { tabId: tab.id, changed: true };
  }

  private readonly handleEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId !== this.tabId) return;
    const event = (params ?? {}) as Record<string, unknown>;
    for (const listener of this.listeners) listener(method, event);
  };

  private readonly handleDetach = (
    source: chrome.debugger.Debuggee,
    reason: string,
  ): void => {
    if (source.tabId !== this.tabId) return;
    this.tabId = null;
    this.stopKeepalive();
    const event = { reason: reason || 'target_closed' };
    for (const listener of this.listeners) listener('Qwen.detached', event);
  };

  private startKeepalive(): void {
    if (this.keepalive !== null) return;
    this.keepalive = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    }, 20_000);
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }
}
