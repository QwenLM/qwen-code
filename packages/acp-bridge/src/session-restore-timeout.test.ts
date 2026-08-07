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
} from './session-restore-timeout.js';

const INVALID_TIMEOUTS = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_SESSION_RESTORE_TIMEOUT_MS + 1,
];

describe('resolveSessionRestoreTimeoutMs', () => {
  it('uses the restore default when no related timeout is configured', () => {
    expect(resolveSessionRestoreTimeoutMs({})).toBe(
      DEFAULT_SESSION_RESTORE_TIMEOUT_MS,
    );
  });

  it('keeps the explicit initialize timeout as a compatibility fallback', () => {
    expect(
      resolveSessionRestoreTimeoutMs({ initializeTimeoutMs: 25_000 }),
    ).toBe(25_000);
  });

  it('prefers the explicit restore timeout', () => {
    expect(
      resolveSessionRestoreTimeoutMs({
        initializeTimeoutMs: 25_000,
        sessionRestoreTimeoutMs: 90_000,
      }),
    ).toBe(90_000);
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
