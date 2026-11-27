/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ModelInferenceError,
  classifyClientError,
} from '../provider/modelInferenceError.js';
import { ClientError, INCOMPLETE_STREAM_CODE } from '../client/clientError.js';
import { ProtocolLimitError } from '../utils/protocol-limits.js';
import {
  describeStreamInterruption,
  isContinuableStreamFailure,
  isResumableStreamFailure,
} from './stream-interruption.js';

describe('isResumableStreamFailure', () => {
  it('resumes only transport interruptions, not classified inference failures', () => {
    const classified: Array<['auth' | 'quota_exhausted' | 'server' | 'unknown']> = [
      ['auth'],
      ['quota_exhausted'],
      ['server'],
      ['unknown'],
    ];
    for (const [kind] of classified) {
      const error = new ModelInferenceError('failed', {
        kind,
        phase: 'after_output',
      });
      expect(isResumableStreamFailure(error)).toBe(false);
    }
    // network 分类只是不排除；仍要底层 socket code 才能证明是接收中断。
    const network = new ModelInferenceError('read failed', {
      kind: 'network',
      phase: 'after_output',
      cause: { code: 'ECONNRESET' },
    });
    expect(isResumableStreamFailure(network)).toBe(true);
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])(
    'does not treat a server error body mimicking %s as a local interruption',
    (code) => {
      const error = new ModelInferenceError('rejected secret-key', {
        kind: 'auth',
        phase: 'after_output',
        status: 403,
        code,
        qoderApiError: {
          source: 'qoder_api',
          status_code: 403,
          code,
          message: 'rejected [REDACTED]',
        },
      });
      expect(isResumableStreamFailure(error)).toBe(false);
    },
  );
  it.each([
    { status: 403, code: 'ECONNRESET' },
    { httpStatus: 403, phase: 'stream_idle' },
    { httpStatus: 200, status: 403, code: 'ECONNRESET' },
  ])('preserves explicit failures through wrappers: %j', (failure) => {
    const socket = { code: 'ECONNRESET' };
    expect(isResumableStreamFailure({ ...failure, cause: socket })).toBe(false);
    expect(isResumableStreamFailure({ ...socket, cause: failure })).toBe(false);
  });

  it.each([
    { code: 'ECONNRESET' },
    { code: 'EPIPE' },
    { code: 'UND_ERR_SOCKET' },
    { code: 'UND_ERR_BODY_TIMEOUT' },
    { phase: 'stream_idle' },
  ])('preserves local interruption recovery through a cause: %j', (cause) => {
    expect(isResumableStreamFailure(new Error('read failed', { cause }))).toBe(
      true,
    );
  });

  it('terminates cyclic causes and does not resume unrelated errors', () => {
    const error = Object.assign(new Error('unrelated'), { cause: {} });
    error.cause = error;
    expect(isResumableStreamFailure(error)).toBe(false);
    expect(isResumableStreamFailure(null)).toBe(false);
  });
});

