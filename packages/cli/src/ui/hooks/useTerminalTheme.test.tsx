/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { useTerminalTheme } from './useTerminalTheme.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeConfig, type Config } from '@qwen-code/core';
import os from 'node:os';
import { themeManager } from '../themes/theme-manager.js';

const mockWrite = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockQueryTerminalBackground = vi.fn();

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({
      stdout: {
        write: mockWrite,
      },
    }),
  };
});

vi.mock('../contexts/TerminalContext.js', () => ({
  useTerminalContext: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    queryTerminalBackground: mockQueryTerminalBackground,
  }),
}));

const mockSettings = {
  merged: {
    ui: {
      theme: 'auto' as string | undefined,
      autoThemeSwitching: true,
      terminalBackgroundPollingInterval: 60,
      autoThemePair: {} as { dark?: string; light?: string },
    },
  },
};

vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: () => mockSettings,
}));

vi.mock('../themes/theme-manager.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../themes/theme-manager.js')>();
  return {
    ...actual,
    themeManager: {
      // Stand-in for the real resolver: 'auto'/unset follow the background,
      // anything else passes through. Hysteresis is covered in
      // theme-manager.test.ts against the real implementation.
      resolveThemeSetting: (
        setting: string | undefined,
        background: string | undefined,
      ) => {
        if (setting !== undefined && setting !== 'auto') return setting;
        return background === '#ffffff' ? 'default-light' : 'default';
      },
      setActiveTheme: vi.fn(),
      setTerminalBackground: vi.fn(),
    },
    DEFAULT_THEME: { name: 'default' },
  };
});

describe('useTerminalTheme', () => {
  let config: Config;

  beforeEach(() => {
    vi.useFakeTimers();
    config = makeFakeConfig({
      targetDir: os.tmpdir(),
    });
    config.setTerminalBackground('#000000');
    vi.spyOn(config, 'setTerminalBackground');

    mockWrite.mockClear();
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    mockQueryTerminalBackground.mockClear();
    vi.mocked(themeManager.setTerminalBackground).mockClear();
    vi.mocked(themeManager.setActiveTheme).mockClear();
    mockSettings.merged.ui.autoThemeSwitching = true;
    mockSettings.merged.ui.theme = 'auto';
    mockSettings.merged.ui.autoThemePair = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should subscribe to terminal background events on mount', async () => {
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );
    expect(mockSubscribe).toHaveBeenCalled();
    unmount();
  });

  it('should unsubscribe on unmount', async () => {
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('should poll for terminal background', async () => {
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );

    vi.advanceTimersByTime(60000);
    expect(mockQueryTerminalBackground).toHaveBeenCalled();
    unmount();
  });

  it('should not poll if terminal background is undefined at startup', async () => {
    config.getTerminalBackground = vi.fn().mockReturnValue(undefined);
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );

    vi.advanceTimersByTime(60000);
    expect(mockQueryTerminalBackground).not.toHaveBeenCalled();
    unmount();
  });

  it('should not poll when the user pinned a concrete theme', async () => {
    mockSettings.merged.ui.theme = 'GitHub';
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );

    vi.advanceTimersByTime(60000);
    expect(mockQueryTerminalBackground).not.toHaveBeenCalled();
    unmount();
  });

  it('should switch to light theme in memory when the background turns light', async () => {
    const requestRender = vi.fn();
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, requestRender),
    );

    const handler = mockSubscribe.mock.calls[0][0];

    handler('rgb:ffff/ffff/ffff');

    expect(config.setTerminalBackground).toHaveBeenCalledWith('#ffffff');
    expect(themeManager.setTerminalBackground).toHaveBeenCalledWith('#ffffff');
    expect(themeManager.setActiveTheme).toHaveBeenCalledWith('default-light');
    expect(requestRender).toHaveBeenCalled();
    unmount();
  });

  it('should switch to dark theme when the background turns dark', async () => {
    config.setTerminalBackground('#ffffff');

    const requestRender = vi.fn();
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, requestRender),
    );

    const handler = mockSubscribe.mock.calls[0][0];

    handler('rgb:0000/0000/0000');

    expect(config.setTerminalBackground).toHaveBeenCalledWith('#000000');
    expect(themeManager.setTerminalBackground).toHaveBeenCalledWith('#000000');
    expect(themeManager.setActiveTheme).toHaveBeenCalledWith('default');
    expect(requestRender).toHaveBeenCalled();
    unmount();
  });

  it('should not update config or request a render for repeated background reports', async () => {
    const requestRender = vi.fn();
    await renderHook(() => useTerminalTheme(config, requestRender));

    const handler = mockSubscribe.mock.calls[0][0];

    handler('rgb:0000/0000/0000');

    expect(config.setTerminalBackground).not.toHaveBeenCalled();
    expect(themeManager.setTerminalBackground).not.toHaveBeenCalled();
    expect(themeManager.setActiveTheme).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('should never touch the active theme when a concrete theme is pinned', async () => {
    mockSettings.merged.ui.theme = 'GitHub';

    const requestRender = vi.fn();
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, requestRender),
    );

    const handler = mockSubscribe.mock.calls[0][0];

    // The background flips to light; a pinned theme must survive it.
    handler('rgb:ffff/ffff/ffff');

    expect(config.setTerminalBackground).toHaveBeenCalledWith('#ffffff');
    expect(themeManager.setActiveTheme).not.toHaveBeenCalled();
    // Static UI still needs a repaint for the new background.
    expect(requestRender).toHaveBeenCalled();
    unmount();
  });

  it('should follow the background when ui.theme is unset', async () => {
    mockSettings.merged.ui.theme = undefined;

    const requestRender = vi.fn();
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, requestRender),
    );

    const handler = mockSubscribe.mock.calls[0][0];
    handler('rgb:ffff/ffff/ffff');

    expect(themeManager.setActiveTheme).toHaveBeenCalledWith('default-light');
    unmount();
  });

  it('should not switch theme if autoThemeSwitching is disabled', async () => {
    mockSettings.merged.ui.autoThemeSwitching = false;
    const { unmount } = await renderHook(() =>
      useTerminalTheme(config, vi.fn()),
    );

    vi.advanceTimersByTime(60000);
    expect(mockQueryTerminalBackground).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();

    mockSettings.merged.ui.autoThemeSwitching = true;
    unmount();
  });
});
