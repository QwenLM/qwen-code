/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installTerminalRedrawOptimizer,
  optimizeMultilineEraseLines,
} from './terminalRedrawOptimizer.js';

const ESC = '\u001B[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_ONE = `${ESC}1A`;
const CURSOR_DOWN_ONE = `${ESC}1B`;
const CURSOR_LEFT = `${ESC}G`;

describe('optimizeMultilineEraseLines', () => {
  it('collapses repeated cursor-up movement without erasing below', () => {
    const input = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}next frame`;

    expect(optimizeMultilineEraseLines(input)).toBe(
      `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}next frame`,
    );
  });

  it('leaves two-line erase sequences unchanged', () => {
    const input = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}next frame`;

    expect(optimizeMultilineEraseLines(input)).toBe(input);
  });

  it('leaves single-line erase sequences unchanged', () => {
    const input = `${ERASE_LINE}${CURSOR_LEFT}next frame`;

    expect(optimizeMultilineEraseLines(input)).toBe(input);
  });

  it('optimizes each multiline erase sequence in a chunk', () => {
    const first = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`;
    const second = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`;

    expect(optimizeMultilineEraseLines(`${first}a${second}b`)).toBe(
      `${first}a${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}b`,
    );
  });

  it('does not emit erase-down sequences', () => {
    const input = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`;

    expect(optimizeMultilineEraseLines(input)).not.toContain(`${ESC}J`);
  });
});

describe('installTerminalRedrawOptimizer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('optimizes string writes and restores the original writer', () => {
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout);
    const input = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`;

    stdout.write(input);

    expect(write).toHaveBeenCalledWith(
      `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}`,
      undefined,
      undefined,
    );

    restore();
    expect(stdout.write).toBe(write);
  });

  it('passes non-string writes through unchanged', () => {
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    installTerminalRedrawOptimizer(stdout);
    const input = Buffer.from('hello');

    stdout.write(input);

    expect(write).toHaveBeenCalledWith(input, undefined, undefined);
  });

  it('can be disabled for terminal compatibility fallback', () => {
    vi.stubEnv('QWEN_CODE_LEGACY_ERASE_LINES', '1');
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout);

    expect(stdout.write).toBe(write);
    restore();
    expect(stdout.write).toBe(write);
  });
});