describe('isContinuableStreamFailure', () => {
  it.each([
    { code: INCOMPLETE_STREAM_CODE },
    { code: 'ECONNRESET' },
    { code: 'UND_ERR_SOCKET' },
    { code: 'UND_ERR_BODY_TIMEOUT' },
    { phase: 'stream_idle' },
  ])('gates receiving interruptions with retryFetchErrors: %j', (cause) => {
    const error = new ModelInferenceError('interrupted', {
      kind: 'network',
      phase: 'after_output',
      cause,
    });
    expect(isContinuableStreamFailure(error, true)).toBe(true);
    expect(isContinuableStreamFailure(error, false)).toBe(false);
  });

  it.each([
    { status: 403 },
    { httpStatus: 503 },
    { statusCode: 401 },
    { kind: 'auth' },
    { kind: 'protocol' },
  ])('does not let EOF override an explicit failure: %j', (failure) => {
    const eof = { code: INCOMPLETE_STREAM_CODE };
    expect(isContinuableStreamFailure({ ...eof, cause: failure }, true)).toBe(
      false,
    );
    expect(isContinuableStreamFailure({ ...failure, cause: eof }, true)).toBe(
      false,
    );
  });

  it.each(['server', 'rate_limited'] as const)(
    'continues classified %s failures independently of retryFetchErrors',
    (kind) => {
      const error = new ModelInferenceError('transient', {
        kind,
        phase: 'after_output',
        status: kind === 'server' ? 503 : 429,
      });
      expect(isContinuableStreamFailure(error, true)).toBe(true);
      expect(isContinuableStreamFailure(error, false)).toBe(true);
      expect(
        isContinuableStreamFailure(
          new Error('wrapper', { cause: error }),
          false,
        ),
      ).toBe(true);
      const before = new ModelInferenceError('transient', {
        kind,
        phase: 'before_output',
      });
      expect(isContinuableStreamFailure(before, true)).toBe(false);
    },
  );

  it('follows the Provider classification of an upstream overload wrapped as HTTP 400', () => {
    const toFailure = (responseBody: string) => {
      const cause = new ClientError('failed', {
        statusCode: 400,
        responseBody,
      });
      const detail = classifyClientError(cause);
      return new ModelInferenceError(detail.message ?? cause.message, {
        ...detail,
        phase: 'after_output',
        cause,
      });
    };
    const overloaded = toFailure('{"error":{"code":"overloaded_error"}}');
    expect(overloaded).toMatchObject({ kind: 'server', status: 400 });
    expect(isContinuableStreamFailure(overloaded, true)).toBe(true);
    expect(isContinuableStreamFailure(overloaded, false)).toBe(true);
    expect(describeStreamInterruption(overloaded)).toBe(
      'the upstream service was temporarily unavailable',
    );

    const invalid = toFailure('{"error":{"code":"invalid_request_error"}}');
    expect(invalid.kind).toBe('invalid_request');
    expect(isContinuableStreamFailure(invalid, true)).toBe(false);
  });

  it.each([401, 402, 403, 404, 413])(
    'keeps HTTP %s terminal under a transient classification',
    (status) => {
      const error = new ModelInferenceError('transient', {
        kind: 'server',
        phase: 'after_output',
        status,
      });
      expect(isContinuableStreamFailure(error, true)).toBe(false);
    },
  );

  it.each([
    'auth',
    'quota_exhausted',
    'invalid_request',
    'prompt_too_long',
    'model_not_found',
    'protocol',
    'unknown',
  ] as const)(
    'does not continue terminal %s failures with a socket cause',
    (kind) => {
      const error = new ModelInferenceError('terminal', {
        kind,
        phase: 'after_output',
        cause: { code: 'ECONNRESET' },
      });
      expect(isContinuableStreamFailure(error, true)).toBe(false);
      expect(
        isContinuableStreamFailure(
          new ModelInferenceError('wrapper', {
            kind: 'server',
            phase: 'after_output',
            cause: error,
          }),
          true,
        ),
      ).toBe(false);
    },
  );

  it.each([
    { code: 'CERT_HAS_EXPIRED' },
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    { name: 'AbortError' },
    { statusCode: 401 },
    { providerError: { retryable: false } },
  ])(
    'does not continue a transient wrapper over a terminal cause: %j',
    (cause) => {
      expect(
        isContinuableStreamFailure(
          new ModelInferenceError('transient', {
            kind: 'server',
            phase: 'after_output',
            cause,
          }),
          true,
        ),
      ).toBe(false);
    },
  );

  it('does not continue protocol limits wrapped in a transient failure', () => {
    const cause = new ProtocolLimitError('too large', 'sse_event', 100, 101);
    expect(
      isContinuableStreamFailure(
        new ModelInferenceError('transient', {
          kind: 'server',
          phase: 'after_output',
          cause,
        }),
        true,
      ),
    ).toBe(false);
  });

  it('terminates cycles and rejects unrelated errors', () => {
    const error = Object.assign(new Error('unrelated'), { cause: {} });
    error.cause = error;
    expect(isContinuableStreamFailure(error, true)).toBe(false);
    expect(isContinuableStreamFailure(null, true)).toBe(false);
  });
});

describe('describeStreamInterruption', () => {
  it.each([
    [
      Object.assign(new Error('other side closed https://host/secret?k=v'), {
        code: 'UND_ERR_SOCKET',
      }),
      'the upstream connection was closed',
    ],
    [{ phase: 'stream_idle', code: 'ETIMEDOUT' }, 'the response read timed out'],
    [{ code: 'UND_ERR_BODY_TIMEOUT' }, 'the response read timed out'],
    [
      { code: INCOMPLETE_STREAM_CODE },
      'the response stream ended before completion',
    ],
    [
      new ModelInferenceError('upstream', {
        kind: 'server',
        phase: 'after_output',
      }),
      'the upstream service was temporarily unavailable',
    ],
    [
      new ModelInferenceError('limited', {
        kind: 'rate_limited',
        phase: 'after_output',
      }),
      'the upstream service was temporarily rate limited',
    ],
    [{ status: 503 }, 'the upstream service was temporarily unavailable'],
    [{ status: 429 }, 'the upstream service was temporarily rate limited'],
    [new Error('x'), 'a transient request failure occurred'],
  ])('describes %o without leaking details', (error, expected) => {
    const description = describeStreamInterruption(error);
    expect(description).toBe(expected);
    expect(description).not.toContain('secret');
  });
});
