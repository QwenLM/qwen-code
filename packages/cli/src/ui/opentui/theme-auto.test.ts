/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI auto-theme adaptation keeps the ink parity chain in
 * order — COLORFGBG → OSC 10/11 (renderer probe) → macOS appearance → dark
 * — plus Qwen Light/Dark pair selection and live `theme_mode` subscription.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ThemeMode } from '@opentui/core';
import {
  detectInitialThemeMode,
  resolveAutoTheme,
  resolveThemeMode,
  subscribeThemeMode,
  THEME_MODE_WAIT_MS,
  type OpenTuiThemeModeEmitter,
  type OpenTuiThemeModeHost,
} from './theme-auto.js';
import { QwenDark } from '../themes/qwen-dark.js';
import { QwenLight } from '../themes/qwen-light.js';

describe('resolveThemeMode', () => {
  it('keeps light, defaults everything else to dark', () => {
    expect(resolveThemeMode('light')).toBe('light');
    expect(resolveThemeMode('dark')).toBe('dark');
    expect(resolveThemeMode(null)).toBe('dark');
    expect(resolveThemeMode(undefined)).toBe('dark');
  });
});

describe('resolveAutoTheme (ink ThemeManager auto parity)', () => {
  it('selects the Qwen pair by detected brightness', () => {
    expect(resolveAutoTheme('light')).toBe(QwenLight);
    expect(resolveAutoTheme('dark')).toBe(QwenDark);
    expect(resolveAutoTheme(null)).toBe(QwenDark);
  });
});

describe('detectInitialThemeMode', () => {
  beforeEach(() => {
    delete process.env['COLORFGBG'];
  });
  afterEach(() => {
    delete process.env['COLORFGBG'];
  });

  function makeHost(
    overrides: Partial<OpenTuiThemeModeHost> = {},
  ): OpenTuiThemeModeHost {
    return {
      themeMode: null,
      waitForThemeMode: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  it('prefers COLORFGBG over the renderer probe (ink chain order)', async () => {
    process.env['COLORFGBG'] = '15;15'; // light background index
    const wait = vi.fn();
    const host = makeHost({ themeMode: 'dark', waitForThemeMode: wait });
    await expect(detectInitialThemeMode(host)).resolves.toBe('light');
    expect(wait).not.toHaveBeenCalled();
  });

  it('uses the renderer mode when already known (no probe wait)', async () => {
    const wait = vi.fn();
    const host = makeHost({ themeMode: 'light', waitForThemeMode: wait });
    await expect(detectInitialThemeMode(host)).resolves.toBe('light');
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits for the renderer OSC 10/11 probe with the ink timeout', async () => {
    const host = makeHost({
      waitForThemeMode: vi.fn().mockResolvedValue('light'),
    });
    await expect(detectInitialThemeMode(host)).resolves.toBe('light');
    expect(host.waitForThemeMode).toHaveBeenCalledWith(THEME_MODE_WAIT_MS);
    expect(THEME_MODE_WAIT_MS).toBe(200);
  });

  it('falls back to COLORFGBG when the probe has no answer', async () => {
    process.env['COLORFGBG'] = '15;0'; // dark background index
    await expect(detectInitialThemeMode(makeHost())).resolves.toBe('dark');
  });

  it('degrades to the non-OSC fallbacks when the probe rejects', async () => {
    const host = makeHost({
      waitForThemeMode: vi.fn().mockRejectedValue(new Error('no tty')),
    });
    // macOS appearance (on darwin) or the dark default — never throws.
    await expect(detectInitialThemeMode(host)).resolves.toMatch(
      /^(dark|light)$/,
    );
  });

  it('uses the sync fallbacks without a renderer', async () => {
    process.env['COLORFGBG'] = '15;0';
    await expect(detectInitialThemeMode()).resolves.toBe('dark');
    await expect(detectInitialThemeMode(null)).resolves.toBe('dark');
  });
});

describe('subscribeThemeMode', () => {
  function makeEmitter(): OpenTuiThemeModeEmitter & {
    emitted: (mode: ThemeMode) => void;
    onSpy: ReturnType<typeof vi.fn>;
    offSpy: ReturnType<typeof vi.fn>;
  } {
    let listener: ((mode: ThemeMode) => void) | undefined;
    const onSpy = vi.fn(
      (_event: 'theme_mode', cb: (mode: ThemeMode) => void) => {
        listener = cb;
      },
    );
    const offSpy = vi.fn(() => {
      listener = undefined;
    });
    return {
      on: onSpy,
      off: offSpy,
      onSpy,
      offSpy,
      emitted: (mode: ThemeMode) => listener?.(mode),
    };
  }

  it('forwards live theme_mode events until unsubscribed', () => {
    const emitter = makeEmitter();
    const seen: ThemeMode[] = [];
    const unsubscribe = subscribeThemeMode(emitter, (mode) => seen.push(mode));
    expect(emitter.onSpy).toHaveBeenCalledWith(
      'theme_mode',
      expect.any(Function),
    );

    emitter.emitted('light');
    emitter.emitted('dark');
    expect(seen).toEqual(['light', 'dark']);

    unsubscribe();
    expect(emitter.offSpy).toHaveBeenCalledWith(
      'theme_mode',
      emitter.onSpy.mock.calls[0]![1],
    );
    emitter.emitted('light');
    expect(seen).toEqual(['light', 'dark']);
  });
});
