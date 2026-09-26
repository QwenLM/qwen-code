/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getJsonRpcErrorCode } from './jsonrpc-error-code.js';

const BODY =
  '{"jsonrpc":"2.0","error":{"code":-32601,"message":"Unknown method"},"id":1}';

describe('getJsonRpcErrorCode', () => {
  it('reads a structured numeric code without touching any text', () => {
    expect(
      getJsonRpcErrorCode(Object.assign(new Error('x'), { code: -32601 })),
    ).toBe(-32601);
    expect(getJsonRpcErrorCode({ code: -32600 })).toBe(-32600);
    expect(getJsonRpcErrorCode({ code: 1.5 })).toBeUndefined();
    expect(
      getJsonRpcErrorCode({ code: 'CLIENT_HTTP_NOT_IMPLEMENTED' }),
    ).toBeUndefined();
  });

  it('parses the SdkHttpError data.text bag (the real v2 transport shape)', () => {
    const error = Object.assign(new Error('Error POSTing to endpoint'), {
      data: { status: 400, statusText: 'Bad Request', text: BODY },
    });
    expect(getJsonRpcErrorCode(error)).toBe(-32601);
  });

  it('parses a body embedded in the message after prose', () => {
    const error = new Error(`Error POSTing to endpoint: ${BODY}`);
    expect(getJsonRpcErrorCode(error)).toBe(-32601);
  });

  it('reads .error.code (spec location) and tolerates member order / nesting', () => {
    const ordered =
      '{"jsonrpc":"2.0","params":{"nested":{"x":1}},"error":{"code":-32601,"message":"nope"}}';
    expect(
      getJsonRpcErrorCode(new Error(`Error POSTing to endpoint: ${ordered}`)),
    ).toBe(-32601);
    expect(
      getJsonRpcErrorCode(new Error('prefix {"data":{},"code":-32601} suffix')),
    ).toBe(-32601);
  });

  it('returns undefined for non-JSON text, prose phrases, and truncated bodies', () => {
    // phrase with no JSON at all — a code must never be inferred from prose
    expect(
      getJsonRpcErrorCode(
        new Error('upstream said: Method not found for this session'),
      ),
    ).toBeUndefined();
    // truncated mid-number: strict parse fails rather than guessing
    expect(
      getJsonRpcErrorCode(new Error('{"error":{"code":-3260')),
    ).toBeUndefined();
    // wrong code parses fine and is reported as-is (callers compare it)
    expect(
      getJsonRpcErrorCode(
        new Error('{"error":{"code":-32600,"message":"Method not found"}}'),
      ),
    ).toBe(-32600);
    expect(getJsonRpcErrorCode(null)).toBeUndefined();
    expect(getJsonRpcErrorCode(undefined)).toBeUndefined();
    expect(getJsonRpcErrorCode('a bare string')).toBeUndefined();
  });
});
