/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRefreshState } from './extension-refresh-state.js';
import { AppEvent } from '../utils/events.js';

describe('extension refresh state', () => {
  let refreshState: ExtensionRefreshState;

  beforeEach(() => {
    refreshState = new ExtensionRefreshState();
  });

  it('deduplicates refresh notifications until cleared', () => {
    const listener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, listener);

    try {
      expect(
        refreshState.markExtensionsChanged('extension files changed'),
      ).toBe(true);
      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(listener).toHaveBeenCalledWith('extension files changed');

      expect(
        refreshState.markExtensionsChanged('extension files changed again'),
      ).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);

      refreshState.clearExtensionsChanged();
      expect(refreshState.needsExtensionRefresh()).toBe(false);

      expect(
        refreshState.markExtensionsChanged('extension files changed again'),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, listener);
    }
  });

  it('suppresses watcher notifications during known mutations', async () => {
    const staleListener = vi.fn();
    const contentListener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, staleListener);
    refreshState.on(AppEvent.ExtensionContentChanged, contentListener);

    try {
      await refreshState.suppressNotifications(async () => {
        expect(
          refreshState.markExtensionsChanged('extension files changed'),
        ).toBe(false);
        expect(
          refreshState.markExtensionContentChanged('extension content changed'),
        ).toBe(false);
      });

      expect(refreshState.needsExtensionRefresh()).toBe(false);
      expect(staleListener).not.toHaveBeenCalled();
      expect(contentListener).not.toHaveBeenCalled();
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, staleListener);
      refreshState.off(AppEvent.ExtensionContentChanged, contentListener);
    }
  });

  it('clears the post-mutation suppression window after reload', async () => {
    const listener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, listener);

    try {
      await refreshState.suppressNotifications(async () => {});
      expect(refreshState.markExtensionsChanged('during suppress window')).toBe(
        false,
      );

      refreshState.clearExtensionsChanged();

      expect(refreshState.markExtensionsChanged('after reload')).toBe(true);
      expect(listener).toHaveBeenCalledWith('after reload');
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, listener);
    }
  });

  it('settles only after all overlapping suppressions end', () => {
    const onSettle = vi.fn();
    const endFirst = refreshState.beginSuppression(onSettle);
    const endSecond = refreshState.beginSuppression(onSettle);

    endFirst();
    expect(onSettle).not.toHaveBeenCalled();

    endSecond();
    expect(onSettle).toHaveBeenCalledOnce();

    endSecond();
    expect(onSettle).toHaveBeenCalledOnce();
  });
});
