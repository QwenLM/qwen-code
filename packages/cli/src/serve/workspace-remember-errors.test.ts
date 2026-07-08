/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractRememberErrorCode,
  extractRememberErrorDetails,
  extractRememberErrorStack,
  shouldSuppressRememberErrorDetails,
  workspaceMemoryFailureCode,
  workspaceMemoryFailureDiagnostics,
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
    expect(
      extractRememberErrorCode({
        cause: { cause: { code: 'remember_path_escape' } },
      }),
    ).toBe('remember_path_escape');
    expect(extractRememberErrorCode(new Error('boom'))).toBe('remember_failed');
    expect(extractRememberErrorCode(new Error('boom'), 'forget_failed')).toBe(
      'forget_failed',
    );
  });

  it('limits cause traversal depth', () => {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let index = 0; index < 60; index += 1) {
      const next: Record<string, unknown> = {};
      current['cause'] = next;
      current = next;
    }
    current['code'] = 'too_deep';

    expect(extractRememberErrorCode(root)).toBe('remember_failed');
  });

  it('falls back when code extraction throws', () => {
    const extractionErrors: Array<{ target: string; message: string }> = [];
    const err = new Proxy(
      {},
      {
        get() {
          throw new Error('code getter failed');
        },
      },
    );

    expect(
      workspaceMemoryFailureCode(err, 'dream_failed', (target, cause) =>
        extractionErrors.push({
          target,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    ).toBe('dream_failed');
    expect(extractionErrors).toEqual([
      { target: 'code', message: 'code getter failed' },
    ]);
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
        data: 'ERR_BRIDGE_INTERNAL',
        message: 'Connection to memory service refused',
      }),
    ).toBe('Connection to memory service refused');
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
    expect(extractRememberErrorDetails({ cause: 'string cause reason' })).toBe(
      'string cause reason',
    );
    expect(extractRememberErrorDetails('raw string error')).toBe(
      'raw string error',
    );
  });

  it('prefers bridge details over generic messages', () => {
    expect(
      extractRememberErrorDetails({
        data: { details: 'specific bridge reason' },
        message: 'generic message',
      }),
    ).toBe('specific bridge reason');
  });

  it('redacts credentials before exposing details', () => {
    const details = extractRememberErrorDetails(
      new Error('Authorization: Bearer secret-token-value'),
    );

    expect(details).toBe('Authorization: <redacted>');
    expect(details).not.toContain('secret-token-value');
  });

  it('normalizes hidden separators before redacting credentials', () => {
    for (const separator of [
      '\u00ad',
      '\u061c',
      '\u180e',
      '\u200b',
      '\u2060',
      '\u2064',
    ]) {
      const details = extractRememberErrorDetails(
        new Error(`Authorization: Bearer${separator}secret-token-value`),
      );

      expect(details).toBe('Authorization: <redacted>');
      expect(details).not.toContain('secret-token-value');
    }
  });

  it('redacts credentials with hidden separators inside token values', () => {
    for (const separator of [
      '\u00ad',
      '\u061c',
      '\u180e',
      '\u200b',
      '\u2060',
      '\u2064',
    ]) {
      const details = extractRememberErrorDetails(
        new Error(`Authorization: Bearer secret${separator}token-value`),
      );

      expect(details).toBe('Authorization: <redacted>');
      expect(details).not.toContain('secret');
      expect(details).not.toContain('token-value');
    }
  });

  it('redacts bearer tokens split by unicode space separators', () => {
    for (const separator of [
      '\u00a0',
      '\u1680',
      '\u2000',
      '\u2009',
      '\u200a',
      '\u202f',
      '\u205f',
      '\u3000',
    ]) {
      const details = extractRememberErrorDetails(
        new Error(`Bearer sk-AAAAAAAAAA${separator}BBBBBBBBBBBBBBB`),
      );

      expect(details).toBe('Bearer <redacted>');
      expect(details).not.toContain('AAAAAAAAAA');
      expect(details).not.toContain('BBBBBBBBBBBBBBB');
    }
  });

  it('redacts bearer tokens after unicode space separators', () => {
    for (const separator of ['\u00a0', '\u2009', '\u202f']) {
      const details = extractRememberErrorDetails(
        new Error(`Bearer${separator}secret-token-value`),
      );

      expect(details).toBe('Bearer <redacted>');
      expect(details).not.toContain('secret-token-value');
    }
  });

  it('redacts bare tokens split by invisible characters', () => {
    const details = extractRememberErrorDetails(
      new Error('OpenAI key sk-AAAAAAAAAA\u2062BBBBBBBBBBBBBBB'),
    );

    expect(details).toBe('OpenAI key sk-<redacted>');
    expect(details).not.toContain('AAAAAAAAAA');
    expect(details).not.toContain('BBBBBBBBBBBBBBB');
  });

  it('redacts bare bearer tokens separated by invisible characters', () => {
    const details = extractRememberErrorDetails(
      new Error('Bearer\u200BeyJhbGciOiABCDEFGHIJKLMN'),
    );

    expect(details).toBe('Bearer <redacted>');
    expect(details).not.toContain('eyJhbGciOiABCDEFGHIJKLMN');
  });

  it('redacts QQBot tokens separated by invisible characters', () => {
    const details = extractRememberErrorDetails(
      new Error('QQBot\u200Bsecret-token-value'),
    );

    expect(details).toBe('QQBot <redacted>');
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

  it('normalizes bidi isolation characters before redacting credentials', () => {
    for (const separator of ['\u2066', '\u2067', '\u2068', '\u2069']) {
      const details = extractRememberErrorDetails(
        new Error(`Authorization: Bearer${separator}secret-token-value`),
      );

      expect(details).toBe('Authorization: <redacted>');
      expect(details).not.toContain('secret-token-value');
    }
  });

  it('normalizes BOM before redacting credentials', () => {
    const details = extractRememberErrorDetails(
      new Error('Authorization: Bearer\ufeffsecret-token-value'),
    );

    expect(details).toBe('Authorization: <redacted>');
    expect(details).not.toContain('secret-token-value');
  });

  it('sanitizes control characters', () => {
    expect(extractRememberErrorDetails(new Error('line1\nline2\ttab'))).toBe(
      'line1 line2 tab',
    );
  });

  it('omits empty details after sanitization', () => {
    expect(extractRememberErrorDetails(new Error('\u200b'))).toBeUndefined();
  });

  it('guards against circular causes', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['cause'] = cyclic;

    expect(extractRememberErrorDetails(cyclic)).toBeUndefined();
  });

  it('limits cause traversal depth', () => {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let index = 0; index < 60; index += 1) {
      const next: Record<string, unknown> = {};
      current['cause'] = next;
      current = next;
    }
    current['message'] = 'too deep';

    expect(extractRememberErrorDetails(root)).toBeUndefined();
  });

  it('caps long details', () => {
    const details = extractRememberErrorDetails(new Error('x'.repeat(1100)));

    expect(details).toMatch(/^x+\.{3} \[truncated\]$/);
    expect(details).toHaveLength(1000);
  });

  it('does not split surrogate pairs when capping long details', () => {
    const details = extractRememberErrorDetails(
      new Error(`${'x'.repeat(984)}${'😀'.repeat(100)}`),
    );

    expect(details).toBe(`${'x'.repeat(984)}... [truncated]`);
    expect(details).toHaveLength(999);
  });

  it('keeps the full prefix when the cut point falls before a surrogate pair', () => {
    const details = extractRememberErrorDetails(
      new Error(`${'x'.repeat(985)}${'😀'.repeat(100)}`),
    );

    expect(details).toBe(`${'x'.repeat(985)}... [truncated]`);
    expect(details).toHaveLength(1000);
  });
});

