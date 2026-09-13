/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS,
  LEGACY_MILLISECOND_TIMEOUT_THRESHOLD,
  formatLegacyHookTimeoutWarning,
  resetLegacyTimeoutWarnings,
  resolveCommandHookTimeoutMs,
} from './hook-timeout.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  loggingOn: true,
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    warn: logger.warn,
    debug: vi.fn(),
    isEnabled: () => logger.loggingOn,
  }),
  isDebugLogFileEnabled: () => logger.loggingOn,
}));

const { warn } = logger;

describe('resolveCommandHookTimeoutMs', () => {
  beforeEach(() => {
    warn.mockClear();
    logger.loggingOn = true;
    resetLegacyTimeoutWarnings();
  });

  it('defaults to 60 seconds', () => {
    expect(DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS).toBe(60);
    expect(resolveCommandHookTimeoutMs(undefined, 'default-hook')).toBe(60_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [0, '0'],
    [-1, '-1'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    ['', '""'],
    ['   ', '"   "'],
    ['30s', '"30s"'],
    [null, 'null'],
    [true, 'true'],
    [{}, '{}'],
  ])(
    'falls back to the default for %j and names the value once',
    (timeout, rendered) => {
      expect(resolveCommandHookTimeoutMs(timeout, 'invalid-hook')).toBe(60_000);
      expect(resolveCommandHookTimeoutMs(timeout, 'invalid-hook')).toBe(60_000);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        `Hook "invalid-hook" sets timeout ${rendered}`,
      );
      expect(warn.mock.calls[0]?.[0]).toContain('default of 60 seconds');
    },
  );

  it.each([
    [0.5, 500],
    [1, 1_000],
    [10, 10_000],
    [999, 999_000],
  ])('reads %s as seconds', (timeout, expectedMs) => {
    expect(resolveCommandHookTimeoutMs(timeout, 'seconds-hook')).toBe(
      expectedMs,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([1000, 5000, 60_000])(
    'reads %s as legacy milliseconds',
    (timeout) => {
      expect(timeout).toBeGreaterThanOrEqual(
        LEGACY_MILLISECOND_TIMEOUT_THRESHOLD,
      );
      expect(resolveCommandHookTimeoutMs(timeout, `legacy-${timeout}`)).toBe(
        timeout,
      );
    },
  );

  it('warns once per hook about a legacy millisecond timeout', () => {
    resolveCommandHookTimeoutMs(30_000, 'repeat-hook');
    resolveCommandHookTimeoutMs(30_000, 'repeat-hook');
    resolveCommandHookTimeoutMs(30_000, 'other-hook');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('timeout 30000');
    expect(warn.mock.calls[0]?.[0]).toContain('Set it to 30');
  });

  it('names a hook later when it was first resolved with debug logging off', () => {
    logger.loggingOn = false;
    resolveCommandHookTimeoutMs(45_000, 'late-log-hook');
    expect(warn).not.toHaveBeenCalled();

    logger.loggingOn = true;
    resolveCommandHookTimeoutMs(45_000, 'late-log-hook');
    resolveCommandHookTimeoutMs(45_000, 'late-log-hook');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names the same hook once in each session', () => {
    sessionIdContext.run('session-a', () => {
      resolveCommandHookTimeoutMs(45_000, 'shared-hook');
      resolveCommandHookTimeoutMs(45_000, 'shared-hook');
    });
    sessionIdContext.run('session-b', () => {
      resolveCommandHookTimeoutMs(45_000, 'shared-hook');
    });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['60000', 60_000],
    ['8', 8_000],
    [' 30 ', 30_000],
  ])(
    'reads the numeric string %j like the number it holds',
    (timeout, expectedMs) => {
      expect(resolveCommandHookTimeoutMs(timeout, 'string-hook')).toBe(
        expectedMs,
      );
    },
  );
});

describe('formatLegacyHookTimeoutWarning', () => {
  it('suggests the equivalent value in seconds', () => {
    expect(formatLegacyHookTimeoutWarning(30_000, 'build')).toContain(
      'Set it to 30 to keep this timeout.',
    );
  });

  it('shows how to keep a value that was meant as seconds', () => {
    expect(formatLegacyHookTimeoutWarning(1800, 'guard')).toContain(
      'If you meant 1800 seconds, set it to 1800000.',
    );
  });

  it('does not suggest a seconds value that would itself be read as milliseconds', () => {
    const warning = formatLegacyHookTimeoutWarning(1_800_000, 'build');
    expect(warning).not.toContain('Set it to 1800');
    expect(warning).toContain('leave it as 1800000');
  });
});
