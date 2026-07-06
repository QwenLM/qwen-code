/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { AppEvent } from '../utils/events.js';

const SUPPRESS_AFTER_MS = 1000;

export class ExtensionRefreshState {
  private extensionRefreshNeeded = false;
  private reloadInProgress = false;
  private changedDuringReload = false;
  private contentChangedDuringReload = false;
  private suppressionDepth = 0;
  private suppressUntil = 0;

  constructor(private readonly events = new EventEmitter()) {}

  on(event: AppEvent, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  off(event: AppEvent, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }

  markExtensionsChanged(reason?: string): boolean {
    if (this.isSuppressed()) {
      return false;
    }
    if (this.reloadInProgress) {
      this.changedDuringReload = true;
      return false;
    }
    if (this.extensionRefreshNeeded) {
      return false;
    }
    this.extensionRefreshNeeded = true;
    this.events.emit(AppEvent.ExtensionRefreshNeeded, reason);
    return true;
  }

  markExtensionContentChanged(reason?: string): boolean {
    if (this.isSuppressed()) {
      return false;
    }
    if (this.reloadInProgress) {
      this.contentChangedDuringReload = true;
      return false;
    }
    if (this.extensionRefreshNeeded) {
      return false;
    }
    this.events.emit(AppEvent.ExtensionContentChanged, reason);
    return true;
  }

  clearExtensionsChanged(): void {
    const changedDuringReload = this.changedDuringReload;
    const contentChangedDuringReload = this.contentChangedDuringReload;
    this.extensionRefreshNeeded = changedDuringReload;
    this.reloadInProgress = false;
    this.changedDuringReload = false;
    this.contentChangedDuringReload = false;
    this.suppressUntil = 0;
    this.events.emit(AppEvent.ExtensionsReloaded);
    if (changedDuringReload) {
      this.events.emit(
        AppEvent.ExtensionRefreshNeeded,
        'extension files changed during reload',
      );
    } else if (contentChangedDuringReload) {
      this.events.emit(
        AppEvent.ExtensionContentChanged,
        'extension content files changed during reload',
      );
    }
  }

  notifyExtensionsReloadStarted(): void {
    this.reloadInProgress = true;
    this.changedDuringReload = false;
    this.contentChangedDuringReload = false;
    this.events.emit(AppEvent.ExtensionsReloadStarted);
  }

  markExtensionsReloadFailed(reason = 'extension reload failed'): void {
    this.extensionRefreshNeeded = true;
    this.reloadInProgress = false;
    this.changedDuringReload = false;
    this.contentChangedDuringReload = false;
    this.suppressUntil = 0;
    this.events.emit(AppEvent.ExtensionsReloaded);
    this.events.emit(AppEvent.ExtensionRefreshNeeded, reason);
  }

  needsExtensionRefresh(): boolean {
    return this.extensionRefreshNeeded;
  }

  beginSuppression(onSettle?: () => void): () => void {
    this.suppressionDepth++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.suppressionDepth = Math.max(0, this.suppressionDepth - 1);
      this.suppressUntil = Date.now() + SUPPRESS_AFTER_MS;
      if (this.suppressionDepth === 0) {
        onSettle?.();
      }
    };
  }

  suppressNotifications<T>(fn: () => T, onSettle?: () => void): T {
    const endSuppression = this.beginSuppression(onSettle);

    try {
      const result = fn();
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(endSuppression) as T;
      }
      endSuppression();
      return result;
    } catch (error) {
      endSuppression();
      throw error;
    }
  }

  resetForTesting(): void {
    this.extensionRefreshNeeded = false;
    this.reloadInProgress = false;
    this.changedDuringReload = false;
    this.contentChangedDuringReload = false;
    this.suppressionDepth = 0;
    this.suppressUntil = 0;
  }

  private isSuppressed(): boolean {
    return this.suppressionDepth > 0 || Date.now() < this.suppressUntil;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
