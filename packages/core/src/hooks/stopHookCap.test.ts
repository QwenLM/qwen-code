/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  STOP_HOOK_BLOCK_CAP_ENV,
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
  });

  it('prefers the environment override over config', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV] = '3';

    expect(resolveStopHookBlockingCap(12)).toBe(3);
  });

  it('formats warnings for the relevant hook event', () => {
    expect(formatStopHookBlockingCapWarning('Stop', 8)).toBe(
      'Stop hook blocked continuation 8 consecutive times; overriding and ending the turn.',
    );
    expect(formatStopHookBlockingCapWarning('SubagentStop', 2)).toContain(
      'SubagentStop hook blocked continuation 2 consecutive times',
    );
  });
});
