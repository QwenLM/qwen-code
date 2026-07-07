/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractRememberErrorCode,
  extractRememberErrorDetails,
} from './workspace-remember-errors.js';

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

describe('extractRememberErrorDetails', () => {
  it('extracts details from common error shapes', () => {
    expect(extractRememberErrorDetails(new Error('boom'))).toBe('boom');
    expect(
      extractRememberErrorDetails({
        data: { details: 'agent stopped because max turns exceeded' },
      }),
    ).toBe('agent stopped because max turns exceeded');
    expect(extractRememberErrorDetails({ data: 'raw data detail' })).toBe(
      'raw data detail',
    );
    expect(
      extractRememberErrorDetails({
        data: { message: 'provider rejected the request' },
      }),
    ).toBe('provider rejected the request');
    expect(
      extractRememberErrorDetails({
        cause: new Error('nested failure reason'),
      }),
    ).toBe('nested failure reason');
    expect(extractRememberErrorDetails('raw string error')).toBe(
      'raw string error',
    );
  });

  it('redacts credentials before exposing details', () => {
    const details = extractRememberErrorDetails(
      new Error('Authorization: Bearer secret-token-value'),
    );

    expect(details).toBe('Authorization: <redacted>');
    expect(details).not.toContain('secret-token-value');
  });

  it('normalizes hidden separators before redacting credentials', () => {
    const details = extractRememberErrorDetails(
      new Error('Authorization: Bearer\u200bsecret-token-value'),
    );

    expect(details).toBe('Authorization: <redacted>');
    expect(details).not.toContain('secret-token-value');
  });

  it('normalizes line separators before redacting credentials', () => {
    for (const separator of ['\u2028', '\u2029']) {
      const details = extractRememberErrorDetails(
        new Error(`Authorization: Bearer${separator}secret-token-value`),
      );

      expect(details).toBe('Authorization: <redacted>');
      expect(details).not.toContain('secret-token-value');
    }
  });

  it('sanitizes control characters', () => {
    expect(extractRememberErrorDetails(new Error('line1\nline2\ttab'))).toBe(
      'line1 line2 tab',
    );
  });

  it('guards against circular causes', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['cause'] = cyclic;

    expect(extractRememberErrorDetails(cyclic)).toBeUndefined();
  });

  it('caps long details', () => {
    const details = extractRememberErrorDetails(new Error('x'.repeat(1100)));

    expect(details).toMatch(/^x+\.{3} \[truncated\]$/);
    expect(details).toHaveLength(1000);
  });
});
