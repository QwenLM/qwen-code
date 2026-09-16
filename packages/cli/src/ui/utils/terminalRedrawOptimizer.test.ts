/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTerminalRedrawStatsSnapshot,
  installTerminalRedrawOptimizer,
  optimizeMultilineEraseLines,
  resetTerminalRedrawStats,
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
    resetTerminalRedrawStats();
  });

  it('optimizes string writes and restores the original writer', () => {
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    // Explicit empty env: pins "no WSL markers / no flag -> installed" without
    // depending on the host environment. #7634
    const restore = installTerminalRedrawOptimizer(stdout, {});
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
    installTerminalRedrawOptimizer(stdout, {});
    const input = Buffer.from('hello');

    stdout.write(input);

    expect(write).toHaveBeenCalledWith(input, undefined, undefined);
  });

  it('tracks write, byte, clear, and erase optimization counters', () => {
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    installTerminalRedrawOptimizer(stdout, {});

    stdout.write(
      `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`,
    );
    stdout.write(Buffer.from('ok'));
    stdout.write('\u001B[2J\u001B[3J\u001B[H');

    expect(getTerminalRedrawStatsSnapshot()).toEqual({
      stdoutWriteCount: 3,
      stdoutBytes:
        Buffer.byteLength(
          `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}`,
        ) +
        Buffer.byteLength('ok') +
        Buffer.byteLength('\u001B[2J\u001B[3J\u001B[H'),
      clearTerminalCount: 1,
      eraseLinesOptimizedCount: 1,
    });
  });

  it('can be disabled for terminal compatibility fallback', () => {
    const env = { QWEN_CODE_LEGACY_ERASE_LINES: '1' };
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout, env);

    expect(stdout.write).toBe(write);
    restore();
    expect(stdout.write).toBe(write);
  });

  it.each([
    ['WSL_DISTRO_NAME', 'Ubuntu'],
    ['WSL_INTEROP', '/run/WSL/123_interop'],
  ])('is skipped when %s is set (#7634)', (name, value) => {
    const env = { [name]: value };
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout, env);

    expect(stdout.write).toBe(write);
    restore();
    expect(stdout.write).toBe(write);
  });

  it('is NOT skipped for WT_SESSION alone (#7634)', () => {
    // WT_SESSION is set on the Windows side and is not propagated into WSL
    // shells without WSLENV, so it must not trigger the skip. Pins the
    // deliberate exclusion from the skip condition (per maintainer review).
    const env = { WT_SESSION: 'console-12345' };
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout, env);

    expect(stdout.write).not.toBe(write);
    restore();
    expect(stdout.write).toBe(write);
  });

  it('reads process.env at call time by default (#7634)', () => {
    // Pins the production default-parameter seam: the sole caller omits the
    // env argument and the optimizer must honor the WSL marker from
    // process.env, not a hardcoded empty set. The flag is also stubbed so the
    // assertion depends only on the WSL marker, not on a host-set escape hatch.
    // The stubs are cleaned up in the describe-level afterEach.
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
    vi.stubEnv('QWEN_CODE_LEGACY_ERASE_LINES', '');
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout);

    expect(stdout.write).toBe(write);
    restore();
  });

  it('treats a non-standard flag value as unset (platform default)', () => {
    // The tri-state flag: only '1' (force-off) and '0' (force-on) are
    // recognized; anything else falls through to the platform default, so with
    // a WSL marker present the optimizer is still skipped.
    const env = {
      WSL_DISTRO_NAME: 'Ubuntu',
      QWEN_CODE_LEGACY_ERASE_LINES: 'garbage',
    };
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout, env);

    expect(stdout.write).toBe(write);
    restore();
    expect(stdout.write).toBe(write);
  });

  it('can be force-enabled on WSL via QWEN_CODE_LEGACY_ERASE_LINES=0 (#7634)', () => {
    const env = {
      WSL_DISTRO_NAME: 'Ubuntu',
      QWEN_CODE_LEGACY_ERASE_LINES: '0',
    };
    const write = vi.fn(() => true);
    const stdout = { write } as unknown as NodeJS.WriteStream;
    const restore = installTerminalRedrawOptimizer(stdout, env);

    // Three-line erase-up sequence triggers the optimizer's batching.
    const input = `${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_UP_ONE}${ERASE_LINE}${CURSOR_LEFT}`;
    stdout.write(input);
    expect(write).toHaveBeenCalledWith(
      `${ESC}2A${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${CURSOR_DOWN_ONE}${ERASE_LINE}${ESC}2A${CURSOR_LEFT}`,
      undefined,
      undefined,
    );
    restore();
  });
});
