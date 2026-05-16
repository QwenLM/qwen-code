/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  MAX_STOP_HOOK_BLOCK_CAP,
  STOP_HOOK_BLOCK_CAP_ENV,
  appendStopHookBlockingCapWarning,
  formatStopHookBlockingCapWarning,
  normalizeStopHookBlockingCap,
  resolveStopHookBlockingCap,
} from './stopHookCap.js';

describe('stop hook blocking cap', () => {
  afterEach(() => {
    delete process.env[STOP_HOOK_BLOCK_CAP_ENV];
  });

  it('normalizes invalid values to the default cap', () => {
    expect(normalizeStopHookBlockingCap(undefined)).toBe(
      DEFAULT_STOP_HOOK_BLOCK_CAP,
    );
    expect(normalizeStopHookBlockingCap(0)).toBe(DEFAULT_STOP_HOOK_BLOCK_CAP);
    expect(normalizeStopHookBlockingCap(-1)).toBe(DEFAULT_STOP_HOOK_BLOCK_CAP);
    expect(normalizeStopHookBlockingCap(Number.NaN)).toBe(
      DEFAULT_STOP_HOOK_BLOCK_CAP,
    );
  });

  it('normalizes finite fractional values down to whole iterations', () => {
    expect(normalizeStopHookBlockingCap(3.7)).toBe(3);
    expect(normalizeStopHookBlockingCap(100.9)).toBe(MAX_STOP_HOOK_BLOCK_CAP);
  });

  it('caps large finite values to avoid unbounded recursive Stop loops', () => {
    expect(normalizeStopHookBlockingCap(99999)).toBe(MAX_STOP_HOOK_BLOCK_CAP);
  });

  it('prefers the environment override over config', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV] = '3';

    expect(resolveStopHookBlockingCap(12)).toBe(3);
  });

  it('ignores an empty environment override', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV] = '';

    expect(resolveStopHookBlockingCap(12)).toBe(12);
  });

  it('formats warnings for the relevant hook event', () => {
    expect(formatStopHookBlockingCapWarning('Stop', 8)).toBe(
      'Stop hook blocked continuation 8 consecutive times; overriding and ending the turn.',
    );
    expect(formatStopHookBlockingCapWarning('SubagentStop', 2)).toContain(
      'SubagentStop hook blocked continuation 2 consecutive times',
    );
    expect(formatStopHookBlockingCapWarning('Stop', 1)).toBe(
      'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
    );
  });

  it('appends cap warnings to visible subagent output', () => {
    expect(appendStopHookBlockingCapWarning('done', undefined)).toBe('done');
    expect(appendStopHookBlockingCapWarning('', 'warning')).toBe('warning');
    expect(appendStopHookBlockingCapWarning('done', 'warning')).toBe(
      'done\n\nwarning',
    );
  });
});
