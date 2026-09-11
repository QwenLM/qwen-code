/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS,
  LEGACY_MILLISECOND_TIMEOUT_THRESHOLD,
  SURVIVING_COMMAND_HOOK_TIMEOUT_SECONDS,
  formatLegacyHookTimeoutWarning,
  resetLegacyTimeoutWarnings,
  resolveCommandHookTimeoutMs,
} from './hook-timeout.js';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({ warn, debug: vi.fn() }),
}));

describe('resolveCommandHookTimeoutMs', () => {
  beforeEach(() => {
    warn.mockClear();
    resetLegacyTimeoutWarnings();
  });

  it('defaults to 600 seconds', () => {
    expect(DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS).toBe(600);
    expect(resolveCommandHookTimeoutMs(undefined, 'default-hook')).toBe(
      600_000,
    );
  });

  it('uses the caller-provided default when no timeout is configured', () => {
    expect(
      resolveCommandHookTimeoutMs(
        undefined,
        'surviving-hook',
        SURVIVING_COMMAND_HOOK_TIMEOUT_SECONDS,
      ),
    ).toBe(60_000);
    expect(
      resolveCommandHookTimeoutMs(
        10,
        'surviving-hook',
        SURVIVING_COMMAND_HOOK_TIMEOUT_SECONDS,
      ),
    ).toBe(10_000);
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

  it('warns in the first test that resolves a legacy value', () => {
    resolveCommandHookTimeoutMs(45_000, 'shared-label');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns again in a later test that resolves the same legacy value', () => {
    resolveCommandHookTimeoutMs(45_000, 'shared-label');
    expect(warn).toHaveBeenCalledTimes(1);
  });
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
