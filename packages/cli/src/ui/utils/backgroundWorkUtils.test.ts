/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
} from './backgroundWorkUtils.js';

function createMockConfig(overrides?: {
  hasUnfinalizedTasks?: boolean;
  runningMonitors?: unknown[];
  hasRunningEntries?: boolean;
}): Config {
  return {
    getBackgroundTaskRegistry: () => ({
      hasUnfinalizedTasks: () => overrides?.hasUnfinalizedTasks ?? false,
      reset: vi.fn(),
    }),
    getMonitorRegistry: () => ({
      getRunning: () => overrides?.runningMonitors ?? [],
      reset: vi.fn(),
    }),
    getBackgroundShellRegistry: () => ({
      hasRunningEntries: () => overrides?.hasRunningEntries ?? false,
      reset: vi.fn(),
    }),
  } as unknown as Config;
}

describe('hasBlockingBackgroundWork', () => {
  it('returns false when nothing is running', () => {
    expect(hasBlockingBackgroundWork(createMockConfig())).toBe(false);
  });

  it('returns true when background tasks are unfinalized', () => {
    expect(
      hasBlockingBackgroundWork(
        createMockConfig({ hasUnfinalizedTasks: true }),
      ),
    ).toBe(true);
  });

  it('returns true when monitors are running', () => {
    expect(
      hasBlockingBackgroundWork(
        createMockConfig({ runningMonitors: [{ id: 'm1' }] }),
      ),
    ).toBe(true);
  });

  it('returns true when shell entries are running', () => {
    expect(
      hasBlockingBackgroundWork(createMockConfig({ hasRunningEntries: true })),
    ).toBe(true);
  });

  it('short-circuits: does not check monitors or shells when tasks are unfinalized', () => {
    const config = {
      getBackgroundTaskRegistry: () => ({
        hasUnfinalizedTasks: () => true,
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => {
        throw new Error('should not be called');
      },
      getBackgroundShellRegistry: () => {
        throw new Error('should not be called');
      },
    } as unknown as Config;

    expect(hasBlockingBackgroundWork(config)).toBe(true);
  });

  it('short-circuits: does not check shells when monitors are running', () => {
    const config = {
      getBackgroundTaskRegistry: () => ({
        hasUnfinalizedTasks: () => false,
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: () => [{ id: 'm1' }],
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => {
        throw new Error('should not be called');
      },
    } as unknown as Config;

    expect(hasBlockingBackgroundWork(config)).toBe(true);
  });
});

describe('resetBackgroundStateForSessionSwitch', () => {
  it('calls reset on all three registries', () => {
    const resetTasks = vi.fn();
    const resetMonitors = vi.fn();
    const resetShells = vi.fn();

    const config = {
      getBackgroundTaskRegistry: () => ({ reset: resetTasks }),
      getMonitorRegistry: () => ({ reset: resetMonitors }),
      getBackgroundShellRegistry: () => ({ reset: resetShells }),
    } as unknown as Config;

    resetBackgroundStateForSessionSwitch(config);

    expect(resetTasks).toHaveBeenCalledOnce();
    expect(resetMonitors).toHaveBeenCalledOnce();
    expect(resetShells).toHaveBeenCalledOnce();
  });
});
