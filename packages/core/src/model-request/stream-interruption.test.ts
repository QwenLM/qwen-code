/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ModelInferenceError } from '../provider/modelInferenceError.js';
import {
  describeStreamInterruption,
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
