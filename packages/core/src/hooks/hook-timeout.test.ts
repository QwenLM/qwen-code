/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS,
  DEFAULT_FUNCTION_HOOK_TIMEOUT_MS,
  DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS,
  DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS,
  LEGACY_MILLISECOND_TIMEOUT_THRESHOLD,
  describeHookTimeout,
  formatLegacyHookTimeoutWarning,
  resetLegacyTimeoutWarnings,
  resolveCommandHookTimeoutMs,
} from './hook-timeout.js';
import type { HookTimeoutDescription } from './hook-timeout.js';
import { HookType } from './types.js';
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

describe('describeHookTimeout', () => {
  beforeEach(() => {
    warn.mockClear();
    logger.loggingOn = true;
    resetLegacyTimeoutWarnings();
  });

  const configured = (timeoutMs: number): HookTimeoutDescription => ({
    timeoutMs,
    source: 'configured',
    ignoredConfiguredValue: false,
  });
  const byDefault = (
    timeoutMs: number,
    ignoredConfiguredValue: boolean,
  ): HookTimeoutDescription => ({
    timeoutMs,
    source: 'default',
    ignoredConfiguredValue,
  });
  // Node runs a timer whose delay is below 1 ms, NaN or above 2^31 - 1 ms
  // after 1 ms; the HTTP runner installs no timer unless the delay is above 0.
  const afterOneMs: HookTimeoutDescription = {
    timeoutMs: 1,
    source: 'unusable',
    ignoredConfiguredValue: false,
  };
  const noTimer: HookTimeoutDescription = {
    timeoutMs: null,
    source: 'unusable',
    ignoredConfiguredValue: false,
  };

  // [configured value, command, http, prompt, function]
  const matrix: Array<
    [
      unknown,
      HookTimeoutDescription,
      HookTimeoutDescription,
      HookTimeoutDescription,
      HookTimeoutDescription,
    ]
  > = [
    [
      undefined,
      byDefault(60_000, false),
      byDefault(600_000, false),
      byDefault(30_000, false),
      byDefault(5_000, false),
    ],
    [
      null,
      byDefault(60_000, true),
      byDefault(600_000, true),
      byDefault(30_000, true),
      byDefault(5_000, true),
    ],
    [
      60,
      configured(60_000),
      configured(60_000),
      configured(60_000),
      configured(60),
    ],
    [
      0,
      byDefault(60_000, true),
      byDefault(600_000, true),
      afterOneMs,
      afterOneMs,
    ],
    [-1, byDefault(60_000, true), noTimer, afterOneMs, afterOneMs],
    [
      1000,
      {
        timeoutMs: 1000,
        source: 'legacy-milliseconds',
        ignoredConfiguredValue: false,
      },
      configured(1_000_000),
      configured(1_000_000),
      configured(1000),
    ],
    [
      '60',
      configured(60_000),
      configured(60_000),
      configured(60_000),
      configured(60),
    ],
    ['abc', byDefault(60_000, true), noTimer, afterOneMs, afterOneMs],
    // JavaScript coercion the runners already apply, not introduced here.
    [
      Number.NaN,
      byDefault(60_000, true),
      byDefault(600_000, true),
      afterOneMs,
      afterOneMs,
    ],
    [
      true,
      byDefault(60_000, true),
      configured(1000),
      configured(1000),
      configured(1),
    ],
    [0.0005, afterOneMs, afterOneMs, afterOneMs, afterOneMs],
    [
      3_000_000,
      {
        timeoutMs: 3_000_000,
        source: 'legacy-milliseconds',
        ignoredConfiguredValue: false,
      },
      afterOneMs,
      afterOneMs,
      configured(3_000_000),
    ],
    [3_000_000_000, afterOneMs, afterOneMs, afterOneMs, afterOneMs],
  ];

  it.each(matrix)(
    'describes timeout %j for each hook type',
    (timeout, command, http, prompt, fn) => {
      expect(describeHookTimeout(HookType.Command, timeout)).toEqual(command);
      expect(describeHookTimeout(HookType.Http, timeout)).toEqual(http);
      expect(describeHookTimeout(HookType.Prompt, timeout)).toEqual(prompt);
      expect(describeHookTimeout(HookType.Function, timeout)).toEqual(fn);
    },
  );

  it('keeps a delay at the timer limit and replaces one just above it', () => {
    expect(describeHookTimeout(HookType.Function, 2 ** 31 - 1)).toEqual(
      configured(2 ** 31 - 1),
    );
    expect(describeHookTimeout(HookType.Function, 2 ** 31)).toEqual(afterOneMs);
  });

  it('reads defaults from the exported constants', () => {
    expect(describeHookTimeout(HookType.Command, undefined).timeoutMs).toBe(
      DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000,
    );
    expect(describeHookTimeout(HookType.Http, undefined).timeoutMs).toBe(
      DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS * 1000,
    );
    expect(describeHookTimeout(HookType.Prompt, undefined).timeoutMs).toBe(
      DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS * 1000,
    );
    expect(describeHookTimeout(HookType.Function, undefined).timeoutMs).toBe(
      DEFAULT_FUNCTION_HOOK_TIMEOUT_MS,
    );
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    0.5,
    8,
    1000,
    60_000,
    '60000',
    ' 30 ',
    '',
    '30s',
    true,
    {},
  ])(
    'gives the command runner the delay resolveCommandHookTimeoutMs returns for %j',
    (timeout) => {
      expect(describeHookTimeout(HookType.Command, timeout).timeoutMs).toBe(
        resolveCommandHookTimeoutMs(timeout, 'parity-hook'),
      );
    },
  );

  it('writes nothing to the debug log, however often it is called', () => {
    for (let i = 0; i < 100; i++) {
      for (const type of Object.values(HookType)) {
        for (const timeout of [undefined, null, 0, -1, 30_000, 'abc']) {
          describeHookTimeout(type, timeout);
        }
      }
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the command runner its one warning about the same hook', () => {
    describeHookTimeout(HookType.Command, 30_000);
    describeHookTimeout(HookType.Command, 0);

    resolveCommandHookTimeoutMs(30_000, 'described-hook');
    resolveCommandHookTimeoutMs(0, 'described-hook');

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
