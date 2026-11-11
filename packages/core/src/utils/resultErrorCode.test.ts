/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildApiErrorDetails } from '../protocol/provider/qoder-api-error.js';
import { describe, expect, it } from 'vitest';
import {
  getResultErrorCode,
  getErrorDisplayCode,
  getResultErrorCodeFromMessages,
  RESULT_ERROR_CODES,
  isTerminalQuotaResultErrorCode,
} from './resultErrorCode.js';
import { ModelNotAvailableError, ModelNotFoundError } from './httpErrors.js';
import { FatalRoutingError } from '../routing/errors.js';
import { ModelInferenceError } from '../provider/modelInferenceError.js';

describe('resultErrorCode', () => {
  it.each([
    { code: 'insufficient_quota', status: 429, displayCode: 113 },
    { code: 'authentication_error', status: 401, displayCode: 105 },
    { code: undefined, status: 503, displayCode: 10500 },
  ])(
    'classifies $code / $status for display without rewriting the result code',
    ({ code, status, displayCode }) => {
      const error = new ModelInferenceError('private diagnostic', {
        code,
        status,
        kind: 'unknown',
        phase: 'before_output',
      });
      expect(getResultErrorCode(error)).toBe(code);
      expect(getErrorDisplayCode(error)).toBe(displayCode);
      expect(getErrorDisplayCode(new Error('wrapper', { cause: error }))).toBe(
        displayCode,
      );
      expect(error.code).toBe(code);
    },
  );

  it('does not introduce a quota-kind to business-code mapping', () => {
    const error = new ModelInferenceError('private diagnostic', {
      code: 'insufficient_quota',
      kind: 'quota_exhausted',
      phase: 'before_output',
    });
    expect(getErrorDisplayCode(error)).toBeUndefined();
    expect(getResultErrorCode(error)).toBe('insufficient_quota');
  });

  it.each(['112', '140', '00140', 'EXTERNAL_TOKEN_RATE_LIMITED'])(
    'passes Provider code %s through conflicting HTTP status and wrappers',
    (code) => {
      const error = new ModelInferenceError('HTTP 503', {
        code,
        kind: 'server',
        status: 503,
        phase: 'before_output',
      });
      expect(getResultErrorCode(error)).toBe(code);
      expect(
        getResultErrorCode(new Error('Lifecycle failed', { cause: error })),
      ).toBe(code);
    },
  );

  it('does not invent a Provider code from HTTP status or error text', () => {
    const error = new ModelInferenceError('HTTP 503', {
      kind: 'server',
      status: 503,
      phase: 'before_output',
    });
    expect(getResultErrorCode(error)).toBeUndefined();
  });

  it('does not assign the same numeric result code to multiple error categories', () => {
    const numericCodes = Object.values(RESULT_ERROR_CODES).filter(
      (code) => typeof code === 'number',
    );
    expect(new Set(numericCodes).size).toBe(numericCodes.length);
  });

  it.each([100400, 100401, 100403, 100404, 100406, 100407, 100409, 48713])(
    'preserves existing model business code %s without reclassifying it as a catalog miss',
    (code) => {
      expect(getResultErrorCode({ providerCode: String(code) })).toBe(code);
      expect(getResultErrorCode({ providerCode: code })).toBe(code);
      expect(code).not.toBe(RESULT_ERROR_CODES.modelNotAvailable);
    },
  );

  it('preserves the numeric catalog model availability code through routing wrappers and SDK fields', () => {
    const cause = new ModelNotAvailableError('Selected model is unavailable');
    const error = new FatalRoutingError(cause.message, { cause });
    expect(cause).toBeInstanceOf(ModelNotFoundError);
    expect(cause.code).toBe(404);
    expect(cause.name).toBe('ModelNotFoundError');
    expect(getResultErrorCode(error)).toBe(10404);
    expect(
      getResultErrorCode(new Error('Query failed', { cause: error })),
    ).toBe(10404);
    expect(getResultErrorCode({ error_code: 10404 })).toBe(10404);
    expect(getResultErrorCode({ error_code: '10404' })).toBe(10404);
    expect(getResultErrorCode(JSON.parse(JSON.stringify(cause)))).toBe(10404);
    expect(isTerminalQuotaResultErrorCode(10404)).toBe(false);
  });

  it('does not infer catalog unavailability from HTTP errors, error text, or cancellation', () => {
    expect(
      getResultErrorCode(new ModelNotFoundError('Not found')),
    ).toBeUndefined();
    expect(
      getResultErrorCode(new ModelNotFoundError('Restricted', 403)),
    ).toBeUndefined();
    expect(
      getResultErrorCode(new Error('Selected model is unavailable')),
    ).toBeUndefined();
    expect(getResultErrorCode({ code: 'ECONNRESET' })).toBe(500);
    const error = Object.assign(
      new Error('Operation aborted', {
        cause: new ModelNotAvailableError('Selected model is unavailable'),
      }),
      { name: 'AbortError' },
    );
    expect(getResultErrorCode(error)).toBeUndefined();
  });

  it('max output tokens identity survives result fields and error wrapping', () => {
    const error = Object.assign(new Error('Output was truncated'), {
      code: 'max_output_tokens',
      error_code: 'max_output_tokens',
    });
    expect(getResultErrorCode(error)).toBe('max_output_tokens');
    expect(
      getResultErrorCode(new Error('Display wrapper', { cause: error })),
    ).toBe('max_output_tokens');
    expect(getResultErrorCode({ error_code: 'max_output_tokens' })).toBe(
      'max_output_tokens',
    );
    const aborted = Object.assign(
      new Error('Operation aborted', { cause: error }),
      { name: 'AbortError' },
    );
    expect(getResultErrorCode(aborted)).toBeUndefined();
  });

  it.each([undefined, 401, 403])(
    'preserves job token identity before HTTP status %s',
    (httpStatus) => {
      const error = Object.assign(
        new Error('Login state verification failed'),
        {
          code: 'job_token_invalid',
          httpStatus,
        },
      );
      expect(getResultErrorCode(error)).toBe('job_token_invalid');
      expect(getResultErrorCode({ error_code: 'job_token_invalid' })).toBe(
        'job_token_invalid',
      );
    },
  );

  it.each([
    ['EDQUOT', 'storage_insufficient'],
    ['ENOSPC', 'storage_insufficient'],
  ])('将文件系统错误 %s 透传为独立存储错误码', (code, expected) => {
    const error = Object.assign(
      new Error(`${code}: storage write failed, write`),
      {
        code,
      },
    );
    expect(getResultErrorCode(error)).toBe(expected);
    expect(
      getResultErrorCode(new Error('Session failed', { cause: error })),
    ).toBe(expected);
    expect(getResultErrorCodeFromMessages([error.message])).toBe(expected);
    expect(getResultErrorCode({ error_code: expected })).toBe(expected);
    expect(isTerminalQuotaResultErrorCode(expected)).toBe(false);
  });

  it.each([
    ['EACCES', 'filesystem_access_denied'],
    ['EPERM', 'filesystem_access_denied'],
    ['EROFS', 'filesystem_access_denied'],
    ['EMFILE', 'open_files_limit_reached'],
    ['ENFILE', 'open_files_limit_reached'],
    ['EIO', 'filesystem_io_failed'],
    ['ESTALE', 'filesystem_io_failed'],
    ['ENOMEM', 'memory_insufficient'],
    ['EBUSY', 'filesystem_busy'],
    ['ETXTBSY', 'filesystem_busy'],
  ])('明确系统错误 %s 保留分类、包装信息和已输出的错误码', (code, expected) => {
    const error = Object.assign(
      new Error(`${code}: operation failed, open '/private/session'`),
      { code, syscall: 'open' },
    );
    expect(getResultErrorCode(error)).toBe(expected);
    expect(
      getResultErrorCode(new Error('Session failed', { cause: error })),
    ).toBe(expected);
    expect(getResultErrorCodeFromMessages([error.message])).toBe(expected);
    expect(getResultErrorCode({ error_code: expected })).toBe(expected);
    expect(isTerminalQuotaResultErrorCode(expected)).toBe(false);
    const aborted = Object.assign(
      new Error('Operation aborted', { cause: error }),
      { name: 'AbortError' },
    );
    expect(getResultErrorCode(aborted)).toBeUndefined();
  });
  it('文件监听错误不能丢掉 syscall 后被重新识别为磁盘容量', () => {
    expect(
      getResultErrorCode(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
          syscall: 'watch',
        }),
      ),
    ).toBeUndefined();
    expect(
      getResultErrorCodeFromMessages([
        'ENOSPC: no space left on device, watch',
      ]),
    ).toBeUndefined();
  });
  it('服务端同名错误码仍保留业务语义', () => {
    expect(
      getResultErrorCode({
        code: 'ENOMEM',
        providerCode: 'REMOTE_CAPACITY_LIMIT',
      }),
    ).toBe('REMOTE_CAPACITY_LIMIT');
  });
  it('主动取消保留取消语义，即使 cause 是存储故障', () => {
    const error = Object.assign(
      new Error('Operation aborted', {
        cause: Object.assign(new Error('Quota exceeded'), { code: 'EDQUOT' }),
      }),
      { name: 'AbortError' },
    );
    expect(getResultErrorCode(error)).toBeUndefined();
  });
  it('maps known server codes', () => {
    expect(
      getResultErrorCode({
        providerCode: '115',
      }),
    ).toBe(RESULT_ERROR_CODES.freeUserQuotaLimit);
  });

  it.each([112, 118])(
    'preserves personal Credits code %s without remapping',
    (code) => {
      expect(getResultErrorCode({ providerCode: String(code) })).toBe(code);
      expect(getResultErrorCode({ code, status: 403 })).toBe(code);
      expect(getResultErrorCode({ error_code: code })).toBe(code);
      expect(isTerminalQuotaResultErrorCode(code)).toBe(true);
    },
  );

  it('preserves personal Credits code 112 in legacy error messages', () => {
    expect(
      getResultErrorCodeFromMessages(['112: Credits exhausted, pricingUrl']),
    ).toBe(112);
  });

  it('preserves server code 122 as a Billing Group quota result code', () => {
    expect(
      getResultErrorCode({
        providerCode: '122',
      }),
    ).toBe(RESULT_ERROR_CODES.billingGroupCreditsLimitReached);
  });

  it('prefers nested Qoder API codes over generic transport errors', () => {
    expect(
      getResultErrorCode({
        code: 'http_error',
        status: 406,
        providerCode: '406',
        providerStatus: 406,
      }),
    ).toBe(RESULT_ERROR_CODES.sensitiveContent);
  });

  it('uses provider status 416 when the server code is a generic placeholder', () => {
    expect(
      getResultErrorCode({
        code: 'http_error',
        status: 416,
        providerCode: 'provider_error',
        providerStatus: 416,
      }),
    ).toBe(RESULT_ERROR_CODES.requestedRangeNotSatisfiable);
  });

  it('maps structured auth codes without unknown structured codes', () => {
    expect(getResultErrorCode({ code: 'auth_required' })).toBe(
      RESULT_ERROR_CODES.loginExpired,
    );
  });

  it('maps status codes only for explicit result categories', () => {
    expect(getResultErrorCode({ status: 406 })).toBe(
      RESULT_ERROR_CODES.sensitiveContent,
    );
    expect(getResultErrorCode({ status: 413 })).toBe(
      RESULT_ERROR_CODES.inputContentTooLong,
    );
    expect(getResultErrorCode({ status: 416 })).toBe(
      RESULT_ERROR_CODES.requestedRangeNotSatisfiable,
    );
    expect(getResultErrorCode({ status: 403 })).toBeUndefined();
    expect(getResultErrorCode({ status: 404 })).toBeUndefined();
  });

  it('maps model refusal semantically without conflating HTTP 416', () => {
    expect(getResultErrorCode({ code: 'MODEL_REFUSAL' })).toBe(
      RESULT_ERROR_CODES.sensitiveContent,
    );
    expect(getResultErrorCode({ status: 416 })).toBe(
      RESULT_ERROR_CODES.requestedRangeNotSatisfiable,
    );
  });

  it('does not map generic forbidden auth errors to login expiration', () => {
    expect(
      getResultErrorCode({ code: 'auth_error', status: 403 }),
    ).toBeUndefined();
    expect(
      getResultErrorCodeFromMessages(['model-server HTTP request failed: 403']),
    ).toBe(RESULT_ERROR_CODES.requestError);
  });

  it('still maps explicit login expiration codes', () => {
    expect(
      getResultErrorCode({
        code: 'http_error',
        status: 403,
        providerCode: '105',
        providerStatus: 403,
      }),
    ).toBe(RESULT_ERROR_CODES.loginExpired);
  });

  it('parses Qoder API error bodies from messages', () => {
    expect(
      getResultErrorCodeFromMessages([
        'Qoder API error: 403 - {"code":"116","message":"drained"}',
      ]),
    ).toBe(RESULT_ERROR_CODES.teamsAdminCreditsDrainedOut);
  });

  it('maps hook stops and blocks to the same machine-readable code', () => {
    expect(
      getResultErrorCodeFromMessages(['Agent execution blocked by hook']),
    ).toBe(RESULT_ERROR_CODES.hookBlocked);
    expect(
      getResultErrorCodeFromMessages([
        'Operation stopped by hook: BLOCKED-BY-HOOK',
      ]),
    ).toBe(RESULT_ERROR_CODES.hookBlocked);
  });

  it('prefers nested queued model codes over outer 403 errors', () => {
    const queueMessage = JSON.stringify({
      isQueued: true,
      modelKey: 'qmodel',
      queueCount: 36,
      queueType: 'slow',
      serviceAvailable: false,
      waitTime: 15837,
    });
    const body = JSON.stringify({
      code: '403',
      message: JSON.stringify({
        code: '10605',
        message: queueMessage,
      }),
    });

    expect(
      getResultErrorCodeFromMessages([`Qoder API error: FORBIDDEN - ${body}`]),
    ).toBe(RESULT_ERROR_CODES.modelQueued);
  });

  it.each([101, 110, 124, 125, 126, 600, 100400, 101400])(
    '服务端业务码 %s 在结构化错误和 JSON 正文中保持原值',
    (code) => {
      const body = JSON.stringify({
        code: String(code),
        message: 'Business rejection',
      });

      expect(
        getResultErrorCode({
          code: 'auth_error',
          httpStatus: 403,
          status: 403,
          qoderApiError: {
            source: 'qoder_api',
            status: 'FORBIDDEN',
            status_code: 403,
            code: String(code),
            message: 'Signature invalid',
            body,
          },
        }),
      ).toBe(code);
      expect(
        getResultErrorCodeFromMessages([
          `Qoder API error: FORBIDDEN - ${body}`,
        ]),
      ).toBe(code);
    },
  );

  it.each([500, 503, 599])('HTTP %s 仍归一为服务端内部错误', (status) => {
    expect(getResultErrorCode({ status })).toBe(
      RESULT_ERROR_CODES.serverInternalError,
    );
    expect(
      getResultErrorCodeFromMessages([`HTTP request failed: ${status}`]),
    ).toBe(RESULT_ERROR_CODES.serverInternalError);
  });

  it.each([
    'USER_PHONE_EMPTY',
    'USER_PHONE_QUERY_FAILED',
    'USER_PHONE_NOT_FOUND',
    'EXTERNAL_TOKEN_AUTH_FAILED',
    'EXTERNAL_TOKEN_TIMEOUT',
    'EXTERNAL_TOKEN_RATE_LIMITED',
    'EXTERNAL_TOKEN_UNAVAILABLE',
    'EXTERNAL_MODEL_USER_NOT_AVAILABLE',
    'EXTERNAL_MODEL_PREPARATION_FAILED',
  ])('preserves named external-model business code %s', (businessCode) => {
    const body = JSON.stringify({
      code: businessCode,
      message: 'External model request failed',
    });

    expect(
      getResultErrorCode({
        code: 'http_error',
        status: 429,
        providerCode: businessCode,
        providerStatus: 429,
      }),
    ).toBe(businessCode);
    expect(
      getResultErrorCodeFromMessages([
        `Qoder API error: TOO_MANY_REQUESTS - ${body}`,
      ]),
    ).toBe(businessCode);
  });

  it('preserves a named provider code carried by compression metadata', () => {
    expect(
      getResultErrorCode({
        providerCode: 'USER_PHONE_EMPTY',
        providerStatus: 429,
      }),
    ).toBe('USER_PHONE_EMPTY');
  });

  it('does not assign an error code for user cancellation', () => {
    const abortError = new Error('Operation cancelled by user');
    abortError.name = 'AbortError';

    expect(getResultErrorCode(abortError)).toBeUndefined();
    expect(
      getResultErrorCode({
        message: 'Request failed',
        cause: { name: 'AbortError' },
      }),
    ).toBeUndefined();
    expect(
      getResultErrorCodeFromMessages(['Operation aborted']),
    ).toBeUndefined();
  });

  it('maps request timeouts to the request timeout code', () => {
    const timeoutError = Object.assign(new Error('socket timeout'), {
      code: 'ETIMEDOUT',
    });

    expect(getResultErrorCode(timeoutError)).toBe(
      RESULT_ERROR_CODES.requestTimeout,
    );
    expect(
      getResultErrorCodeFromMessages([
        'SSE message timeout: no data for 90000ms',
      ]),
    ).toBe(RESULT_ERROR_CODES.requestTimeout);
  });

  it('maps generic network request failures to request error', () => {
    const networkError = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'socket reset' },
    });

    expect(getResultErrorCode(networkError)).toBe(
      RESULT_ERROR_CODES.requestError,
    );
    expect(
      getResultErrorCodeFromMessages(['model request failed: socket hang up']),
    ).toBe(RESULT_ERROR_CODES.requestError);
  });

  it('extracts HTTP status codes from request failure messages', () => {
    expect(
      getResultErrorCodeFromMessages(['model-server HTTP request failed: 429']),
    ).toBe(RESULT_ERROR_CODES.usageLimitExceeded);
    expect(
      getResultErrorCodeFromMessages(['model-server HTTP request failed: 502']),
    ).toBe(RESULT_ERROR_CODES.serverInternalError);
  });

  it('maps max-turns result messages to the max turns code', () => {
    expect(getResultErrorCodeFromMessages(['Maximum turns exceeded'])).toBe(
      RESULT_ERROR_CODES.maxTurnsReached,
    );
    expect(
      getResultErrorCodeFromMessages(['Reached maximum number of turns (25)']),
    ).toBe(RESULT_ERROR_CODES.maxTurnsReached);
  });

  it('maps local context-limit failures to the input-too-long code', () => {
    expect(
      getResultErrorCode(
        new Error(
          'Context exceeds the limit and automatic context recovery is unavailable. Please start a new session.',
        ),
      ),
    ).toBe(RESULT_ERROR_CODES.inputContentTooLong);
    expect(
      getResultErrorCodeFromMessages(['input is too long for requested model']),
    ).toBe(RESULT_ERROR_CODES.inputContentTooLong);
  });
});

it.each([101400, 124, 'enterprise_rejection'])(
  '外层业务码 %s 不被 message 内层已知错误覆盖',
  (code) => {
    for (const nested of [401, 110]) {
      expect(
        getResultErrorCode({
          providerError: {
            code,
            message: JSON.stringify({ code: nested }),
            status_code: 502,
          },
        }),
      ).toBe(code);
      const qoderApiError = buildApiErrorDetails({
        statusCode: 502,
        body: JSON.stringify({
          code,
          message: JSON.stringify({ code: nested }),
        }),
      });
      expect(qoderApiError.code).toBe(String(code));
      expect(getResultErrorCode({ qoderApiError })).toBe(code);
    }
  },
);
