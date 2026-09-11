/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS,
  LEGACY_MILLISECOND_TIMEOUT_THRESHOLD,
  resolveCommandHookTimeoutMs,
} from './hook-timeout.js';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({ warn, debug: vi.fn() }),
}));

describe('resolveCommandHookTimeoutMs', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it('defaults to 600 seconds', () => {
    expect(DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS).toBe(600);
    expect(resolveCommandHookTimeoutMs(undefined, 'default-hook')).toBe(
      600_000,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the default for %s',
    (timeout) => {
      expect(resolveCommandHookTimeoutMs(timeout, 'invalid-hook')).toBe(
        600_000,
      );
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
});
