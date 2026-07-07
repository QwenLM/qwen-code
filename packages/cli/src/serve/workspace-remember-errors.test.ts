/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractRememberErrorCode } from './workspace-remember-errors.js';

describe('extractRememberErrorCode', () => {
  it('extracts remember error codes from common error shapes', () => {
    expect(extractRememberErrorCode({ code: 'remember_queue_full' })).toBe(
      'remember_queue_full',
    );
    expect(
      extractRememberErrorCode({
        data: { errorKind: 'managed_memory_unavailable' },
      }),
    ).toBe('managed_memory_unavailable');
    expect(
      extractRememberErrorCode({ data: { code: 'remember_path_escape' } }),
    ).toBe('remember_path_escape');
    expect(
      extractRememberErrorCode({
        cause: { code: 'remember_timeout' },
      }),
    ).toBe('remember_timeout');
    expect(extractRememberErrorCode(new Error('boom'))).toBe('remember_failed');
    expect(extractRememberErrorCode(new Error('boom'), 'forget_failed')).toBe(
      'forget_failed',
    );
  });
});
