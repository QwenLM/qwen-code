/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { isStructuredTimeoutError } from './errors.js';

describe('MCP timeout classification', () => {
  it.each([
    { name: 'TimeoutError' },
    { code: ErrorCode.RequestTimeout },
    { code: 'ETIMEDOUT' },
    { code: 'UND_ERR_CONNECT_TIMEOUT' },
    { code: 'UND_ERR_HEADERS_TIMEOUT' },
    { code: 'UND_ERR_BODY_TIMEOUT' },
    { code: 'ERR_MCP_REQUEST_TIMEOUT' },
  ])('recognizes structured timeout %j', (error) => {
    expect(isStructuredTimeoutError(error)).toBe(true);
  });

  it('does not infer a timeout from message text or cancellation', () => {
    expect(
      isStructuredTimeoutError(new Error('timeout in server response')),
    ).toBe(false);
    expect(isStructuredTimeoutError({ code: ErrorCode.ConnectionClosed })).toBe(
      false,
    );
    expect(
      isStructuredTimeoutError(new DOMException('cancelled', 'AbortError')),
    ).toBe(false);
  });

  it('handles cyclic cause chains without hanging', () => {
    const error = new Error('connection failed');
    error.cause = error;
    expect(isStructuredTimeoutError(error)).toBe(false);
  });
});