describe('extractRememberErrorStack', () => {
  it('redacts and caps error stacks before logging', () => {
    const err = new Error('Authorization: Bearer secret-token-value');
    err.stack = `Error: Authorization: Bearer secret-token-value\n\tat handler (/workspace/file.ts:1:1)\n${'x'.repeat(1100)}`;

    const stack = extractRememberErrorStack(err);

    expect(stack).toContain('Authorization: <redacted>');
    expect(stack).toContain('\n\tat handler');
    expect(stack).not.toContain('secret-token-value');
    expect(stack).toHaveLength(1000);
  });

  it('preserves CRLF stack line endings before logging', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\r\n\tat handler (/workspace/file.ts:1:1)';

    const stack = extractRememberErrorStack(err);

    expect(stack).toBe('Error: boom\r\n\tat handler (/workspace/file.ts:1:1)');
  });
});

describe('workspaceMemoryFailureDiagnostics', () => {
  it('falls back when detail extraction throws', () => {
    const extractionErrors: Array<{ target: string; message: string }> = [];
    const err = new Proxy(
      {},
      {
        get() {
          throw new Error('detail getter failed');
        },
      },
    );

    const diagnostics = workspaceMemoryFailureDiagnostics(
      err,
      (target, cause) =>
        extractionErrors.push({
          target,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    );

    expect(diagnostics).toEqual({ debugDetails: '<details unavailable>' });
    expect(extractionErrors).toEqual([
      { target: 'details', message: 'detail getter failed' },
    ]);
  });

  it('falls back when stack extraction throws', () => {
    const extractionErrors: Array<{ target: string; message: string }> = [];
    const err = new Proxy(new Error('boom'), {
      get(target, property, receiver) {
        if (property === 'stack') {
          throw new Error('stack getter failed');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const diagnostics = workspaceMemoryFailureDiagnostics(
      err,
      (target, cause) =>
        extractionErrors.push({
          target,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    );

    expect(diagnostics).toEqual({
      details: 'boom',
      debugDetails: 'boom',
    });
    expect(extractionErrors).toEqual([
      { target: 'stack', message: 'stack getter failed' },
    ]);
  });
});

describe('shouldSuppressRememberErrorDetails', () => {
  it('suppresses details only for configured public errors', () => {
    expect(
      shouldSuppressRememberErrorDetails('managed_memory_unavailable'),
    ).toBe(true);
    expect(shouldSuppressRememberErrorDetails('remember_failed')).toBe(false);
  });
});
