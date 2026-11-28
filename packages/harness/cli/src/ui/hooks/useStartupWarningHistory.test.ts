/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WarningPriority, type StartupWarning } from '@qwen-code/core';
import {
  persistentStateMock,
  renderHook,
} from '../../test-utils/render.js';
import { MessageType } from '../types.js';
import { useStartupWarningHistory } from './useStartupWarningHistory.js';

describe('useStartupWarningHistory', () => {
  beforeEach(() => {
    persistentStateMock.reset();
    vi.clearAllMocks();
  });

  it('adds each high-priority warning to history once per mount', async () => {
    const addItem = vi.fn(() => 1);
    const warnings: StartupWarning[] = [
      {
        id: 'high-1',
        message: 'Check the project configuration.',
        priority: WarningPriority.High,
      },
    ];

    const { rerender, waitUntilReady, unmount } = await renderHook<
      void,
      { currentWarnings: StartupWarning[] }
    >(
      ({ currentWarnings }) =>
        useStartupWarningHistory(currentWarnings, addItem),
      { initialProps: { currentWarnings: warnings } },
    );
    await waitUntilReady();

    expect(addItem).toHaveBeenCalledWith({
      type: MessageType.WARNING,
      text: 'Check the project configuration.',
    });

    rerender({ currentWarnings: [...warnings] });
    await waitUntilReady();
    expect(addItem).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('increments and preserves the low-priority cross-session limit', async () => {
    const addItem = vi.fn(() => 1);
    persistentStateMock.setData({
      startupWarningCounts: { 'low-1': 2 },
    });
    const warnings: StartupWarning[] = [
      {
        id: 'low-1',
        message: 'Optional setup is available.',
        priority: WarningPriority.Low,
      },
    ];

    const { waitUntilReady, unmount } = await renderHook(() =>
      useStartupWarningHistory(warnings, addItem),
    );
    await waitUntilReady();

    expect(addItem).toHaveBeenCalledTimes(1);
    expect(persistentStateMock.set).toHaveBeenCalledWith(
      'startupWarningCounts',
      { 'low-1': 3 },
    );
    unmount();
  });

  it('does not add low-priority warnings after three sessions', async () => {
    const addItem = vi.fn(() => 1);
    persistentStateMock.setData({
      startupWarningCounts: { 'low-1': 3 },
    });
    const warnings: StartupWarning[] = [
      {
        id: 'low-1',
        message: 'Optional setup is available.',
        priority: WarningPriority.Low,
      },
    ];

    const { waitUntilReady, unmount } = await renderHook(() =>
      useStartupWarningHistory(warnings, addItem),
    );
    await waitUntilReady();

    expect(addItem).not.toHaveBeenCalled();
    expect(persistentStateMock.set).not.toHaveBeenCalled();
    unmount();
  });

  it('adds warnings that arrive after the initial render', async () => {
    const addItem = vi.fn(() => 1);
    const lateWarning: StartupWarning = {
      id: 'memory-warning',
      message: 'A context file could not be loaded.',
      priority: WarningPriority.High,
    };

    const { rerender, waitUntilReady, unmount } = await renderHook<
      void,
      { currentWarnings: StartupWarning[] }
    >(
      ({ currentWarnings }) =>
        useStartupWarningHistory(currentWarnings, addItem),
      { initialProps: { currentWarnings: [] as StartupWarning[] } },
    );
    await waitUntilReady();

    rerender({ currentWarnings: [lateWarning] });
    await waitUntilReady();
    expect(addItem).toHaveBeenCalledWith({
      type: MessageType.WARNING,
      text: lateWarning.message,
    });
    unmount();
  });
});
