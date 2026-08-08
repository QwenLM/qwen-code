/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DashScopeApiError,
  dashScopeErrorFromFrame,
  toDashScopeApiError,
} from './errors.js';
import type { DashScopeSseFrame } from './sse.js';
import { classifyRetryError } from '../../utils/retryErrorClassification.js';
import { getErrorStatus } from '../../utils/errors.js';

const JSON_ENVELOPE_400 = JSON.stringify({
  code: 'InvalidParameter',
  message: '<400> InternalError.Algo.InvalidParameter: bad request',
  request_id: 'req-json-400',
});

const SSE_FRAMED_400_BODY = [
  'id:1',
  'event:error',
  ':HTTP_STATUS/400',
  'data:{"code":"InvalidParameter","message":"<400> InternalError.Algo.InvalidParameter: bad request","request_id":"req-sse-400"}',
  '',
].join('\n');

describe('toDashScopeApiError', () => {
  it('extracts status/code/requestId from a JSON envelope body', () => {
    const error = toDashScopeApiError({
      status: 400,
      rawBody: JSON_ENVELOPE_400,
    });
    expect(error).toBeInstanceOf(DashScopeApiError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('InvalidParameter');
    expect(error.requestId).toBe('req-json-400');
    expect(error.message).toContain('400');
    expect(error.message).toContain('InvalidParameter');
    expect(error.message).toContain(
      '<400> InternalError.Algo.InvalidParameter: bad request',
    );
    expect(error.message).toContain('req-json-400');
  });

  it('extracts the same fields from an SSE-framed 400 raw body', () => {
    const error = toDashScopeApiError({
      status: 400,
      rawBody: SSE_FRAMED_400_BODY,
    });
    expect(error.status).toBe(400);
    expect(error.code).toBe('InvalidParameter');
    expect(error.requestId).toBe('req-sse-400');
    expect(error.message).toContain(
      '<400> InternalError.Algo.InvalidParameter: bad request',
    );
  });

  it('falls back to the X-Request-Id header when request_id is absent from the body', () => {
    const body = JSON.stringify({
      code: 'invalid_request_error',
      message: 'model is not allowed',
    });
    const headers = new Headers({ 'X-Request-Id': 'hdr-123' });
    const error = toDashScopeApiError({ status: 400, rawBody: body, headers });
    expect(error.requestId).toBe('hdr-123');
  });

  it('does not throw on an unparseable body and includes the raw text in the message', () => {
    const error = toDashScopeApiError({
      status: 502,
      rawBody: '<html>gateway timeout</html>',
    });
    expect(error.status).toBe(502);
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('<html>gateway timeout</html>');
  });
});

describe('dashScopeErrorFromFrame', () => {
  it('returns an error for an event:error frame', () => {
    const frame: DashScopeSseFrame = {
      event: 'error',
      httpStatus: 400,
      data: JSON_ENVELOPE_400,
    };
    const error = dashScopeErrorFromFrame(frame);
    expect(error).toBeInstanceOf(DashScopeApiError);
    expect(error?.status).toBe(400);
  });

  it('returns an error for a result frame with httpStatus >= 400', () => {
    const frame: DashScopeSseFrame = {
      event: 'result',
      httpStatus: 429,
      data: JSON.stringify({ code: 'Throttling', message: 'slow down' }),
    };
    const error = dashScopeErrorFromFrame(frame);
    expect(error?.status).toBe(429);
    expect(error?.code).toBe('Throttling');
  });

  it('returns undefined for a normal result frame with httpStatus 200', () => {
    const frame: DashScopeSseFrame = {
      event: 'result',
      httpStatus: 200,
      data: JSON.stringify({ output: { choices: [] } }),
    };
    expect(dashScopeErrorFromFrame(frame)).toBeUndefined();
  });
});

describe('DashScopeApiError classification with repo retry utilities', () => {
  it('getErrorStatus reads the numeric status property', () => {
    expect(
      getErrorStatus(new DashScopeApiError({ message: 'x', status: 429 })),
    ).toBe(429);
  });

  it('classifies a 429 Throttling error as retryable', () => {
    const error = new DashScopeApiError({
      message: 'DashScope API error 429 (Throttling): slow down',
      status: 429,
      code: 'Throttling',
    });
    const classification = classifyRetryError(error);
    expect(classification.diagnosis).toBe('retryable');
  });

  it('classifies a 400 InvalidParameter error as fail-fast', () => {
    const error = new DashScopeApiError({
      message: 'DashScope API error 400 (InvalidParameter): bad request',
      status: 400,
      code: 'InvalidParameter',
    });
    const classification = classifyRetryError(error);
    expect(classification.diagnosis).toBe('fail-fast');
  });

  it('classifies a 500 error as retryable', () => {
    const error = new DashScopeApiError({
      message: 'DashScope API error 500: internal error',
      status: 500,
    });
    const classification = classifyRetryError(error);
    expect(classification.diagnosis).toBe('retryable');
  });
});
