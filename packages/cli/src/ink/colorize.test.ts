/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND_FIXED_ENV_PREFIX } from '@qwen-code/core';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each(['foreground', 'background'] as const)(
  'renders the ANSI theme green color name as %s',
  async (type) => {
    const { default: chalk } = await import('chalk');
    const { colorize } = await import('./colorize.js');
    const originalLevel = chalk.level;
    chalk.level = 3;
    try {
      const expected =
        type === 'foreground' ? chalk.green('x') : chalk.bgGreen('x');
      expect(colorize('x', 'green', type)).toBe(expected);
      expect(colorize('x', 'ansi:green', type)).toBe(expected);
    } finally {
      chalk.level = originalLevel;
    }
  },
);

describe('colorize GNU screen compatibility', () => {
  it('clamps truecolor output to 256-color inside GNU screen', async () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    vi.stubEnv('TERM', 'screen-256color');
    vi.stubEnv('STY', '1234.pts-0.host');
    vi.stubEnv('TMUX', '');

    const { default: chalk } = await import('chalk');
    chalk.level = 3;

    const { CHALK_CLAMPED_FOR_GNU_SCREEN, colorize } = await import(
      './colorize.js'
    );
    const output = colorize('x', '#112233', 'background');

    expect(CHALK_CLAMPED_FOR_GNU_SCREEN).toBe(true);
    expect(chalk.level).toBe(2);
    expect(output).toContain('\x1b[48;5;');
    expect(output).not.toContain('\x1b[48;2;');
  });

  it('keeps truecolor output in GNU screen when explicitly requested', async () => {
    vi.stubEnv('COLORTERM', 'truecolor');
    vi.stubEnv('TERM', 'screen-256color');
    vi.stubEnv('STY', '1234.pts-0.host');
    vi.stubEnv('TMUX', '');
    vi.stubEnv(`${BRAND_FIXED_ENV_PREFIX}SCREEN_TRUECOLOR`, '1');

    const { default: chalk } = await import('chalk');
    chalk.level = 3;

    const { CHALK_CLAMPED_FOR_GNU_SCREEN, colorize } = await import(
      './colorize.js'
    );
    const output = colorize('x', '#112233', 'background');

    expect(CHALK_CLAMPED_FOR_GNU_SCREEN).toBe(false);
    expect(chalk.level).toBe(3);
    expect(output).toContain('\x1b[48;2;17;34;51m');
  });
});
