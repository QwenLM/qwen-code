/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND_FIXED_ENV_PREFIX } from '@qwen-code/core';
import {
  getColorDepth,
  isLowColorDepth,
  resetAppleTerminalCache,
} from './terminalUtils.js';

describe('terminalUtils', () => {
  const originalGetColorDepth = process.stdout.getColorDepth;

  afterEach(() => {
    process.stdout.getColorDepth = originalGetColorDepth;
    resetAppleTerminalCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('trusts COLORTERM truecolor outside terminal multiplexers', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('STY', '');
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TERMCAP', '');
    process.stdout.getColorDepth = vi.fn(() => 8);

    expect(getColorDepth()).toBe(24);
    expect(isLowColorDepth()).toBe(false);
  });

  it('does not trust forced truecolor inside GNU screen', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    vi.stubEnv('TERM', 'screen-256color');
    vi.stubEnv('STY', '1234.pts-0.host');
    vi.stubEnv('TMUX', '');
    process.stdout.getColorDepth = vi.fn(() => 24);

    expect(getColorDepth()).toBe(8);
    expect(isLowColorDepth()).toBe(true);
  });

  it('detects GNU screen from TERMCAP when STY is unavailable', () => {
    vi.stubEnv('COLORTERM', '24bit');
    vi.stubEnv('TERM', 'screen');
    vi.stubEnv('STY', '');
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TERMCAP', 'SC|screen|VT 100/ANSI X3.64 virtual terminal:\\');
    process.stdout.getColorDepth = vi.fn(() => 24);

    expect(getColorDepth()).toBe(8);
    expect(isLowColorDepth()).toBe(true);
  });

  it('allows GNU screen truecolor when explicitly requested', () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    vi.stubEnv('TERM', 'screen-256color');
    vi.stubEnv('STY', '1234.pts-0.host');
    vi.stubEnv(`${BRAND_FIXED_ENV_PREFIX}SCREEN_TRUECOLOR`, '1');
    process.stdout.getColorDepth = vi.fn(() => 8);

    expect(getColorDepth()).toBe(24);
  });
});
