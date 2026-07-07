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

  it('preserves stale state for changes that arrive during reload', () => {
    const listener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, listener);

    try {
      expect(refreshState.markExtensionsChanged('before reload')).toBe(true);
      refreshState.notifyExtensionsReloadStarted();

      expect(refreshState.markExtensionsChanged('during reload')).toBe(false);
      refreshState.clearExtensionsChanged();

      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(
        'extension files changed during reload',
      );

      refreshState.clearExtensionsChanged();
      expect(refreshState.needsExtensionRefresh()).toBe(false);
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, listener);
    }
  });

  it('defers content changes that arrive during reload', () => {
    const contentListener = vi.fn();
    refreshState.on(AppEvent.ExtensionContentChanged, contentListener);

    try {
      refreshState.notifyExtensionsReloadStarted();

      expect(
        refreshState.markExtensionContentChanged(
          'content changed during reload',
        ),
      ).toBe(false);
      expect(contentListener).not.toHaveBeenCalled();

      refreshState.clearExtensionsChanged();

      expect(refreshState.needsExtensionRefresh()).toBe(false);
      expect(contentListener).toHaveBeenCalledOnce();
      expect(contentListener).toHaveBeenCalledWith(
        'extension content files changed during reload',
      );
    } finally {
      refreshState.off(AppEvent.ExtensionContentChanged, contentListener);
    }
  });

  it('lets stale changes during reload take priority over content changes', () => {
    const staleListener = vi.fn();
    const contentListener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, staleListener);
    refreshState.on(AppEvent.ExtensionContentChanged, contentListener);

    try {
      refreshState.notifyExtensionsReloadStarted();

      expect(refreshState.markExtensionContentChanged('content changed')).toBe(
        false,
      );
      expect(refreshState.markExtensionsChanged('manifest changed')).toBe(
        false,
      );
      refreshState.clearExtensionsChanged();

      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(staleListener).toHaveBeenCalledOnce();
      expect(staleListener).toHaveBeenCalledWith(
        'extension files changed during reload',
      );
      expect(contentListener).not.toHaveBeenCalled();
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, staleListener);
      refreshState.off(AppEvent.ExtensionContentChanged, contentListener);
    }
  });

  it('does not emit content changes while stale refresh is needed', () => {
    const contentListener = vi.fn();
    refreshState.on(AppEvent.ExtensionContentChanged, contentListener);

    try {
      expect(refreshState.markExtensionsChanged('manifest changed')).toBe(true);
      expect(refreshState.markExtensionContentChanged('content changed')).toBe(
        false,
      );
      expect(contentListener).not.toHaveBeenCalled();
    } finally {
      refreshState.off(AppEvent.ExtensionContentChanged, contentListener);
    }
  });

  it('keeps refresh needed when reload fails', () => {
    const staleListener = vi.fn();
    const reloadedListener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, staleListener);
    refreshState.on(AppEvent.ExtensionsReloaded, reloadedListener);

    try {
      refreshState.notifyExtensionsReloadStarted();
      refreshState.markExtensionsReloadFailed('reload failed');

      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(reloadedListener).toHaveBeenCalledOnce();
      expect(staleListener).toHaveBeenCalledWith('reload failed');
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, staleListener);
      refreshState.off(AppEvent.ExtensionsReloaded, reloadedListener);
    }
  });

  it('preserves changes that arrive before a reload failure', () => {
    const staleListener = vi.fn();
    const contentListener = vi.fn();
    refreshState.on(AppEvent.ExtensionRefreshNeeded, staleListener);
    refreshState.on(AppEvent.ExtensionContentChanged, contentListener);

    try {
      refreshState.notifyExtensionsReloadStarted();
      expect(refreshState.isReloadInProgress()).toBe(true);
      expect(refreshState.markExtensionContentChanged('content changed')).toBe(
        false,
      );
      expect(refreshState.markExtensionsChanged('manifest changed')).toBe(
        false,
      );

      refreshState.markExtensionsReloadFailed('reload failed');
      expect(refreshState.isReloadInProgress()).toBe(false);
      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(staleListener).toHaveBeenCalledWith('reload failed');

      refreshState.clearExtensionsChanged();
      expect(refreshState.needsExtensionRefresh()).toBe(true);
      expect(staleListener).toHaveBeenCalledWith(
        'extension files changed during reload',
      );
      expect(contentListener).not.toHaveBeenCalled();
    } finally {
      refreshState.off(AppEvent.ExtensionRefreshNeeded, staleListener);
      refreshState.off(AppEvent.ExtensionContentChanged, contentListener);
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
