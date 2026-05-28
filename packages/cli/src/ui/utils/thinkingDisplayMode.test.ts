/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../../config/settings.js';
import {
  DEFAULT_THINKING_DISPLAY_MODE,
  getThinkingDisplayMode,
  normalizeThinkingDisplayMode,
  THINKING_DISPLAY_ENV,
} from './thinkingDisplayMode.js';

function settingsWithMode(mode?: string): LoadedSettings {
  return {
    merged: mode ? { ui: { thinkingDisplayMode: mode } } : {},
  } as unknown as LoadedSettings;
}

describe('thinkingDisplayMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes supported values', () => {
    expect(normalizeThinkingDisplayMode('preview')).toBe('preview');
    expect(normalizeThinkingDisplayMode(' Loading ')).toBe('loading');
  });

  it('ignores unsupported values', () => {
    expect(normalizeThinkingDisplayMode('full')).toBeUndefined();
    expect(normalizeThinkingDisplayMode(false)).toBeUndefined();
  });

  it('defaults to preview', () => {
    expect(getThinkingDisplayMode(settingsWithMode())).toBe(
      DEFAULT_THINKING_DISPLAY_MODE,
    );
  });

  it('reads the configured UI mode', () => {
    expect(getThinkingDisplayMode(settingsWithMode('loading'))).toBe('loading');
  });

  it('lets the environment override the configured mode', () => {
    vi.stubEnv(THINKING_DISPLAY_ENV, 'loading');

    expect(getThinkingDisplayMode(settingsWithMode('preview'))).toBe('loading');
  });

  it('falls back when the environment override is invalid', () => {
    vi.stubEnv(THINKING_DISPLAY_ENV, 'expanded');

    expect(getThinkingDisplayMode(settingsWithMode('loading'))).toBe('loading');
  });
});
