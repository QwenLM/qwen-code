/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_RESTORE_TIMEOUT_MS,
  MAX_SESSION_RESTORE_TIMEOUT_MS,
  resolveSessionRestoreTimeoutMs,
  restoreRetryAfterSeconds,
} from './session-restore-timeout.js';

const INVALID_TIMEOUTS = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_SESSION_RESTORE_TIMEOUT_MS + 1,
];

describe('restoreRetryAfterSeconds', () => {
  it.each([
    { budgetMs: 60_000, expected: 60 },
    // Floor: an explicit sub-5s budget is honored by the resolver, but a hint
    // shorter than the ordinary cadence helps nobody.
    { budgetMs: 20, expected: 5 },
    { budgetMs: 5_000, expected: 5 },
    // Ceiling: a very long configured budget must not advertise an absurd wait.
    { budgetMs: 300_000, expected: 120 },
    { budgetMs: MAX_SESSION_RESTORE_TIMEOUT_MS, expected: 120 },
  ])(
    'clamps a $budgetMs ms budget to $expected s',
    ({ budgetMs, expected }) => {
      expect(restoreRetryAfterSeconds(budgetMs)).toBe(expected);
    },
  );
});

describe('resolveSessionRestoreTimeoutMs', () => {
  it('accepts exactly the maximum restore timeout', () => {
    // The boundary is load-bearing, not decorative: `scheduled-task-keepalive`
    // treats `ms === MAX` as still-timed and `server.ts` uses `MAX + 1` as its
    // disable sentinel, so an off-by-one here would reject the largest legal
    // `setTimeout` delay at boot.
    expect(
      resolveSessionRestoreTimeoutMs({
        sessionRestoreTimeoutMs: MAX_SESSION_RESTORE_TIMEOUT_MS,
      }),
    ).toBe(MAX_SESSION_RESTORE_TIMEOUT_MS);
    expect(
      resolveSessionRestoreTimeoutMs({
        initializeTimeoutMs: MAX_SESSION_RESTORE_TIMEOUT_MS,
      }),
    ).toBe(MAX_SESSION_RESTORE_TIMEOUT_MS);
  });

  it('uses the restore default when no related timeout is configured', () => {
    expect(resolveSessionRestoreTimeoutMs({})).toBe(
      DEFAULT_SESSION_RESTORE_TIMEOUT_MS,
    );
  });

  it('lets a longer initialize timeout raise the restore budget', () => {
    expect(
      resolveSessionRestoreTimeoutMs({ initializeTimeoutMs: 90_000 }),
    ).toBe(90_000);
  });

  it('never lets an initialize timeout lower the restore budget', () => {
    // Regression for #8678: a deployment that tightened the child startup
    // check must not inherit a sub-default restore deadline.
    expect(
      resolveSessionRestoreTimeoutMs({ initializeTimeoutMs: 10_000 }),
    ).toBe(DEFAULT_SESSION_RESTORE_TIMEOUT_MS);
  });

  it('prefers the explicit restore timeout', () => {
    expect(
      resolveSessionRestoreTimeoutMs({
        initializeTimeoutMs: 25_000,
        sessionRestoreTimeoutMs: 90_000,
      }),
    ).toBe(90_000);
  });

  it('honors an explicit restore timeout below the default', () => {
    expect(
      resolveSessionRestoreTimeoutMs({
        initializeTimeoutMs: 90_000,
        sessionRestoreTimeoutMs: 5_000,
      }),
    ).toBe(5_000);
  });

  it.each(INVALID_TIMEOUTS)(
    'rejects invalid restore timeout %s',
    (sessionRestoreTimeoutMs) => {
      expect(() =>
        resolveSessionRestoreTimeoutMs({ sessionRestoreTimeoutMs }),
      ).toThrow(TypeError);
    },
  );

  it.each(INVALID_TIMEOUTS)(
    'rejects invalid initialize timeout fallback %s',
    (initializeTimeoutMs) => {
      expect(() =>
        resolveSessionRestoreTimeoutMs({ initializeTimeoutMs }),
      ).toThrow(TypeError);
    },
  );
});
