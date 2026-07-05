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
    this.events.emit(AppEvent.ExtensionContentChanged, reason);
    return true;
  }

  clearExtensionsChanged(): void {
    this.extensionRefreshNeeded = false;
    this.suppressUntil = 0;
    this.events.emit(AppEvent.ExtensionsReloaded);
  }

  notifyExtensionsReloadStarted(): void {
    this.events.emit(AppEvent.ExtensionsReloadStarted);
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
