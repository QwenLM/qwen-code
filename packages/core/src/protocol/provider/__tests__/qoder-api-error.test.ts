/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildApiErrorDetails,
  isServerRetryDisabled,
  parseApiErrorBody,
} from '../qoder-api-error.js';

describe('Qoder API error envelope', () => {
  it.each(['101400', '105', '406', '430', 'GatewayDenied'])(
    'preserves the outer business code %s over an inner known code',
    (code) => {
      const parsed = parseApiErrorBody(
        JSON.stringify({
          code,
          message: JSON.stringify({ code: '100401', message: 'inner detail' }),
        }),
      );
      expect(parsed?.code).toBe(code);
      expect(parsed?.message).toContain('inner detail');
    },
  );

  it.each([400, '401', '502', 'http_error', 'PROVIDER_ERROR'])(
    'looks through the outer HTTP or generic code %s for a business code',
    (code) => {
      expect(
        parseApiErrorBody(
          JSON.stringify({
            code,
            message: 'outer detail',
            error: { code: '105', message: 'login expired' },
          }),
        ),
      ).toMatchObject({ code: '105', message: 'login expired' });
    },
  );

  it('reads nested JSON messages without replacing the outer business meaning', () => {
    expect(
      parseApiErrorBody(
        JSON.stringify({ code: 101400, message: '{"code":401}' }),
      ),
    ).toMatchObject({ code: '101400', message: '{"code":401}' });
    expect(
      parseApiErrorBody(
        JSON.stringify({
          code: 502,
          message: '{"code":105,"message":"expired"}',
        }),
      ),
    ).toMatchObject({ code: '105', message: 'expired' });
  });

  it.each(['plain failure', '{', '[]', 'null'])(
    'does not manufacture a structured envelope from %s',
    (body) => expect(parseApiErrorBody(body)).toBeUndefined(),
  );

  it.each([false, true, undefined, 'false', 'true', null, 0])(
    'preserves only a boolean retryable field: %s',
    (retryable) => {
      const body = JSON.stringify({ code: '101400', retryable });
      const expected = typeof retryable === 'boolean' ? retryable : undefined;
      expect(parseApiErrorBody(body)?.retryable).toBe(expected);
      const details = buildApiErrorDetails({ statusCode: 502, body });
      expect(details.retryable).toBe(expected);
      expect(details.source).toBe('qoder_api');
      if (expected === undefined)
        expect(details).not.toHaveProperty('retryable');
    },
  );

  it('uses the outer boolean contract before the selected inner envelope', () => {
    const parse = (outer: unknown, inner: unknown) =>
      parseApiErrorBody(
        JSON.stringify({
          code: 'http_error',
          retryable: outer,
          error: { code: '105', message: 'expired', retryable: inner },
        }),
      )?.retryable;
    expect(parse(false, true)).toBe(false);
    expect(parse(true, false)).toBe(true);
    expect(parse('false', false)).toBe(false);
    expect(parse(undefined, false)).toBe(false);
  });

  it('keeps redaction and HTTP status independent from the selected business code', () => {
    const details = buildApiErrorDetails({
      status: 'Bad Gateway',
      statusCode: 502,
      body: JSON.stringify({
        code: '101400',
        retryable: false,
        message: '{"code":401,"passkey":"secret"}',
        passkey: 'secret',
      }),
    });
    expect(details).toMatchObject({
      source: 'qoder_api',
      status_code: 502,
      code: '101400',
      retryable: false,
    });
    expect(details.message).not.toContain('secret');
    expect(details.body).not.toContain('secret');
    expect(details.message).toContain('[redacted]');
    expect(details.body).toContain('[redacted]');
  });
});

describe('isServerRetryDisabled', () => {
  it.each(['qoderApiError', 'providerError'] as const)(
    'uses only structured boolean false in %s, including causes',
    (key) => {
      for (const retryable of [false, true, undefined, 'false', null, 0]) {
        const error = Object.assign(new Error('gateway failure'), {
          [key]: { retryable },
        });
        expect(isServerRetryDisabled(error)).toBe(retryable === false);
        expect(
          isServerRetryDisabled(new Error('wrapper', { cause: error })),
        ).toBe(retryable === false);
      }
    },
  );

  it('does not treat local flags or human-readable text as server instructions', () => {
    expect(isServerRetryDisabled({ retryable: false })).toBe(false);
    expect(isServerRetryDisabled(new Error('{"retryable":false}'))).toBe(false);
    expect(
      isServerRetryDisabled({
        qoderApiError: '{"retryable":false}',
        providerError: [{ retryable: false }],
      }),
    ).toBe(false);
  });

  it('keeps a deeper server veto despite local or outer retryable flags', () => {
    expect(
      isServerRetryDisabled({
        retryable: true,
        qoderApiError: { retryable: true },
        cause: { providerError: { retryable: false } },
      }),
    ).toBe(true);
  });

  it('handles circular causes and non-object values', () => {
    const cycle: Record<string, unknown> = {};
    cycle['cause'] = cycle;
    expect(isServerRetryDisabled(cycle)).toBe(false);
    cycle['qoderApiError'] = { retryable: false };
    expect(isServerRetryDisabled(cycle)).toBe(true);
    for (const error of [undefined, null, false, 'failure', []]) {
      expect(isServerRetryDisabled(error)).toBe(false);
    }
  });
});

describe('request retry metadata', () => {
  it('preserves deep retry delay and upstream type without legacy queue fields', () => {
    const details = buildApiErrorDetails({
      statusCode: 503,
      body: JSON.stringify({
        body: JSON.stringify({
          code: 'provider_error',
          retryable: false,
          details: JSON.stringify({
            error: { type: 'internal_server_error', retry_after_ms: '1500' },
          }),
        }),
      }),
    });
    expect(details).toMatchObject({
      code: 'provider_error',
      retryable: false,
      retry_after_ms: 1500,
      upstream_error_type: 'internal_server_error',
    });
    expect(details).not.toHaveProperty('queue');
  });

  it('keeps zero and converts server seconds to milliseconds', () => {
    for (const [seconds, expected] of [
      [0, 0],
      [2, 2000],
    ]) {
      expect(
        buildApiErrorDetails({
          body: JSON.stringify({
            code: 'server_error',
            retryAfterSeconds: seconds,
          }),
        }).retry_after_ms,
      ).toBe(expected);
    }
  });
});
