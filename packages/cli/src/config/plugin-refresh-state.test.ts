/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPluginsChanged,
  markPluginsChanged,
  needsPluginRefresh,
  resetPluginRefreshStateForTesting,
} from './plugin-refresh-state.js';
import { appEvents, AppEvent } from '../utils/events.js';

describe('plugin refresh state', () => {
  beforeEach(() => {
    resetPluginRefreshStateForTesting();
  });

  it('deduplicates plugin refresh notifications until cleared', () => {
    const listener = vi.fn();
    appEvents.on(AppEvent.PluginRefreshNeeded, listener);

    try {
      expect(markPluginsChanged('extension installed')).toBe(true);
      expect(needsPluginRefresh()).toBe(true);
      expect(listener).toHaveBeenCalledWith('extension installed');

      expect(markPluginsChanged('extension updated')).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);

      clearPluginsChanged();
      expect(needsPluginRefresh()).toBe(false);

      expect(markPluginsChanged('extension updated')).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith('extension updated');
    } finally {
      appEvents.off(AppEvent.PluginRefreshNeeded, listener);
    }
  });
});
